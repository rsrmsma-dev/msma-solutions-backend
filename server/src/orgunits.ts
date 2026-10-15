// Maintenance > Locations and Departments: offices ("branch" org units under the company) and their
// departments. Same checks as src/lib/corehr/maintenance.ts. Everyone signed in reads the tree through
// /api/corehr/state; only these changes are here.

import { audit, demand, type Session } from "./auth";
import { need023, tx, UserError, type Db } from "./db";

const tidy = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ");
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const log = (db: Db, s: Session, action: string, target: string, detail: string) =>
  audit(db, { actorId: s.accountId, actorName: s.name, module: "People", action, target, detail });

/** Current (not separated) people in this unit or anything under it. */
async function headcount(db: Db, unitId: string): Promise<number> {
  const { rows } = await db.query(
    `with recursive down as (select id from org_units where id = $1 union all select u.id from org_units u join down on u.parent_id = down.id)
     select count(*)::int as n from employees where org_unit_id in (select id from down) and record_status <> 'SEPARATED'`,
    [unitId],
  );
  return rows[0].n;
}

async function unit(db: Db, id: string, type: "branch" | "department") {
  if (!isUuid(id)) return undefined;
  return (await db.query(`select * from org_units where id = $1 and unit_type = $2 for update`, [id, type])).rows[0];
}

// ---- Locations (offices) ----

