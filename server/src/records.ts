// Employee self-service records: announcements, benefits, trainings, PRC licenses
// (CPD units) and certificate requests. Shapes match src/lib/types.ts.

import { certificateStatement, nextCertificateNumber } from "../../src/lib/certificates";
import type { CertificateRequest, CertificateRequestStatus, Employee } from "../../src/lib/types";
import { audit, demand, seen, type Session } from "./auth";
import { nameOf } from "./corehr";
import { open, seal } from "./crypto";
import { clean, need024, pool, schema024, tx, UserError, type Db } from "./db";
import { tellAssigned, tellEmployees } from "./notify";
import type { NotificationKind } from "../../src/lib/noticeLinks";

/** "2026-10-15" -> "Oct 15, 2026", the way the pages show dates in these lists. */
const label = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const me = (s: Session) => {
  if (!s.employeeNo) throw new UserError("Your sign-in isn't linked to an employee record. Ask HR to link it.");
  return s.employeeNo;
};
const initials = (first: string, last: string) => `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();

// ---- Announcements (everyone reads; HR and Super Admin post) ----

export async function listAnnouncements() {
  const { rows } = await pool.query(
    `select a.*, u.display_name as posted_by_name from announcements a left join user_accounts u on u.id = a.posted_by
      where a.expires_at is null or a.expires_at > now() order by a.posted_at desc limit 50`,
  );
  return rows.map((a) => ({ id: a.id, title: a.title, body: a.body ?? undefined, postedBy: a.posted_by_name ?? undefined, postedOn: `Posted ${label(new Date(a.posted_at).toISOString().slice(0, 10))}` }));
}

export async function postAnnouncement(s: Session, body: any) {
  demand(s, "create", "announcements");
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
    if (t.employee_id !== s.employeeNo) demand(s, "edit", "trainings", t.employee_id);
    await c.query(`update training_records set status = $2, completed_on = case when $2 = 'Completed' then current_date else null end where id = $1`, [t.id, status]);
    const r = (await c.query(`select t.*, e.first_name, e.last_name from training_records t join employees e on e.employee_id = t.employee_id where t.id = $1`, [t.id])).rows[0];
    return trainingJson(r);
  });
}

/** An employee moving their own training forward (started, completed): never back, never someone else's,
 * and a completed one stays completed (as updateMyTrainingStatus does on the website). */
export async function setMyTrainingStatus(s: Session, trainingId: string, status: string) {
  if (status !== "In progress" && status !== "Completed") throw new UserError("Choose a status");
  const employeeNo = me(s);
  return tx(async (c) => {
    const t = (await c.query(`select * from training_records where id::text = $1 and employee_id = $2 for update`, [trainingId, employeeNo])).rows[0];
    if (!t) throw new UserError("That training isn't assigned to you", 404);
    if (t.status !== "Completed" && t.status !== status) {
      await c.query(`update training_records set status = $2, completed_on = case when $2 = 'Completed' then current_date else null end where id = $1`, [t.id, status]);
      await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Updated own training", target: t.course, employeeNo, detail: status });
    }
    const r = (await c.query(`select t.*, e.first_name, e.last_name from training_records t join employees e on e.employee_id = t.employee_id where t.id = $1`, [t.id])).rows[0];
    return trainingJson(r);
  });
}

// ---- PRC licenses and CPD units ----

const licenseJson = (l: any) => ({
  id: l.id, employeeId: l.employee_id, employeeName: `${l.first_name} ${l.last_name}`, employeeInitials: initials(l.first_name, l.last_name),
  licenseType: l.license_type, licenseNumber: open(l.license_number), cpdUnitsEarned: l.cpd_units_earned, cpdUnitsRequired: l.cpd_units_required, cycleEndDate: label(l.cycle_end_date),
});
const LICENSE_SELECT = `select l.*, e.first_name, e.last_name from professional_licenses l join employees e on e.employee_id = l.employee_id`;

export async function myLicense(s: Session) {
  if (!s.employeeNo) return null;
  const r = (await pool.query(`${LICENSE_SELECT} where l.employee_id = $1 order by l.expires_on desc nulls last limit 1`, [s.employeeNo])).rows[0];
  return r ? licenseJson(r) : null;
}

export async function listLicenses(s: Session) {
  const { rows } = await pool.query(`${LICENSE_SELECT} order by e.last_name`);
  return [...new Map([...seen(s, "people", rows, (l) => l.employee_id), ...seen(s, "documents", rows, (l) => l.employee_id)].map((l) => [l.id, l])).values()].map(licenseJson);
}

export async function setCpdUnits(s: Session, licenseId: string, units: unknown) {
  const n = Number(units);
  if (!Number.isFinite(n) || n < 0 || n > 999) throw new UserError("Enter the CPD units earned");
  return tx(async (c) => {
    const l = (await c.query(`select * from professional_licenses where id::text = $1 for update`, [licenseId])).rows[0];
    if (!l) throw new UserError("That license no longer exists", 404);
    if (l.employee_id !== s.employeeNo) demand(s, "edit", "people", l.employee_id);
    await c.query(`update professional_licenses set cpd_units_earned = $2 where id = $1`, [l.id, Math.round(n * 10) / 10]);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Edited", target: "Professional license", employeeNo: l.employee_id, detail: `CPD units: ${l.cpd_units_earned} → ${Math.round(n * 10) / 10}` });
    return licenseJson((await c.query(`${LICENSE_SELECT} where l.id = $1`, [l.id])).rows[0]);
  });
}

// ---- Certificate requests ----
// The employee files a request; HR (self-service manage) issues it as a digital copy, prepares a signed
// copy for pickup and marks it released, or declines it with a reason. Issuing files the copy on the
// request (number, exact wording, purpose, who and when), so it never changes with the record later.

const day = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : undefined);
const at = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

const certJson = (r: any) => clean({
  id: r.id, type: r.certificate_type, purpose: r.purpose, status: r.decline_reason ? "Declined" : r.status, requestedOn: day(r.requested_at),
  employeeId: r.employee_id, handledBy: r.handled_by_name, handledAt: at(r.handled_at), delivery: r.delivery,
  note: r.decline_reason ? open(r.decline_reason) : null,
  issued: r.certificate_no ? { number: r.certificate_no, statement: open(r.issued_statement), purpose: r.issued_purpose, issuedAt: at(r.issued_at), issuedBy: r.issued_by_name } : null,
});

export async function listMyCertificates(s: Session) {
  if (!s.employeeNo) return [];
  return (await pool.query(`select * from certificate_requests where employee_id = $1 order by requested_at desc`, [s.employeeNo])).rows.map(certJson);
}

/** Every request, for HR's queue, with who asked. */
export async function listCertificatesForReview(s: Session) {
  demand(s, "edit", "selfService");
  const { rows } = await pool.query(
    `select r.*, e.first_name, e.middle_name, e.last_name, e.suffix from certificate_requests r join employees e on e.employee_id = r.employee_id order by r.requested_at desc`,
  );
  return rows.map((r) => ({ ...certJson(r), employeeName: nameOf(r), ...(r.released_at ? { releasedOn: day(r.released_at) } : {}) }));
}

/** The employee as the certificate wording reads them: name, ID, status, position, department, cluster, office. */
async function certificateEmployee(c: Db, employeeId: string): Promise<Employee> {
  const e = (await c.query(
    `with recursive up as (select id, name, code, unit_type, parent_id from org_units where id = (select org_unit_id from employees where employee_id = $1)
       union all select u.id, u.name, u.code, u.unit_type, u.parent_id from org_units u join up on u.id = up.parent_id)
     select e.employee_id, e.first_name, e.middle_name, e.last_name, e.suffix, e.record_status, p.title,
            (select name from up where unit_type = 'department' limit 1) as department,
            (select name from up where unit_type = 'branch' limit 1) as office,
            (select code from up where unit_type = 'team' limit 1) as cluster
       from employees e left join positions p on p.id = e.position_id where e.employee_id = $1`,
    [employeeId],
  )).rows[0];
  if (!e) throw new UserError("This request isn't linked to an employee record, so a certificate can't be made. Prepare a signed copy for pickup instead.");
  return {
    id: e.employee_id, name: nameOf(e), initials: "", position: e.title ?? "Unassigned", department: e.department ?? "",
    office: e.office ?? "Cebu HQ", cluster: ["RPM", "VCM", "ADS"].includes(e.cluster) ? e.cluster : "ADS", status: e.record_status === "ACTIVE" ? "Active" : "On leave",
  } as Employee;
}

/** One HR step on a request that's in one of `from`; `set` returns the columns to change, `tell` what the employee is told. */
async function certificateStep(
  s: Session, certId: string, from: CertificateRequestStatus[], action: string, set: (c: Db, r: any) => Promise<Record<string, unknown>>,
  tell: (next: any) => [NotificationKind, string, string],
) {
  demand(s, "edit", "selfService");
  await need024();
  return tx(async (c) => {
    const r = (await c.query(`select * from certificate_requests where id::text = $1 for update`, [certId])).rows[0];
    if (!r) throw new UserError("That request no longer exists", 404);
    const status: CertificateRequestStatus = r.decline_reason ? "Declined" : r.status;
    if (!from.includes(status)) throw new UserError(`This request is already ${status.toLowerCase()}`);
    const cols = { ...(await set(c, r)), handled_by: s.accountId, handled_by_name: s.name, handled_at: new Date() };
    const keys = Object.keys(cols); // fixed column names from this file, never from the request
    const { rows: [next] } = await c.query(
      `update certificate_requests set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1 returning *`,
      [r.id, ...Object.values(cols)],
    );
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action, target: r.certificate_type, employeeNo: r.employee_id, detail: next.certificate_no ? `No. ${next.certificate_no} · ${r.purpose}` : r.purpose });
    const [kind, title, body] = tell(next);
    await tellEmployees(c, s, r.employee_id, "certificate", kind, title, body);
    return { ...certJson(next), employeeName: nameOf((await c.query(`select first_name, middle_name, last_name, suffix from employees where employee_id = $1`, [r.employee_id])).rows[0]) };
  });
}

/** The copy filed on the request when it's first issued (kept if it already has one). */
async function filedCopy(c: Db, s: Session, r: any): Promise<Record<string, unknown>> {
  if (r.certificate_no) return {};
  await c.query(`select pg_advisory_xact_lock(hashtext('certificate-numbers'))`);
  const used = (await c.query(`select certificate_no from certificate_requests where certificate_no is not null`)).rows.map((x) => ({ issued: { number: x.certificate_no } }) as CertificateRequest);
  const employee = await certificateEmployee(c, r.employee_id);
  return {
    certificate_no: nextCertificateNumber(r.certificate_type, used), issued_statement: seal(certificateStatement(employee, r.certificate_type)),
    issued_purpose: r.purpose, issued_at: new Date(), issued_by: s.accountId, issued_by_name: s.name,
  };
}

/** HR sends it as a digital copy: released at once; the employee downloads or prints it. */
export const issueCertificate = (s: Session, certId: string) =>
  certificateStep(s, certId, ["Pending", "Ready for pickup"], "Issued certificate", async (c, r) => ({ ...(await filedCopy(c, s, r)), status: "Released", delivery: "digital", released_at: new Date() }),
    (n) => ["approved", `Your ${n.certificate_type} is ready`, `${s.name} sent it (No. ${n.certificate_no}). Download or print it from Certificates.`]);

/** HR prepares a signed paper copy for the employee to collect. */
export const markCertificateReady = (s: Session, certId: string) =>
  certificateStep(s, certId, ["Pending"], "Certificate ready", async () => ({ status: "Ready for pickup", delivery: "pickup" }),
    (n) => ["approved", `Your ${n.certificate_type} is ready for pickup`, `${s.name} prepared a signed copy. Pick it up from HR.`]);

/** The signed copy was handed over; a copy is filed for HR and the employee's download. */
export const markCertificateReleased = (s: Session, certId: string) =>
  certificateStep(s, certId, ["Ready for pickup"], "Released certificate", async (c, r) => ({ ...(await filedCopy(c, s, r)), status: "Released", released_at: new Date() }),
    (n) => ["update", `You received your ${n.certificate_type}`, `Released by ${s.name}. A digital copy is on your Certificates page too.`]);

/** HR can't issue it; the employee sees why. */
export async function declineCertificate(s: Session, certId: string, reason: unknown) {
  demand(s, "edit", "selfService");
  const why = String(reason ?? "").trim();
  if (!why) throw new UserError("Say why, so the employee knows");
  if (why.length > 500) throw new UserError("Keep the reason under 500 characters");
  return certificateStep(s, certId, ["Pending"], "Declined certificate", async () => ({ decline_reason: seal(why) }),
    (n) => ["rejected", `Your ${n.certificate_type} request was declined`, `${s.name}: “${why}”`]);
}

const CERT_FLOW = ["Pending", "Ready for pickup", "Released"];

/** Older one-step flow: waiting -> ready for pickup -> released. */
export async function setCertificateStatus(s: Session, certId: string, status: string) {
  demand(s, "edit", "selfService");
  if (!CERT_FLOW.includes(status) || status === "Pending") throw new UserError("Choose Ready for pickup or Released");
  if (await schema024()) return status === "Released" ? markCertificateReleased(s, certId) : markCertificateReady(s, certId);
  return tx(async (c) => {
    const r = (await c.query(`select * from certificate_requests where id::text = $1 for update`, [certId])).rows[0];
    if (!r) throw new UserError("That request no longer exists", 404);
    if (CERT_FLOW.indexOf(status) <= CERT_FLOW.indexOf(r.status)) throw new UserError(`This request is already ${r.status.toLowerCase()}`);
    const { rows: [next] } = await c.query(
      `update certificate_requests set status = $2, released_at = case when $2 = 'Released' then now() else released_at end where id = $1 returning *`,
      [r.id, status],
    );
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: status === "Released" ? "Released certificate" : "Certificate ready", target: r.certificate_type, employeeNo: r.employee_id, detail: r.purpose });
    return certJson(next);
  });
}

export async function requestCertificate(s: Session, body: any) {
  const id = me(s);
  const type = String(body?.type ?? "").trim(), purpose = String(body?.purpose ?? "").trim();
  if (!type) throw new UserError("Choose the certificate");
  if (!purpose) throw new UserError("Say what it's for, e.g. bank loan application");
  if (type.length > 100 || purpose.length > 300) throw new UserError("Keep the purpose under 300 characters");
  return tx(async (c) => {
    const { rows: [r] } = await c.query(`insert into certificate_requests (employee_id, certificate_type, purpose) values ($1,$2,$3) returning *`, [id, type, purpose]);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Requested certificate", target: type, employeeNo: id, detail: purpose });
    const name = nameOf((await c.query(`select first_name, middle_name, last_name, suffix from employees where employee_id = $1`, [id])).rows[0] ?? { first_name: s.name, last_name: "" });
    await tellAssigned(c, s, "edit", "selfService", "certificate", "request", `${name} requested a ${type}`, `For: ${purpose}. Prepare it and mark it ready for pickup under Requests › Certificates.`);
    return certJson(r);
  });
}

export async function cancelCertificate(s: Session, certId: string) {
  const declined = (await schema024()) ? "and decline_reason is null" : "";
  const { rowCount } = await pool.query(`delete from certificate_requests where id::text = $1 and employee_id = $2 and status = 'Pending' ${declined}`, [certId, me(s)]);
  if (!rowCount) throw new UserError("Only a pending request can be cancelled");
}
