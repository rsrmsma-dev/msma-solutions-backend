// Leave: types, requests, decisions, cancellations and the yearly credit pool.
// The rules come from src/lib/leave/rules.ts, the same file the browser uses,
// so a request the form accepts is exactly one the server accepts.

import type pg from "pg";
import { CREDITS_ADJUSTMENT, creditsOf, DEFAULT_TYPES, fmtCredits, isoToday, LEAVE_CREDITS_PER_YEAR, previewOf, type FileInput, type LeaveData, type LeavePersonFacts } from "../../src/lib/leave/rules";
import type { LeaveType } from "../../src/lib/leave/types";
import { audit, can, demand, type Session } from "./auth";
import { clean, pool, tx, UserError, type Db } from "./db";

export { DEFAULT_TYPES };

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? undefined);

function typeJson(r: any): LeaveType {
  return {
    id: r.id, name: r.name, code: r.code, daysPerYear: r.days_per_year,
    earning: r.earning_kind === "monthly" ? { kind: "monthly", perMonth: r.earning_per_month ?? 0 } : { kind: r.earning_kind },
    paid: r.is_paid, carryOverMax: r.carry_over_max, countBy: r.count_by, eligibility: r.eligibility,
    attachmentOver: r.attachment_over_days, confidential: r.is_confidential, basis: r.legal_basis, active: r.is_active,
  };
}

/** Everything the rules look at, in the browser's shapes. Inside a transaction when deciding. */
async function loadData(db: Db): Promise<LeaveData> {
  const [types, requests, adjustments, carry] = await Promise.all([
    db.query(`select * from leave_types order by name`),
    db.query(`select * from leave_requests order by filed_at desc`),
    db.query(`select * from leave_adjustments order by adjusted_at desc`),
    db.query(`select * from leave_carry_overs where leave_year = $1`, [Number(isoToday().slice(0, 4))]),
  ]);
  return {
    types: types.rows.map(typeJson),
    requests: requests.rows.map((r) => clean({
      id: r.id, employeeId: r.employee_id, typeId: r.leave_type_id, start: r.date_from, end: r.date_to, halfDay: r.half_day, days: r.days,
      reason: r.reason, attachment: r.attachment_name, status: r.status, filedBy: r.filed_by_name, filedAt: iso(r.filed_at)!,
      decidedBy: r.decided_by_name, decidedAt: iso(r.decided_at), note: r.decision_note,
    })),
    adjustments: adjustments.rows.map((a) => ({ id: a.id, employeeId: a.employee_id, typeId: a.leave_type_id ?? CREDITS_ADJUSTMENT, days: a.days, reason: a.reason, by: a.adjusted_by_name, at: iso(a.adjusted_at)! })),
    carryOver: Object.fromEntries(carry.rows.map((c) => [`${c.employee_id}|${c.leave_type_id}`, c.days])),
  };
}

/** Sex, civil status and hire date in the app's terms, for eligibility and accrual. */
async function facts(db: Db, employeeId: string): Promise<LeavePersonFacts | undefined> {
  const r = (await db.query(`select sex, civil_status, date_hired from employees where employee_id = $1`, [employeeId])).rows[0];
  if (!r) return undefined;
  const sex = r.sex === "M" ? "Male" : r.sex === "F" ? "Female" : "";
  const civil = r.civil_status ? r.civil_status[0] + r.civil_status.slice(1).toLowerCase() : "";
  return { personal: { sex, civilStatus: civil }, job: { dateHired: r.date_hired } };
}

export async function loadState(s: Session): Promise<LeaveData> {
  const data = await loadData(pool);
  if (can(s, "leave", "view")) return data;
  // Without Leave access: your own requests in full; for everyone else only who is away when
  // (for calendars and attendance), never the reason, attachment or HR's note.
  const me = s.employeeNo ?? "";
  return {
    ...data,
    requests: data.requests
      .filter((r) => r.employeeId === me || r.status === "approved" || r.status === "pending")
      .map((r) => (r.employeeId === me ? r : { ...r, reason: "", attachment: undefined, note: undefined, filedBy: "", decidedBy: undefined })),
    adjustments: data.adjustments.filter((a) => a.employeeId === me),
    carryOver: Object.fromEntries(Object.entries(data.carryOver).filter(([k]) => k.startsWith(`${me}|`))),
  };
}

/** One person's leave changes one at a time, so two requests can't both take the last credit. */
const lockEmployee = (c: pg.PoolClient, employeeId: string) => c.query(`select pg_advisory_xact_lock(hashtext('leave:' || $1))`, [employeeId]);

const log = (db: Db, s: Session, action: string, employeeId: string, detail: string) =>
  audit(db, { actorId: s.accountId, actorName: s.name, module: "Leave", action, target: "Leave", employeeNo: employeeId, detail });

// ---- Requests ----