export async function saveLocation(s: Session, id: string | undefined, body: any) {
  demand(s, id ? "edit" : "create", "locations");
  const name = tidy(body?.name);
  const code = tidy(body?.code).toUpperCase();
  const address = tidy(body?.address);
  if (!name) throw new UserError('Name the office, for example "Iloilo"');
  if (!/^[A-Z0-9]{2,5}$/.test(code)) throw new UserError('Use a short code of 2 to 5 letters or numbers, for example "ILO"');
  if (!address) throw new UserError("Enter the office address");
  const contactName = tidy(body?.contactName);
  const contactPhone = tidy(body?.contactPhone);
  const managerId = String(body?.managerId ?? "").trim() || null;
  if (!contactName) throw new UserError("Enter the contact person at this office");
  if (!/^(\+?63|0)\d{7,10}$/.test(contactPhone.replace(/[\s()-]/g, ""))) throw new UserError("Enter the contact person's phone, e.g. 0917 123 4567 or (032) 234 5678");
  await need023();
  return tx(async (c) => {
    // One change to the list of offices at a time, so two can't take the same name or code.
    await c.query(`select pg_advisory_xact_lock(hashtext('org_units'))`);
    const existing = id ? await unit(c, id, "branch") : undefined;
    if (id && !existing) throw new UserError("That office no longer exists", 404);
    if (existing && existing.name !== name) throw new UserError("An office's name can't be changed here: it is used across attendance, holidays and payroll. Change the code or address, or add a new office.");
    const others = (await c.query(`select name, code from org_units where unit_type = 'branch' and id is distinct from $1`, [existing?.id ?? null])).rows;
    if (others.some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new UserError("There's already an office with that name");
    if (others.some((b) => b.code === code)) throw new UserError("Another office already uses that code");
    if (managerId && !(await c.query(`select 1 from employees where employee_id = $1 and record_status <> 'SEPARATED'`, [managerId])).rowCount) throw new UserError("Choose a current employee as manager");
    if (existing) {
      await c.query(`update org_units set code = $2, address = $3, contact_name = $4, contact_phone = $5, head_employee_id = $6 where id = $1`, [existing.id, code, address, contactName, contactPhone, managerId]);
      const changed = [
        existing.code !== code && `Code: ${existing.code} → ${code}`,
        existing.address !== address && "Address changed",
        (existing.contact_name !== contactName || existing.contact_phone !== contactPhone) && "Contact changed",
        (existing.head_employee_id ?? null) !== managerId && `Manager → ${managerId ?? "none"}`,
      ].filter(Boolean).join("; ");
      if (changed) await log(c, s, "Changed office", name, changed);
      return { id: existing.id as string };
    }
    const company = (await c.query(`select id from org_units where unit_type = 'company' limit 1`)).rows[0];
    const { rows: [r] } = await c.query(
      `insert into org_units (unit_type, name, code, parent_id, address, contact_name, contact_phone, head_employee_id) values ('branch', $1, $2, $3, $4, $5, $6, $7) returning id`,
      [name, code, company?.id ?? null, address, contactName, contactPhone, managerId],
    );
    await log(c, s, "Added office", name, `Code ${code}`);
    return { id: r.id as string };
  });
}

/** Open (true) or close (false); anything else is refused rather than read as "close". */
function onOff(v: unknown): boolean {
  if (typeof v !== "boolean") throw new UserError("Say whether to open or close it");
  return v;
}

export async function setLocationActive(s: Session, id: string, value: unknown) {
  demand(s, "edit", "locations");
  const active = onOff(value);
  return tx(async (c) => {
    const u = await unit(c, id, "branch");
    if (!u) throw new UserError("That office no longer exists", 404);
    const n = active ? 0 : await headcount(c, u.id);
    if (n > 0) throw new UserError(`${n} people still work in ${u.name}. Move them to another office first.`);
    await c.query(`update org_units set is_active = $2 where id = $1`, [u.id, active]);
    if (u.is_active !== active) await log(c, s, active ? "Reopened office" : "Closed office", u.name, "");
  });
}

// ---- Departments ----

export async function saveDepartment(s: Session, id: string | undefined, body: any) {
  demand(s, id ? "edit" : "create", "departments");
  const name = tidy(body?.name);
  const code = tidy(body?.code).toUpperCase();
  const officeId = String(body?.officeId ?? "");
  const headId = String(body?.headEmployeeId ?? "").trim() || null;
  if (!name) throw new UserError("Name the department");
  if (!/^[A-Z0-9]{2,6}$/.test(code)) throw new UserError('Use a short code of 2 to 6 letters or numbers, for example "TAX"');
  return tx(async (c) => {
    await c.query(`select pg_advisory_xact_lock(hashtext('org_units'))`);
    const office = isUuid(officeId) ? (await c.query(`select id, name from org_units where id = $1 and unit_type = 'branch' and is_active`, [officeId])).rows[0] : undefined;
    if (!office) throw new UserError("Choose the office");
    const existing = id ? await unit(c, id, "department") : undefined;
    if (id && !existing) throw new UserError("That department no longer exists", 404);
    const clash = await c.query(`select 1 from org_units where unit_type = 'department' and parent_id = $1 and lower(name) = lower($2) and id is distinct from $3`, [office.id, name, existing?.id ?? null]);
    if (clash.rowCount) throw new UserError(`${office.name} already has a department with that name`);
    if (headId && !(await c.query(`select 1 from employees where employee_id = $1 and record_status <> 'SEPARATED'`, [headId])).rowCount) throw new UserError("Choose a current employee as head");
    if (existing) {
      await c.query(`update org_units set name = $2, code = $3, parent_id = $4, head_employee_id = $5 where id = $1`, [existing.id, name, code, office.id, headId]);
      const changed = [
        existing.name !== name && `Name: ${existing.name} → ${name}`,
        existing.code !== code && `Code: ${existing.code} → ${code}`,
        existing.parent_id !== office.id && `Office → ${office.name}`,
        (existing.head_employee_id ?? null) !== headId && `Head → ${headId ?? "none"}`,
      ].filter(Boolean).join("; ");
      if (changed) await log(c, s, "Changed department", name, changed);
      return { id: existing.id as string };
    }
    const { rows: [r] } = await c.query(
      `insert into org_units (unit_type, name, code, parent_id, head_employee_id) values ('department', $1, $2, $3, $4) returning id`,
      [name, code, office.id, headId],
    );
    await log(c, s, "Added department", name, `${office.name}; code ${code}`);
    return { id: r.id as string };
  });
}

export async function setDepartmentActive(s: Session, id: string, value: unknown) {
  demand(s, "edit", "departments");
  const active = onOff(value);
  return tx(async (c) => {
    const u = await unit(c, id, "department");
    if (!u) throw new UserError("That department no longer exists", 404);
    const n = active ? 0 : await headcount(c, u.id);
    if (n > 0) throw new UserError(`${n} people are still in ${u.name}. Move them to another department first.`);
    await c.query(`update org_units set is_active = $2 where id = $1`, [u.id, active]);
    if (u.is_active !== active) await log(c, s, active ? "Reopened department" : "Closed department", u.name, "");
  });
}
