// Employee self-service records: announcements, benefits, trainings, PRC licenses
// (CPD units) and certificate requests. Shapes match src/lib/types.ts.

import { audit, can, demand, type Session } from "./auth";
import { clean, pool, tx, UserError } from "./db";

/** "2026-10-15" -> "Oct 15, 2026", the way the pages show dates in these lists. */
const label = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const me = (s: Session) => {
  if (!s.employeeNo) throw new UserError("Your sign-in isn't linked to an employee record. Ask HR to link it.");
  return s.employeeNo;
};
const initials = (first: string, last: string) => `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();

// ---- Announcements (everyone reads; People edit posts) ----

export async function listAnnouncements() {
  const { rows } = await pool.query(`select * from announcements where expires_at is null or expires_at > now() order by posted_at desc limit 50`);
  return rows.map((a) => ({ id: a.id, title: a.title, postedOn: `Posted ${label(new Date(a.posted_at).toISOString().slice(0, 10))}` }));
}

export async function postAnnouncement(s: Session, body: any) {
  demand(s, "people", "edit");
  const title = String(body?.title ?? "").trim();
  if (!title) throw new UserError("Write the announcement");
  if (title.length > 200) throw new UserError("Keep it under 200 characters");
  const { rows: [a] } = await pool.query(`insert into announcements (title, posted_by) values ($1, $2) returning *`, [title, s.accountId]);
  await audit(pool, { actorId: s.accountId, actorName: s.name, module: "People", action: "Posted announcement", target: "Announcements", detail: title });
  return { id: a.id, title: a.title, postedOn: `Posted ${label(new Date(a.posted_at).toISOString().slice(0, 10))}` };
}

// ---- Benefits (the employee's own) ----

const benefitJson = (b: any) => clean({ id: b.id, name: b.benefit_name, provider: b.provider, memberId: b.member_no ?? "", status: b.status });

export async function listMyBenefits(s: Session) {
  if (!s.employeeNo) return [];
  const { rows } = await pool.query(`select * from employee_benefits where employee_id = $1 order by benefit_name`, [s.employeeNo]);
  return rows.map(benefitJson);
}

export async function addBenefit(s: Session, body: any) {
  const id = me(s);
  const name = String(body?.name ?? "").trim(), provider = String(body?.provider ?? "").trim(), memberId = String(body?.memberId ?? "").trim();
  if (!name) throw new UserError("Name the benefit, e.g. HMO");
  if (!provider) throw new UserError("Enter the provider");
  const { rows: [b] } = await pool.query(
    `insert into employee_benefits (employee_id, benefit_name, provider, member_no, status) values ($1,$2,$3,$4,'Pending') returning *`,
    [id, name, provider, memberId || null],
  );
  return benefitJson(b);
}

export async function confirmBenefit(s: Session, benefitId: string) {
  const { rows: [b] } = await pool.query(`update employee_benefits set status = 'Active' where id::text = $1 and employee_id = $2 returning *`, [benefitId, me(s)]);
  if (!b) throw new UserError("That benefit no longer exists", 404);
  return benefitJson(b);
}

export async function removeBenefit(s: Session, benefitId: string) {
  const { rowCount } = await pool.query(`delete from employee_benefits where id::text = $1 and employee_id = $2`, [benefitId, me(s)]);
  if (!rowCount) throw new UserError("That benefit no longer exists", 404);
}

// ---- Trainings (the employee's own) ----

const trainingJson = (t: any) => ({ id: t.id, employeeName: `${t.first_name} ${t.last_name}`, employeeInitials: initials(t.first_name, t.last_name), course: t.course, dueDate: label(t.due_date), status: t.status });

export async function listMyTrainings(s: Session) {
  if (!s.employeeNo) return [];
  const { rows } = await pool.query(
    `select t.*, e.first_name, e.last_name from training_records t join employees e on e.employee_id = t.employee_id where t.employee_id = $1 order by t.due_date nulls last`,
    [s.employeeNo],
  );
  return rows.map(trainingJson);
}

export async function setTrainingStatus(s: Session, trainingId: string, status: string) {
  if (!["Not started", "In progress", "Completed"].includes(status)) throw new UserError("Choose a status");
  return tx(async (c) => {
    const t = (await c.query(`select * from training_records where id::text = $1 for update`, [trainingId])).rows[0];
    if (!t) throw new UserError("That training no longer exists", 404);
    if (t.employee_id !== s.employeeNo) demand(s, "people", "edit");
    await c.query(`update training_records set status = $2, completed_on = case when $2 = 'Completed' then current_date else null end where id = $1`, [t.id, status]);
    const r = (await c.query(`select t.*, e.first_name, e.last_name from training_records t join employees e on e.employee_id = t.employee_id where t.id = $1`, [t.id])).rows[0];
    return trainingJson(r);
  });
}

// ---- PRC licenses and CPD units ----

const licenseJson = (l: any) => ({
  id: l.id, employeeId: l.employee_id, employeeName: `${l.first_name} ${l.last_name}`, employeeInitials: initials(l.first_name, l.last_name),
  licenseType: l.license_type, licenseNumber: l.license_number, cpdUnitsEarned: l.cpd_units_earned, cpdUnitsRequired: l.cpd_units_required, cycleEndDate: label(l.cycle_end_date),
});
const LICENSE_SELECT = `select l.*, e.first_name, e.last_name from professional_licenses l join employees e on e.employee_id = l.employee_id`;

export async function myLicense(s: Session) {
  if (!s.employeeNo) return null;
  const r = (await pool.query(`${LICENSE_SELECT} where l.employee_id = $1 order by l.expires_on desc nulls last limit 1`, [s.employeeNo])).rows[0];
  return r ? licenseJson(r) : null;
}

export async function listLicenses(s: Session) {
  if (!(can(s, "people", "view") || can(s, "documents", "view"))) return [];
  return (await pool.query(`${LICENSE_SELECT} order by e.last_name`)).rows.map(licenseJson);
}

export async function setCpdUnits(s: Session, licenseId: string, units: unknown) {
  const n = Number(units);
  if (!Number.isFinite(n) || n < 0 || n > 999) throw new UserError("Enter the CPD units earned");
  return tx(async (c) => {
    const l = (await c.query(`select * from professional_licenses where id::text = $1 for update`, [licenseId])).rows[0];
    if (!l) throw new UserError("That license no longer exists", 404);
    if (l.employee_id !== s.employeeNo) demand(s, "people", "edit");
    await c.query(`update professional_licenses set cpd_units_earned = $2 where id = $1`, [l.id, Math.round(n * 10) / 10]);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Edited", target: "Professional license", employeeNo: l.employee_id, detail: `CPD units: ${l.cpd_units_earned} → ${Math.round(n * 10) / 10}` });
    return licenseJson((await c.query(`${LICENSE_SELECT} where l.id = $1`, [l.id])).rows[0]);
  });
}

// ---- Certificate requests ----

const certJson = (r: any) => ({ id: r.id, type: r.certificate_type, purpose: r.purpose, status: r.status, requestedOn: new Date(r.requested_at).toISOString().slice(0, 10) });

export async function listMyCertificates(s: Session) {
  if (!s.employeeNo) return [];
  return (await pool.query(`select * from certificate_requests where employee_id = $1 order by requested_at desc`, [s.employeeNo])).rows.map(certJson);
}

/** Every request, for HR's queue. */
export async function listCertificatesForReview(s: Session) {
  if (!can(s, "people", "view")) return [];
  return (await pool.query(`select * from certificate_requests order by requested_at desc`)).rows.map(certJson);
}

export async function requestCertificate(s: Session, body: any) {
  const id = me(s);
  const type = String(body?.type ?? "").trim(), purpose = String(body?.purpose ?? "").trim();
  if (!type) throw new UserError("Choose the certificate");
  if (!purpose) throw new UserError("Say what it's for, e.g. bank loan application");
  const { rows: [r] } = await pool.query(`insert into certificate_requests (employee_id, certificate_type, purpose) values ($1,$2,$3) returning *`, [id, type, purpose]);
  await audit(pool, { actorId: s.accountId, actorName: s.name, module: "People", action: "Requested certificate", target: type, employeeNo: id, detail: purpose });
  return certJson(r);
}

export async function cancelCertificate(s: Session, certId: string) {
  const { rowCount } = await pool.query(`delete from certificate_requests where id::text = $1 and employee_id = $2 and status = 'Pending'`, [certId, me(s)]);
  if (!rowCount) throw new UserError("Only a pending request can be cancelled");
}

