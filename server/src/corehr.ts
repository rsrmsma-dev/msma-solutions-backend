// Core HR / 201 File: the employee master record, org structure, positions,
// documents, employment history and the record's audit trail. Ported from
// src/lib/corehr/api.ts; responses keep that file's shapes so the frontend
// store can use them as-is. The employees table follows the BRD New Employees
// Template, so values are translated between the app's labels and the stored
// codes (Male <-> M, Regular <-> REGULAR, ...).

import type pg from "pg";
import { contactSchema, governmentSchema, newEmployeeSchema, personalSchema } from "../../src/lib/corehr/schemas.js";
import { audit, can, demand, scopeOf, seen, seenIds, type Session } from "./auth.js";
import { createHash } from "node:crypto";
import { fingerprint, open, seal, sealBytes } from "./crypto.js";
import { clean, pool, tx, UserError, type Db } from "./db.js";

const DOCUMENT_TYPES = [
  "Application Form / Resume",
  "Birth Certificate (PSA)",
  "Marriage Certificate (PSA)",
  "Child's Birth Certificate",
  "Valid Government ID",
  "Diploma / Transcript of Records",
  "Professional License",
  "Certificate of Employment (Previous)",
  "NBI Clearance",
  "Police/Barangay Clearance",
  "Pre-Employment Medical Result",
] as const;
const SITUATIONAL = ["Marriage Certificate (PSA)", "Child's Birth Certificate", "Professional License"];
const EXPIRING = ["Valid Government ID", "Professional License", "NBI Clearance", "Police/Barangay Clearance"];

const peso = (n?: number) => (n ? `₱${n.toLocaleString("en-PH")}` : "—");
const today = () => new Date().toISOString().slice(0, 10);
const firstIssue = (r: { error: { issues: { message: string }[] } }) => r.error.issues[0]?.message ?? "Check the form";

// ---- App labels <-> stored codes ----

const SEX = { Male: "M", Female: "F" } as const;
const CIVIL = { Single: "SINGLE", Married: "MARRIED", Widowed: "WIDOWED", Separated: "SEPARATED" } as const;
const EMPLOYMENT = { Probationary: "PROBATIONARY", Regular: "REGULAR", "Fixed-term": "FIXED_TERM" } as const;
const RECORD = { Active: "ACTIVE", "On leave": "ON_LEAVE", Suspended: "SUSPENDED", Separated: "SEPARATED" } as const;
const invert = <T extends Record<string, string>>(m: T) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k])) as Record<string, keyof T>;
const FROM = { sex: invert(SEX), civil: invert(CIVIL), employment: invert(EMPLOYMENT), record: invert(RECORD) };

/** 0917 123 4567, +63 917…, 63917… -> 09171234567 (the 11-digit format the template requires). */
export function toMobileNo(s: string) {
  const d = s.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("63")) return `0${d.slice(2)}`;
  if (d.length === 10 && d.startsWith("9")) return `0${d}`;
  return d;
}

// ---- Reading the whole Core HR state (what the frontend store holds) ----

function employeeJson(r: any) {
  return clean({
    id: r.employee_id,
    personal: {
      firstName: r.first_name, middleName: r.middle_name ?? "", lastName: r.last_name, suffix: r.suffix ?? "", birthDate: r.birth_date ?? "",
      sex: FROM.sex[r.sex] ?? "", civilStatus: FROM.civil[r.civil_status] ?? "", nationality: r.nationality,
    },
    contact: {
      workEmail: r.email ?? "", personalEmail: r.personal_email ?? "", mobile: r.mobile_no ?? "", address: r.address_line ?? "", city: r.city ?? "", province: r.province ?? "",
      emergencyName: r.emergency_name ?? "", emergencyRelationship: r.emergency_relationship ?? "", emergencyPhone: r.emergency_phone ?? "",
    },
    government: { sss: open(r.sss_no), philhealth: open(r.philhealth_no), pagibig: open(r.pagibig_no), tin: open(r.tin) },
    job: {
      positionId: r.position_id ?? "", unitId: r.org_unit_id ?? "", supervisorId: r.supervisor_id, employmentType: FROM.employment[r.employment_status], status: FROM.record[r.record_status],
      dateHired: r.date_hired, regularizationDate: r.regularization_date, separationDate: r.separation_date, monthlySalary: r.basic_rate, workSchedule: r.work_schedule ?? "",
    },
    createdAt: r.created_at,
    faceEnrolled: r.face_enrolled,
  });
}