export async function fileLeave(s: Session, body: any) {
  const str = (k: string) => (body?.[k] === undefined || body?.[k] === null ? "" : String(body[k]));
  const input: FileInput & { approveNow: boolean } = {
    employeeId: str("employeeId"), typeId: str("typeId"), start: str("start"), end: str("end"), reason: str("reason"),
    halfDay: body?.halfDay === "am" || body?.halfDay === "pm" ? body.halfDay : undefined,
    attachment: str("attachment") || undefined, approveNow: body?.approveNow === true,
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.end)) throw new UserError("Pick the start and end dates");
  const own = !!s.employeeNo && input.employeeId === s.employeeNo;
  if (!own) demand(s, "leave", "edit");
  if (input.approveNow) demand(s, "leave", "approve");
  if (!String(input.reason ?? "").trim()) throw new UserError("Give a short reason");
  return tx(async (c) => {
    await lockEmployee(c, input.employeeId);
    const p = previewOf(await loadData(c), await facts(c, input.employeeId), input);
    if (p.errors.length) throw new UserError(p.errors[0]!);
    const halfDay = input.start === input.end ? input.halfDay ?? null : null;
    const { rows: [r] } = await c.query(
      `insert into leave_requests (employee_id, leave_type_id, date_from, date_to, half_day, days, reason, attachment_name, status, filed_by, filed_by_name, decided_by, decided_by_name, decided_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [input.employeeId, input.typeId, input.start, input.end, halfDay, p.days, input.reason.trim(), input.attachment || null, input.approveNow ? "approved" : "pending",
        s.accountId, s.name, input.approveNow ? s.accountId : null, input.approveNow ? s.name : null, input.approveNow ? new Date() : null],
    );
    await log(c, s, input.approveNow ? "Filed and approved leave" : "Filed leave", input.employeeId, `${input.start}${input.end !== input.start ? ` to ${input.end}` : ""} (${p.days} days)`);
    return (await loadData(c)).requests.find((x) => x.id === r.id);
  });
}

export async function decideRequest(s: Session, id: string, approve: boolean, note: string) {
  demand(s, "leave", "approve");
  return tx(async (c) => {
    const r = (await c.query(`select * from leave_requests where id::text = $1`, [id])).rows[0];
    if (!r) throw new UserError("That request no longer exists", 404);
    await lockEmployee(c, r.employee_id);
    const cur = (await c.query(`select status from leave_requests where id = $1`, [r.id])).rows[0];
    if (cur.status !== "pending") throw new UserError("This request was already decided");
    if (!approve && !note.trim()) throw new UserError("Say why, so the employee knows");
    if (approve) {
      const data = await loadData(c);
      const type = data.types.find((t) => t.id === r.leave_type_id);
      // Pending already includes this request, so compare against what's left before it.
      const cr = creditsOf(data, r.employee_id);
      if (type && type.earning.kind !== "unlimited" && cr.used >= cr.total) throw new UserError(`All ${cr.total} leaves for this year are used up. Ask them to file it as Leave without pay.`);
    }
    await c.query(`update leave_requests set status = $2, decided_by = $3, decided_by_name = $4, decided_at = now(), decision_note = $5 where id = $1`, [r.id, approve ? "approved" : "rejected", s.accountId, s.name, note.trim() || null]);
    await log(c, s, approve ? "Approved leave" : "Rejected leave", r.employee_id, `${r.date_from}${r.date_to !== r.date_from ? ` to ${r.date_to}` : ""}${note.trim() ? `: ${note.trim()}` : ""}`);
    return (await loadData(c)).requests.find((x) => x.id === r.id);
  });
}

/** Withdraw a request, or an approved leave that hasn't started yet; the days go back. */
export async function cancelRequest(s: Session, id: string, note: string) {
  return tx(async (c) => {
    const r = (await c.query(`select * from leave_requests where id::text = $1 for update`, [id])).rows[0];
    if (!r) throw new UserError("That request no longer exists", 404);
    if (!(s.employeeNo && r.employee_id === s.employeeNo)) demand(s, "leave", "edit");
    if (r.status !== "pending" && r.status !== "approved") throw new UserError("This request is already closed");
    if (r.status === "approved" && r.date_from <= isoToday()) throw new UserError("This leave has already started and can't be cancelled");
    if (!note.trim()) throw new UserError("Say why it's being cancelled");
    await c.query(`update leave_requests set status = 'cancelled', decided_by = $2, decided_by_name = $3, decided_at = now(), decision_note = $4 where id = $1`, [r.id, s.accountId, s.name, note.trim()]);
    await log(c, s, "Cancelled leave", r.employee_id, `${r.date_from}${r.date_to !== r.date_from ? ` to ${r.date_to}` : ""}: ${note.trim()}`);
    return (await loadData(c)).requests.find((x) => x.id === r.id);
  });
}

// ---- Credits (6 a year, shared by every paid leave type) ----

export async function adjustCredits(s: Session, input: { employeeId?: string; leaves?: number; reason?: string }) {
  demand(s, "leave", "edit");
  const leaves = Number(input.leaves);
  const reason = String(input.reason ?? "").trim();
  if (!Number.isInteger(leaves) || leaves === 0) throw new UserError("Enter the leaves to add (e.g. 1) or remove (e.g. -1)");
  if (Math.abs(leaves) > LEAVE_CREDITS_PER_YEAR) throw new UserError(`Change at most ${LEAVE_CREDITS_PER_YEAR} leaves at a time`);
  if (!reason) throw new UserError("Say why the leaves are changing");
  const employeeId = String(input.employeeId ?? "");
  return tx(async (c) => {
    if (!(await facts(c, employeeId))) throw new UserError("That employee no longer exists");
    await lockEmployee(c, employeeId);
    const cr = creditsOf(await loadData(c), employeeId);
    if (cr.available + leaves < 0) throw new UserError(`They only have ${fmtCredits(cr.available)} left`);
    const { rows: [a] } = await c.query(
      `insert into leave_adjustments (employee_id, leave_type_id, days, reason, adjusted_by, adjusted_by_name) values ($1, null, $2, $3, $4, $5) returning *`,
      [employeeId, leaves, reason, s.accountId, s.name],
    );
    await log(c, s, "Changed leave balance", employeeId, `${leaves > 0 ? "+" : ""}${leaves} leaves: ${reason}`);
    return { id: a.id, employeeId, typeId: CREDITS_ADJUSTMENT, days: a.days, reason, by: s.name, at: iso(a.adjusted_at)! };
  });
}

// ---- Types ----

export async function saveType(s: Session, input: any) {
  demand(s, "leave", "edit");
  const name = String(input?.name ?? "").trim();
  const code = String(input?.code ?? "").trim().toUpperCase();
  if (!name) throw new UserError("Name the leave type");
  if (!code) throw new UserError("Give it a short code, e.g. VL");
  const earning = input?.earning ?? { kind: "yearly" };
  if (!["monthly", "yearly", "per-event", "unlimited"].includes(earning.kind)) throw new UserError("Choose how the days are earned");
  return tx(async (c) => {
    if ((await c.query(`select 1 from leave_types where lower(name) = lower($1) and id is distinct from $2`, [name, input.id ?? null])).rowCount) throw new UserError("There's already a leave type with that name");
    if ((await c.query(`select 1 from leave_types where upper(code) = $1 and id is distinct from $2`, [code, input.id ?? null])).rowCount) throw new UserError("Another leave type already uses that code");
    const existing = input.id ? (await c.query(`select * from leave_types where id = $1`, [input.id])).rows[0] : undefined;
    const id = existing?.id ?? `lt-${Date.now().toString(36)}`;
    const v = [
      id, name, code, Number(input.daysPerYear) || 0, earning.kind, earning.kind === "monthly" ? Number(earning.perMonth) || 0 : null, input.paid !== false,
      Number(input.carryOverMax) || 0, input.countBy === "calendar" ? "calendar" : "workdays", input.eligibility ?? "everyone",
      input.attachmentOver === null || input.attachmentOver === undefined || input.attachmentOver === "" ? null : Number(input.attachmentOver),
      !!input.confidential, String(input.basis ?? "").trim() || "Company policy",
    ];
    if (existing) {
      await c.query(
        `update leave_types set name=$2, code=$3, days_per_year=$4, earning_kind=$5, earning_per_month=$6, is_paid=$7, carry_over_max=$8, count_by=$9, eligibility=$10, attachment_over_days=$11, is_confidential=$12, legal_basis=$13 where id=$1`, v);
    } else {
      await c.query(
        `insert into leave_types (id, name, code, days_per_year, earning_kind, earning_per_month, is_paid, carry_over_max, count_by, eligibility, attachment_over_days, is_confidential, legal_basis) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, v);
    }
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Leave", action: existing ? "Changed leave type" : "Added leave type", target: name });
    return typeJson((await c.query(`select * from leave_types where id = $1`, [id])).rows[0]);
  });
}

export async function setTypeActive(s: Session, id: string, active: boolean) {
  demand(s, "leave", "edit");
  const { rows } = await pool.query(`update leave_types set is_active = $2 where id = $1 returning name`, [id, active]);
  if (!rows[0]) throw new UserError("That leave type no longer exists", 404);
  await audit(pool, { actorId: s.accountId, actorName: s.name, module: "Leave", action: active ? "Turned on leave type" : "Turned off leave type", target: rows[0].name });
}

/** The built-in leave types, for the seed script. */
export async function seedTypes(c: Db) {
  for (const t of DEFAULT_TYPES) {
    await c.query(
      `insert into leave_types (id, name, code, days_per_year, earning_kind, earning_per_month, is_paid, carry_over_max, count_by, eligibility, attachment_over_days, is_confidential, legal_basis, is_active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict do nothing`,
      [t.id, t.name, t.code, t.daysPerYear, t.earning.kind, t.earning.kind === "monthly" ? t.earning.perMonth : null, t.paid, t.carryOverMax, t.countBy, t.eligibility, t.attachmentOver, t.confidential, t.basis, t.active],
    );
  }
}