const employeeRow = async (db: Db, id: string) => (await db.query(`select * from employees where employee_id = $1`, [id])).rows[0];

export async function loadState(s: Session) {
  // Full records for everyone, an approver's team, or only yourself (the access matrix's People row).
  const scope = seenIds(s, "people");
  const me = s.employeeNo ?? "";
  const fullIds = scope === "all" ? [] : [...new Set([...scope, me])];
  const full = scope === "all";
  const isFull = (id: string) => full || fullIds.includes(id);
  // Payroll works out pay from salary, so whoever runs payroll sees salaries.
  const pay = can(s, "view", "payrollRuns") && scopeOf(s, "view", "payrollRuns") === "all";
  const [units, positions, employees, documents, events, auditRows] = await Promise.all([
    pool.query(`select id, unit_type as type, name, code, parent_id as "parentId", head_employee_id as "headEmployeeId", address, is_active as active from org_units order by unit_type, name`),
    pool.query(`select id, title, code, department_id as "departmentId", job_level as level, default_employment_type as "employmentType", budgeted_slots as slots,
                       reports_to_position_id as "reportsToPositionId", description, is_active as active from positions order by title`),
    pool.query(`select * from employees order by last_name, first_name`),
    pool.query(`select id, employee_id as "employeeId", document_type as type, status, file_name as "fileName", to_char(submitted_at, 'YYYY-MM-DD') as "uploadedAt", id_type as "idType", (file_id is not null) as "hasFile",
                       verified_by_name as "verifiedBy", verified_at as "verifiedAt", reference_no as "referenceNo", expires_on as "expiresOn", note
                  from employee_documents where $1 or employee_id = any($2)`, [full, fullIds]),
    pool.query(`select id, employee_id as "employeeId", event_kind as kind, effective_date as "effectiveDate", changes, remarks, recorded_by_name as "recordedBy", recorded_at as "recordedAt"
                  from job_events where $1 or employee_id = any($2)`, [full, fullIds]),
    pool.query(`select id::text, employee_id as "employeeId", actor_name as actor, action, target as section, coalesce(detail, '') as summary, occurred_at as at
                  from audit_log where module = 'People' and employee_id is not null and ($1 or employee_id = any($2)) order by occurred_at desc limit 5000`, [full, scope === "all" ? [] : scope]),
  ]);
  // Roles with no People access at all (System Admin: our team) see no client employees.
  const noPeople = scopeOf(s, "view", "people") === null && !me;
  const emps = (noPeople ? [] : employees.rows).map((r) => {
    const e = employeeJson(r);
    // Without People access, other people's records show only what a directory would.
    if (isFull(e.id)) return e;
    return {
      ...e,
      personal: { ...e.personal, birthDate: "", sex: "", civilStatus: "" },
      contact: { ...e.contact, personalEmail: "", address: "", city: "", province: "", emergencyName: "", emergencyRelationship: "", emergencyPhone: "" },
      government: { sss: "", philhealth: "", pagibig: "", tin: "" },
      job: { ...e.job, monthlySalary: pay ? e.job.monthlySalary : 0 },
    };
  });
  const posJson = positions.rows.map((p) => ({ ...p, employmentType: FROM.employment[p.employmentType] }));
  return { units: clean(units.rows), positions: clean(posJson), employees: emps, documents: clean(documents.rows.map((d) => ({ ...d, referenceNo: d.referenceNo && open(d.referenceNo), fileName: d.fileName && open(d.fileName) }))), events: clean(events.rows), audit: clean(auditRows.rows) };
}

// ---- Helpers ----

async function employeeOf(db: Db, id: string) {
  const r = await employeeRow(db, id);
  if (!r) throw new UserError("That employee no longer exists", 404);
  return r;
}

const nameOf = (r: { first_name: string; middle_name?: string | null; last_name: string; suffix?: string | null }) =>
  [r.first_name, r.middle_name?.trim() ? `${r.middle_name.trim()[0]!.toUpperCase()}.` : "", r.last_name, r.suffix ?? ""].map((x) => x.trim()).filter(Boolean).join(" ");

async function unitPath(db: Db, unitId: string) {
  const { rows } = await db.query(
    `with recursive up as (select id, name, unit_type, parent_id, 0 as depth from org_units where id = $1
       union all select u.id, u.name, u.unit_type, u.parent_id, up.depth + 1 from org_units u join up on u.id = up.parent_id)
     select name from up where unit_type <> 'company' order by depth desc`,
    [unitId],
  );
  return rows.map((r) => r.name).join(" › ");
}

/** Next MSMA-00000 number. Taken inside the hire's transaction, so a rejected hire never uses one up. */
async function nextEmployeeId(c: pg.PoolClient) {
  await c.query(`lock table employees in share row exclusive mode`);
  const { rows } = await c.query(`select coalesce(max(substring(employee_id from '^MSMA-([0-9]+)$')::int), 0) + 1 as n from employees`);
  return `MSMA-${String(rows[0].n).padStart(5, "0")}`;
}

async function insertDocuments(c: pg.PoolClient, employeeId: string, married: boolean, govId?: { idType?: string; idNumber?: string; idExpiry?: string; fileName?: string }) {
  for (const type of DOCUMENT_TYPES) {
    const na = SITUATIONAL.includes(type) && !(married && type === "Marriage Certificate (PSA)");
    const gov = type === "Valid Government ID" && govId;
    await c.query(
      `insert into employee_documents (employee_id, document_type, status, file_name, submitted_at, id_type, reference_no, expires_on) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [employeeId, type, gov ? "Submitted" : na ? "Not applicable" : "Missing", gov ? seal(govId.fileName) : null, gov ? new Date() : null, gov ? govId.idType ?? null : null, gov ? seal(govId.idNumber) : null, gov ? govId.idExpiry || null : null],
    );
  }
}

// ---- Employees ----

export async function createEmployee(s: Session, values: unknown) {
  demand(s, "create", "people");
  const parsed = newEmployeeSchema.safeParse(values);
  if (!parsed.success) throw new UserError(firstIssue(parsed));
  const v = parsed.data;
  return tx(async (c) => {
    const { rows: [position] } = await c.query(`select * from positions where id::text = $1`, [v.job.positionId]);
    if (!position?.is_active) throw new UserError("That position isn't available");
    const { rows: [{ n: filled }] } = await c.query(`select count(*)::int as n from employees where position_id = $1 and record_status <> 'SEPARATED'`, [position.id]);
    if (filled >= position.budgeted_slots) throw new UserError(`${position.title} has no opening. Open the job on the Company page and add room for one more person first.`);

    // The cluster (RPM / VCM / ADS) is a team inside the position's department; add it if that department has none yet.
    let { rows: [team] } = await c.query(`select id from org_units where unit_type = 'team' and parent_id = $1 and code = $2`, [position.department_id, v.job.cluster]);
    if (!team) ({ rows: [team] } = await c.query(`insert into org_units (unit_type, name, code, parent_id) values ('team', $1, $1, $2) returning id`, [v.job.cluster, position.department_id]));

    let supervisorId: string | null = null;
    if (v.job.supervisorId) supervisorId = (await employeeOf(c, v.job.supervisorId)).employee_id;
    else if (position.reports_to_position_id) {
      const { rows } = await c.query(`select employee_id from employees where position_id = $1 and record_status <> 'SEPARATED' order by date_hired limit 1`, [position.reports_to_position_id]);
      supervisorId = rows[0]?.employee_id ?? null;
    }

    const p = v.personal, ct = v.contact, g = v.government;
    const { rows: [e] } = await c.query(
      `insert into employees (employee_id, first_name, middle_name, last_name, suffix, birth_date, sex, civil_status, nationality,
         email, personal_email, mobile_no, address_line, city, province, emergency_name, emergency_relationship, emergency_phone,
         sss_no, philhealth_no, pagibig_no, tin, position_id, org_unit_id, supervisor_id, employment_status, date_hired, basic_rate, work_schedule,
         sss_no_hash, philhealth_no_hash, pagibig_no_hash, tin_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33) returning employee_id`,
      [await nextEmployeeId(c), p.firstName, p.middleName || null, p.lastName, p.suffix || null, p.birthDate, SEX[p.sex as keyof typeof SEX], CIVIL[p.civilStatus as keyof typeof CIVIL], p.nationality || "Filipino",
        ct.workEmail, ct.personalEmail, toMobileNo(ct.mobile), ct.address, ct.city, ct.province, ct.emergencyName, ct.emergencyRelationship, ct.emergencyPhone,
        seal(g.sss), seal(g.philhealth), seal(g.pagibig), seal(g.tin), position.id, team.id, supervisorId, EMPLOYMENT[v.job.employmentType as keyof typeof EMPLOYMENT], v.job.dateHired, v.job.monthlySalary, v.job.workSchedule,
        fingerprint(g.sss), fingerprint(g.philhealth), fingerprint(g.pagibig), fingerprint(g.tin)],
    );
    const id = e.employee_id as string;
    // Every checklist item starts Missing (or Not applicable); an ID scanned to fill the form is not kept.
    await insertDocuments(c, id, p.civilStatus === "Married");
    await c.query(`insert into job_events (employee_id, event_kind, effective_date, changes, recorded_by, recorded_by_name) values ($1, 'Hired', $2, $3, $4, $5)`, [
      id, v.job.dateHired,
      JSON.stringify([
        { label: "Position", to: `${position.title} · ${await unitPath(c, team.id)}` },
        { label: "Employment type", to: v.job.employmentType },
        { label: "Monthly salary", to: peso(v.job.monthlySalary) },
      ]),
      s.accountId, s.name,
    ]);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Created", target: "201 file", employeeNo: id, detail: "Created the employee record" });
    return employeeJson(await employeeRow(c, id));
  });
}

type Section = "personal" | "contact" | "government";
const SECTIONS: Record<Section, { title: string; schema: typeof personalSchema | typeof contactSchema | typeof governmentSchema; cols: Record<string, string>; labels: Record<string, string> }> = {
  personal: {
    title: "Personal information", schema: personalSchema,
    cols: { firstName: "first_name", middleName: "middle_name", lastName: "last_name", suffix: "suffix", birthDate: "birth_date", sex: "sex", civilStatus: "civil_status", nationality: "nationality" },
    labels: { firstName: "First name", middleName: "Middle name", lastName: "Last name", suffix: "Suffix", birthDate: "Birth date", sex: "Sex", civilStatus: "Civil status", nationality: "Nationality" },
  },
  contact: {
    title: "Contact details", schema: contactSchema,
    cols: { workEmail: "email", personalEmail: "personal_email", mobile: "mobile_no", address: "address_line", city: "city", province: "province", emergencyName: "emergency_name", emergencyRelationship: "emergency_relationship", emergencyPhone: "emergency_phone" },
    labels: { workEmail: "Work email", personalEmail: "Personal email", mobile: "Mobile", address: "Address", city: "City", province: "Province", emergencyName: "Emergency contact", emergencyRelationship: "Relationship", emergencyPhone: "Emergency phone" },
  },
  government: {
    title: "Government numbers", schema: governmentSchema,
    cols: { sss: "sss_no", philhealth: "philhealth_no", pagibig: "pagibig_no", tin: "tin" },
    labels: { sss: "SSS", philhealth: "PhilHealth", pagibig: "Pag-IBIG", tin: "TIN" },
  },
};

/** App value -> stored value for one field. */
function toDb(field: string, v: string): string | null {
  if (!v) return null;
  if (field === "sex") return SEX[v as keyof typeof SEX];
  if (field === "civilStatus") return CIVIL[v as keyof typeof CIVIL];
  if (field === "mobile") return toMobileNo(v);
  return v;
}

export async function updateSection(s: Session, id: string, section: string, values: unknown) {
  // Employees keep their own contact details up to date (not their work email, which HR assigns).
  const selfContact = section === "contact" && !!s.employeeNo && s.employeeNo === id;
  if (!selfContact) demand(s, "edit", "people", id);
  const def = SECTIONS[section as Section];
  if (!def) throw new UserError("Unknown section");
  const parsed = def.schema.safeParse(values);
  if (!parsed.success) throw new UserError(firstIssue(parsed));
  const after = parsed.data as Record<string, string>;
  return tx(async (c) => {
    const row = (await c.query(`select * from employees where employee_id = $1 for update`, [id])).rows[0];
    if (!row) throw new UserError("That employee no longer exists", 404);
    const before = (employeeJson(row) as any)[section] as Record<string, string>;
    if (selfContact && !can(s, "edit", "people", id) && (after.workEmail ?? "") !== (before.workEmail ?? "")) throw new UserError("Ask HR to change your work email");
    const changed = Object.keys(def.labels).filter((k) => (before[k] ?? "") !== (after[k] ?? ""));
    if (changed.length) {
      // Government numbers are stored encrypted, each with its fingerprint (see crypto.ts).
      const pairs = changed.flatMap((k): [string, string | null][] =>
        section === "government" ? [[def.cols[k]!, seal(after[k])], [`${def.cols[k]}_hash`, fingerprint(after[k])]] : [[def.cols[k]!, toDb(k, after[k] ?? "")]]);
      const sets = pairs.map(([col], i) => `${col} = $${i + 2}`).join(", ");
      await c.query(`update employees set ${sets}, updated_at = now() where employee_id = $1`, [id, ...pairs.map(([, v]) => v)]);
      // Sensitive values are named in the trail, never written into it.
      const summary = section === "government" ? `Changed ${changed.map((k) => def.labels[k]).join(", ")}` : changed.map((k) => `${def.labels[k]}: ${before[k] || "—"} → ${after[k] || "—"}`).join("; ");
      await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Edited", target: def.title, employeeNo: id, detail: summary });
    }
    return employeeJson(await employeeRow(c, id));
  });
}

export async function logGovernmentReveal(s: Session, id: string) {
  demand(s, "view", "people", id);
  await employeeOf(pool, id);
  await audit(pool, { actorId: s.accountId, actorName: s.name, module: "People", action: "Viewed", target: "Government numbers", employeeNo: id, detail: "Revealed full numbers" });
}

/** The signed-in employee enrolled their face for clock-in from home. */
export async function enrollOwnFace(s: Session) {
  if (!s.employeeNo) throw new UserError("Your sign-in isn't linked to an employee record. Ask HR to link it.");
  await pool.query(`update employees set face_enrolled = true, updated_at = now() where employee_id = $1`, [s.employeeNo]);
  await audit(pool, { actorId: s.accountId, actorName: s.name, module: "People", action: "Edited", target: "Face ID", employeeNo: s.employeeNo, detail: "Enrolled Face ID for clock-in from home" });
}

// ---- 201 profile: dependents and photo ----

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/** Stores an uploaded data URL in files and returns its id. */
export async function storeFile(c: Db, s: Session, dataUrl: unknown, fileName: string, allowed: RegExp, maxBytes: number) {
  const m = DATA_URL.exec(String(dataUrl ?? ""));
  if (!m || !allowed.test(m[1]!)) throw new UserError("That kind of file can't be uploaded here");
  const bytes = Buffer.from(m[2]!, "base64");
  if (!bytes.length) throw new UserError("That file is empty");
  if (bytes.length > maxBytes) throw new UserError(`That file is over ${Math.round(maxBytes / 1024 / 1024)} MB. Try a smaller one.`);
  const { rows: [f] } = await c.query(
    `insert into files (storage_key, file_name, content_type, size_bytes, sha256, uploaded_by, content) values ('db:' || gen_random_uuid(), $1, $2, $3, $4, $5, $6) returning id`,
    [seal(fileName.slice(0, 200) || "file"), m[1], bytes.length, createHash("sha256").update(bytes).digest("hex"), s.accountId, sealBytes(bytes)],
  );
  return f.id as string;
}

async function profileJson(db: Db, r: any) {
  const deps = (await db.query(`select id, full_name, relationship, birth_date from dependents where employee_id = $1 order by relationship desc, birth_date`, [r.employee_id])).rows;
  return clean({
    employeeId: r.employee_id,
    birthDate: r.birth_date,
    civilStatus: FROM.civil[r.civil_status],
    photoDataUrl: r.photo_file_id ? `/api/files/${r.photo_file_id}` : undefined,
    dependents: deps.map((d) => clean({ id: d.id, name: d.full_name, relationship: d.relationship, birthDate: d.birth_date })),
  });
}

/** One person's profile: anyone with People access, or the person themself. */
export async function getProfile(s: Session, id: string) {
  if (!(s.employeeNo === id || can(s, "view", "people", id) || can(s, "view", "documents", id))) throw new UserError("You don't have access to do that.", 403);
  const r = (await pool.query(`select employee_id, birth_date, civil_status, photo_file_id from employees where employee_id = $1`, [id])).rows[0];
  return r ? profileJson(pool, r) : null;
}

export async function listProfiles(s: Session) {
  demand(s, "view", "people");
  const { rows } = await pool.query(`select employee_id, birth_date, civil_status, photo_file_id from employees order by employee_id`);
  return Promise.all(seen(s, "people", rows, (r) => r.employee_id).map((r) => profileJson(pool, r)));
}

/** Birth date, civil status and dependents (HR); the photo (HR or the person themself). */
export async function updateProfile(s: Session, id: string, body: any) {
  const self = s.employeeNo === id;
  const onlyPhoto = Object.keys(body ?? {}).every((k) => k === "photoDataUrl");
  if (!(self && onlyPhoto)) demand(s, "edit", "people", id);
  return tx(async (c) => {
    const e = await employeeOf(c, id);
    if (body?.photoDataUrl !== undefined) {
      const fileId = await storeFile(c, s, body.photoDataUrl, "photo", /^image\/(jpeg|png|webp)$/, 3 * 1024 * 1024);
      await c.query(`update employees set photo_file_id = $2, updated_at = now() where employee_id = $1`, [id, fileId]);
    }
    if (body?.birthDate !== undefined || body?.civilStatus !== undefined) {
      const birth = body.birthDate ?? e.birth_date;
      const civil = body.civilStatus ? CIVIL[body.civilStatus as keyof typeof CIVIL] : e.civil_status;
      if (!civil) throw new UserError("Choose the civil status");
      await c.query(`update employees set birth_date = $2, civil_status = $3, updated_at = now() where employee_id = $1`, [id, birth, civil]);
    }
    if (Array.isArray(body?.dependents)) {
      await c.query(`delete from dependents where employee_id = $1`, [id]);
      for (const d of body.dependents) {
        const name = String(d?.name ?? "").trim();
        if (!name) throw new UserError("Each dependent needs a name");
        if (d.relationship !== "Spouse" && d.relationship !== "Child") throw new UserError("A dependent is a spouse or a child");
        await c.query(`insert into dependents (employee_id, full_name, relationship, birth_date) values ($1,$2,$3,$4)`, [id, name, d.relationship, d.birthDate || null]);
      }
    }
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Edited", target: "Personal profile", employeeNo: id, detail: Object.keys(body ?? {}).join(", ") });
    return profileJson(c, (await c.query(`select employee_id, birth_date, civil_status, photo_file_id from employees where employee_id = $1`, [id])).rows[0]);
  });
}

/** Attaches the actual file to a 201 document (the person themself, or Documents edit). */
export async function attachDocumentFile(s: Session, id: string, body: any) {
  return tx(async (c) => {
    const d = (await c.query(`select * from employee_documents where id::text = $1 for update`, [id])).rows[0];
    if (!d) throw new UserError("That document no longer exists", 404);
    if (!(s.employeeNo && d.employee_id === s.employeeNo)) demand(s, "edit", "documents", d.employee_id);
    const fileId = await storeFile(c, s, body?.dataUrl, String(body?.fileName ?? "document"), /^(image\/(jpeg|png|webp)|application\/pdf)$/, 10 * 1024 * 1024);
    await c.query(`update employee_documents set file_id = $2, file_name = $3 where id = $1`, [d.id, fileId, seal(String(body?.fileName ?? "document").slice(0, 200))]);
  });
}

/** Records that someone opened a person's 201 File (or part of it). */
export async function logView(s: Session, id: string, target: string) {
  if (!(can(s, "view", "people", id) || can(s, "view", "documents", id))) throw new UserError("You don't have access to do that.", 403);
  await employeeOf(pool, id);
  await audit(pool, { actorId: s.accountId, actorName: s.name, module: "People", action: "Viewed", target: target || "201 File", employeeNo: id });
}

// ---- Organization chart ----

export async function setCompanyHead(s: Session, id: string) {
  demand(s, "edit", "orgChart");
  return tx(async (c) => {
    const e = await employeeOf(c, id);
    if (e.record_status === "SEPARATED") throw new UserError("Choose a current employee");
    const { rows: [company] } = await c.query(`select u.id, h.first_name, h.middle_name, h.last_name, h.suffix from org_units u left join employees h on h.employee_id = u.head_employee_id where u.unit_type = 'company' limit 1`);
    if (!company) throw new UserError("The company record is missing");
    await c.query(`update org_units set head_employee_id = $2 where id = $1`, [company.id, id]);
    // The head reports to no one.
    await c.query(`update employees set supervisor_id = null, updated_at = now() where employee_id = $1`, [id]);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Edited", target: "Organization chart", employeeNo: id, detail: `Head of the company: ${company.first_name ? nameOf(company) : "—"} → ${nameOf(e)}` });
  });
}

/** Change who someone reports to. Blocks loops (reporting to someone who reports to them). */
export async function setReportsTo(s: Session, id: string, supervisorId: string | null) {
  demand(s, "edit", "orgChart");
  return tx(async (c) => {
    const e = await employeeOf(c, id);
    if (e.record_status === "SEPARATED") throw new UserError("That employee no longer works here");
    if (supervisorId === id) throw new UserError("Someone can't report to themselves");
    const sup = supervisorId ? await employeeOf(c, supervisorId) : null;
    if (sup && sup.record_status === "SEPARATED") throw new UserError("Choose a current employee");
    if (sup) {
      const { rows } = await c.query(
        `with recursive up as (select employee_id, supervisor_id from employees where employee_id = $1
           union all select x.employee_id, x.supervisor_id from employees x join up on x.employee_id = up.supervisor_id)
         select 1 from up where employee_id = $2 limit 1`,
        [sup.employee_id, id],
      );
      if (rows.length) throw new UserError(`${nameOf(sup)} already reports to ${nameOf(e)}, directly or through someone else`);
    }
    const { rows: [company] } = await c.query(`select head_employee_id from org_units where unit_type = 'company' limit 1`);
    if (company?.head_employee_id === id && sup) throw new UserError("The head of the company reports to no one. Choose a new head first.");
    const before = e.supervisor_id ? await employeeRow(c, e.supervisor_id) : null;
    await c.query(`update employees set supervisor_id = $2, updated_at = now() where employee_id = $1`, [id, sup?.employee_id ?? null]);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Edited", target: "Organization chart", employeeNo: id, detail: `Reports to: ${before ? nameOf(before) : "—"} → ${sup ? nameOf(sup) : "—"}` });
  });
}

// ---- Documents ----

/**
 * A Professional License document with a number on it keeps the person's PRC license
 * record (used for CPD tracking) in step: created on first record, number, type and
 * cycle end (the license expiry) updated after. Nothing is deleted when a document is reset.
 */
async function syncLicense(c: Db, documentId: string) {
  const d = (await c.query(`select * from employee_documents where id = $1`, [documentId])).rows[0];
  if (!d || d.document_type !== "Professional License" || !d.reference_no) return;
  const type = d.id_type?.trim() || "PRC license";
  // The number is copied as stored (encrypted); both columns are read back with open().
  const existing = (await c.query(`select id from professional_licenses where employee_id = $1 order by expires_on desc nulls last limit 1`, [d.employee_id])).rows[0];
  if (existing) {
    await c.query(`update professional_licenses set license_type = $2, license_number = $3, expires_on = $4, cycle_end_date = coalesce($4, cycle_end_date) where id = $1`, [existing.id, type, d.reference_no, d.expires_on]);
  } else {
    await c.query(`insert into professional_licenses (employee_id, license_type, license_number, expires_on, cycle_end_date) values ($1, $2, $3, $4, $4)`, [d.employee_id, type, d.reference_no, d.expires_on]);
  }
}

const daysUntil = (iso: string) => Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date(`${today()}T00:00:00`).getTime()) / 86_400_000);

export async function updateDocument(s: Session, id: string, action: any) {
  return tx(async (c) => {
    const { rows: [d] } = await c.query(`select * from employee_documents where id::text = $1 for update`, [id]);
    if (!d) throw new UserError("That document no longer exists", 404);
    // Employees upload their own documents and can withdraw one HR hasn't checked yet; everything else is HR's.
    const own = !!s.employeeNo && d.employee_id === s.employeeNo && (action?.kind === "upload" || action?.kind === "withdraw");
    if (!own) demand(s, "edit", "documents", d.employee_id);
    const log = (act: string, detail: string) => audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: act, target: d.document_type, employeeNo: d.employee_id, detail });
    const clearVerification = `verified_at = null, verified_by = null, verified_by_name = null`;
    switch (action?.kind) {
      case "upload": {
        if (!action.fileName) throw new UserError("Choose a file");
        // HR records the expiry when uploading; an employee's own upload leaves it for HR to fill in on checking.
        if (!own && EXPIRING.includes(d.document_type) && d.document_type !== "Police/Barangay Clearance" && !action.expiresOn) throw new UserError("Enter the expiry date");
        if (d.status === "Verified" && own) throw new UserError("HR already verified this document. Ask HR if it needs replacing.");
        if (action.expiresOn && daysUntil(action.expiresOn) < 0) throw new UserError("That document has already expired");
        await c.query(
          `update employee_documents set status = 'Submitted', file_name = $2, submitted_at = now(), reference_no = $3, expires_on = $4, ${clearVerification}, note = null where id = $1`,
          [d.id, seal(action.fileName), seal(action.referenceNo?.trim()), action.expiresOn || null],
        );
        await log("Uploaded", d.file_name ? "Replaced the file" : "Uploaded a file");
        break;
      }
      case "verify":
        if (d.status !== "Submitted") throw new UserError("Only a submitted document can be verified");
        await c.query(`update employee_documents set status = 'Verified', verified_by = $2, verified_by_name = $3, verified_at = now(), note = null where id = $1`, [d.id, s.accountId, s.name]);
        await log("Verified", "Checked against the original and verified");
        await syncLicense(c, d.id);
        break;
      case "return": {
        const note = String(action.note ?? "").trim();
        if (!note) throw new UserError("Say what needs fixing so the employee can resubmit");
        await c.query(`update employee_documents set status = 'Missing', file_name = null, submitted_at = null, ${clearVerification}, note = $2 where id = $1`, [d.id, note]);
        await log("Edited", `Returned for resubmission: ${note}`);
        break;
      }
      case "not-applicable":
        await c.query(`update employee_documents set status = 'Not applicable', file_name = null, submitted_at = null, ${clearVerification}, expires_on = null, reference_no = null where id = $1`, [d.id]);
        await log("Edited", "Marked not applicable");
        break;
      case "withdraw":
        if (d.status !== "Submitted") throw new UserError("Only a document waiting for HR can be withdrawn");
        await c.query(`update employee_documents set status = 'Missing', file_id = null, file_name = null, submitted_at = null where id = $1`, [d.id]);
        await log("Edited", "Withdrawn by the employee");
        break;
      case "details": {
        const expiresOn = action.expiresOn ? String(action.expiresOn) : null;
        if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new UserError("Enter the expiry date as a date");
        await c.query(`update employee_documents set id_type = $2, reference_no = $3, expires_on = $4 where id = $1`, [d.id, action.idType?.trim() || null, seal(action.referenceNo?.trim()), expiresOn]);
        await log("Edited", "Details updated");
        await syncLicense(c, d.id);
        break;
      }
      case "reset":
        await c.query(`update employee_documents set status = 'Missing', file_id = null, file_name = null, submitted_at = null, ${clearVerification}, id_type = null, reference_no = null, expires_on = null, note = null where id = $1`, [d.id]);
        await log("Removed", "Reset to Missing");
        break;
      case "required":
        await c.query(`update employee_documents set status = 'Missing' where id = $1`, [d.id]);
        await log("Edited", "Marked as required");
        break;
      default:
        throw new UserError("Unknown document action");
    }
  });
}
