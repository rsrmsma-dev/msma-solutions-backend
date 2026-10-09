// Timekeeping & attendance: shifts and schedules, HR's punch corrections, overtime /
// undertime and missed time-in/out requests, remote work days with clock-in from
// home, attendance notices and the tardiness rule. Ported from
// src/lib/timekeeping/api.ts; shift and tardiness checks come from the shared
// src/lib/timekeeping/rules.ts. Day results (late, undertime, overtime) are worked
// out in the browser from these records.
//
// Punch times are wall-clock times in the company's time zone (Asia/Manila).

import type pg from "pg";
import { DEFAULT_SHIFTS, shiftProblem, tardinessRuleProblem } from "../../src/lib/timekeeping/rules";
import type { ShiftTemplate } from "../../src/lib/timekeeping/types";
import { demand, seenIds, type Session } from "./auth";
import { clean, pool, tx, UserError, type Db } from "./db";

const TZ = process.env.APP_TIME_ZONE ?? "Asia/Manila";
const HHMM = /^\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? undefined);
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : undefined);

/** Today's date in the company's time zone. */
async function today(db: Db): Promise<string> {
  return (await db.query(`select to_char(now() at time zone $1, 'YYYY-MM-DD') as d`, [TZ])).rows[0].d;
}
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Is this local wall-clock time ("2026-10-07T08:30") later than now? */
async function inFuture(db: Db, local: string) {
  return (await db.query(`select ($1::timestamp at time zone $2) > now() as f`, [local, TZ])).rows[0].f as boolean;
}

/** Timekeeping entries go into the audit trail with the work date they're about. */
async function log(db: Db, s: Session, employeeId: string, workDate: string, action: string, detail: string) {
  await db.query(
    `insert into audit_log (actor_account_id, actor_name, module, action, target, employee_id, detail, data) values ($1, $2, 'Timekeeping', $3, 'Attendance', $4, $5, $6)`,
    [s.accountId, s.name, action, employeeId, detail, JSON.stringify({ workDate })],
  );
}

async function employee(db: Db, id: string) {
  const r = (await db.query(`select employee_id, record_status, org_unit_id from employees where employee_id = $1`, [id])).rows[0];
  if (!r) throw new UserError("That employee no longer exists");
  return r;
}

/** The branch someone's team or department sits in. */
async function branchOf(db: Db, employeeId: string): Promise<{ id: string; name: string } | undefined> {
  const { rows } = await db.query(
    `with recursive up as (select u.* from org_units u join employees e on e.org_unit_id = u.id where e.employee_id = $1
       union all select p.* from org_units p join up on p.id = up.parent_id)
     select id, name from up where unit_type = 'branch' limit 1`,
    [employeeId],
  );
  return rows[0];
}

// ---- Reading ----

const PUNCH_SELECT = `select *, to_char(punched_at at time zone $1, 'YYYY-MM-DD"T"HH24:MI') as at_local from punches`;

function punchJson(p: any) {
  return clean({
    id: p.id, employeeId: p.employee_id, workDate: p.work_date, at: p.at_local, kind: p.direction,
    source: p.source === "remote" ? "face" : p.source, device: p.device_label ?? "", deviceBranch: p.device_branch, deviceRegistered: true,
    match: p.face_match, reason: p.reason, recordedBy: p.recorded_by_name,
  });
}

function shiftJson(r: any): ShiftTemplate {
  return clean({
    id: r.id, name: r.name, start: hhmm(r.start_time)!, end: hhmm(r.end_time)!, breakMinutes: r.break_minutes, breakStart: hhmm(r.break_start)!,
    graceMinutes: r.grace_minutes, restDays: r.rest_days, flexible: r.is_flexible || undefined, requiredHours: r.required_hours ?? undefined, active: r.is_active,
  });
}

const requestJson = (r: any) => clean({
  id: r.id, employeeId: r.employee_id, date: r.work_date, type: r.request_type, minutes: r.minutes, reason: r.reason, status: r.status,
  filedBy: r.filed_by_name, filedAt: iso(r.filed_at), decidedBy: r.decided_by_name, decidedAt: iso(r.decided_at), note: r.decision_note,
});
const fixJson = (r: any) => clean({
  id: r.id, employeeId: r.employee_id, workDate: r.work_date, kind: r.direction, time: hhmm(r.requested_time), nextDay: r.next_day || undefined,
  cause: r.cause, recorded: hhmm(r.recorded_time), reason: r.reason, status: r.status,
  filedBy: r.filed_by_name, filedAt: iso(r.filed_at), decidedBy: r.decided_by_name, decidedAt: iso(r.decided_at), note: r.decision_note,
});
const noticeJson = (n: any) => clean({
  id: n.id, employeeId: n.employee_id, kind: n.notice_kind, subject: n.subject, message: n.message, dates: n.dates,
  sentBy: n.sent_by_name, sentAt: iso(n.sent_at), acknowledgedAt: iso(n.acknowledged_at),
});

/**
 * Everything the Timekeeping pages read, in the browser's shapes: everyone's records for roles that
 * see all attendance (HR, Accounting for payroll, Super Admin), an approver's team, or only your own.
 */
export async function loadState(s: Session) {
  const scope = seenIds(s, "attendanceRecords");
  const all = scope === "all";
  const ids = all ? [] : [...new Set([...scope, ...(s.employeeNo ? [s.employeeNo] : [])])];
  // Person-specific rows are limited to those people (as a query parameter).
  const own = (base: string, order = "") =>
    all ? pool.query(`${base} ${order}`) : pool.query(`${base} ${base.includes(" where ") ? "and" : "where"} employee_id = any($1) ${order}`, [ids]);
  const [shifts, usual, overrides, punches, requests, fixes, auditRows, settings, notices, remote] = await Promise.all([
    pool.query(`select * from shift_templates order by name`),
    own(`select employee_id, default_shift_id from employees where default_shift_id is not null`),
    own(`select * from schedule_overrides`),
    pool.query(all ? PUNCH_SELECT : `${PUNCH_SELECT} where employee_id = any($2)`, all ? [TZ] : [TZ, ids]),
    own(`select * from time_requests`, `order by work_date desc`),
    own(`select * from punch_fix_requests`, `order by filed_at desc`),
    pool.query(
      `select id::text, employee_id, data->>'workDate' as work_date, actor_name, action, coalesce(detail, '') as detail, occurred_at from audit_log
        where module = 'Timekeeping' and employee_id is not null ${all ? "" : "and employee_id = any($1)"} order by occurred_at desc limit 5000`,
      all ? [] : [scope],
    ),
    pool.query(`select tardy_consecutive_days, tardy_per_month from company_settings where id = 1`),
    own(`select * from attendance_notices`, `order by sent_at desc`),
    pool.query(`select d.*, coalesce(array_agg(u.name order by u.name) filter (where u.name is not null), '{}') as offices
                  from remote_work_days d left join remote_work_day_branches b on b.remote_work_day_id = d.id left join org_units u on u.id = b.branch_id
                 group by d.id order by d.date_from desc`),
  ]);
  const ps = punches.rows;
  const st = settings.rows[0];
  return {
    shifts: shifts.rows.map(shiftJson),
    usualShift: Object.fromEntries(usual.rows.map((r) => [r.employee_id, r.default_shift_id])),
    overrides: Object.fromEntries(overrides.rows.map((o) => [`${o.employee_id}|${o.work_date}`, o.shift_id ?? "rest"])),
    corrections: ps.filter((p) => p.source === "manual").map(punchJson),
    remotePunches: ps.filter((p) => p.source === "remote").map(punchJson),
    voided: Object.fromEntries(ps.filter((p) => p.voided_at).map((p) => [p.id, { reason: p.voided_reason, by: p.voided_by_name ?? "", at: iso(p.voided_at) }])),
    confirmed: Object.fromEntries(ps.filter((p) => p.confirmed_at).map((p) => [p.id, { by: p.confirmed_by_name ?? "", at: iso(p.confirmed_at) }])),
    requests: requests.rows.map(requestJson),
    fixRequests: fixes.rows.map(fixJson),
    audit: auditRows.rows.map((a) => ({ id: a.id, employeeId: a.employee_id, workDate: a.work_date ?? "", actor: a.actor_name, action: a.action, detail: a.detail, at: iso(a.occurred_at) })),
    tardinessRule: st ? { consecutive: st.tardy_consecutive_days, perMonth: st.tardy_per_month } : undefined,
    notices: notices.rows.map(noticeJson),
    remoteDays: remote.rows.map((d) => ({ id: d.id, from: d.date_from, to: d.date_to, offices: d.offices, reason: d.reason, declaredBy: d.declared_by_name, declaredAt: iso(d.declared_at) })),
    seededRequests: true,
    seasonShifts: true,
  };
}

// ---- Punches HR adds or reviews ----

async function insertCorrection(c: Db, s: Session, input: { employeeId: string; workDate: string; kind: string; time: string; nextDay?: boolean; reason: string }) {
  if (!DATE.test(input.workDate)) throw new UserError("Choose the day");
  if (input.kind !== "in" && input.kind !== "out") throw new UserError("Choose time-in or time-out");
  if (!HHMM.test(input.time)) throw new UserError("Enter the time");
  const reason = String(input.reason ?? "").trim();
  if (!reason) throw new UserError('Say why you\'re adding this punch, for example "forgot to tap out, confirmed by supervisor"');
  const atText = `${input.nextDay ? addDays(input.workDate, 1) : input.workDate}T${input.time}`;
  if (await inFuture(c, atText)) throw new UserError("That time hasn't happened yet");
  await employee(c, input.employeeId);
  const branch = await branchOf(c, input.employeeId);
  const { rows: [p] } = await c.query(
    `insert into punches (employee_id, work_date, punched_at, direction, source, device_label, device_branch, reason, recorded_by, recorded_by_name)
     values ($1, $2, ($3::timestamp at time zone $4), $5, 'manual', 'Added by HR', $6, $7, $8, $9) returning id`,
    [input.employeeId, input.workDate, atText, TZ, input.kind, branch?.name ?? null, reason, s.accountId, s.name],
  );
  await log(c, s, input.employeeId, input.workDate, "Added punch", `Time-${input.kind} ${input.time}${input.nextDay ? " (next day)" : ""}: ${reason}`);
  return punchJson((await c.query(`${PUNCH_SELECT} where id = $2`, [TZ, p.id])).rows[0]);
}

export async function addCorrection(s: Session, input: any) {
  demand(s, "edit", "attendanceRecords", String(input?.employeeId ?? ""));
  return tx((c) => insertCorrection(c, s, { ...input, employeeId: String(input?.employeeId ?? ""), workDate: String(input?.workDate ?? ""), kind: String(input?.kind ?? ""), time: String(input?.time ?? ""), nextDay: !!input?.nextDay, reason: String(input?.reason ?? "") }));
}

async function punchRow(c: Db, id: string) {
  const p = (await c.query(`${PUNCH_SELECT} where id::text = $2`, [TZ, id])).rows[0];
  if (!p) throw new UserError("That punch no longer exists", 404);
  return p;
}

async function setAside(c: Db, s: Session, p: any, reason: string) {
  await c.query(`update punches set voided_reason = $2, voided_by = $3, voided_by_name = $4, voided_at = now() where id = $1`, [p.id, reason, s.accountId, s.name]);
  await log(c, s, p.employee_id, p.work_date, "Set punch aside", `Time-${p.direction} ${p.at_local.slice(11)} (${p.device_label ?? ""}): ${reason}`);
}

export async function setPunchAside(s: Session, id: string, reason: string) {
  if (!reason.trim()) throw new UserError("Say why this punch should be ignored");
  return tx(async (c) => {
    const p = await punchRow(c, id);
    demand(s, "edit", "attendanceRecords", p.employee_id);
    await setAside(c, s, p, reason.trim());
  });
}

export async function keepPunch(s: Session, id: string) {
  return tx(async (c) => {
    const p = await punchRow(c, id);
    demand(s, "edit", "attendanceRecords", p.employee_id);
    await c.query(`update punches set confirmed_by = $2, confirmed_by_name = $3, confirmed_at = now() where id = $1`, [p.id, s.accountId, s.name]);
    await log(c, s, p.employee_id, p.work_date, "Kept flagged punch", `Time-${p.direction} ${p.at_local.slice(11)} (${p.device_label ?? ""}${p.face_match !== null ? `, ${p.face_match}% match` : ""})`);
  });
}

export async function restorePunch(s: Session, id: string) {
  return tx(async (c) => {
    const p = await punchRow(c, id);
    demand(s, "edit", "attendanceRecords", p.employee_id);
    await c.query(`update punches set voided_reason = null, voided_by = null, voided_by_name = null, voided_at = null where id = $1`, [p.id]);
    await log(c, s, p.employee_id, p.work_date, "Restored punch", `Time-${p.direction} ${p.at_local.slice(11)}`);
  });
}

// ---- Shifts and schedules ----

export async function saveShift(s: Session, body: any) {
  demand(s, body?.id ? "edit" : "create", "attendanceSettings");
  const input = {
    id: body?.id ? String(body.id) : undefined,
    name: String(body?.name ?? ""), start: String(body?.start ?? ""), end: String(body?.end ?? ""),
    breakMinutes: Number(body?.breakMinutes ?? 0), breakStart: String(body?.breakStart ?? ""), graceMinutes: Number(body?.graceMinutes ?? 0),
    restDays: Array.isArray(body?.restDays) ? body.restDays.map(Number) : [], flexible: !!body?.flexible,
    requiredHours: body?.requiredHours === undefined || body?.requiredHours === null || body?.requiredHours === "" ? undefined : Number(body.requiredHours),
  };
  return tx(async (c) => {
    const others = (await c.query(`select * from shift_templates`)).rows.map(shiftJson);
    const problem = shiftProblem(input, others);
    if (problem) throw new UserError(problem);
    const existing = input.id ? others.find((x) => x.id === input.id) : undefined;
    if (input.id && !existing) throw new UserError("That shift no longer exists", 404);
    const id = existing?.id ?? `sh-${Date.now().toString(36)}`;
    const v = [id, input.name.trim(), input.start, input.end, input.breakMinutes, input.breakMinutes > 0 ? input.breakStart : input.start, input.graceMinutes, input.restDays, input.flexible, input.flexible ? input.requiredHours ?? null : null];
    if (existing) {
      await c.query(`update shift_templates set name=$2, start_time=$3, end_time=$4, break_minutes=$5, break_start=$6, grace_minutes=$7, rest_days=$8, is_flexible=$9, required_hours=$10 where id=$1`, v);
    } else {
      await c.query(`insert into shift_templates (id, name, start_time, end_time, break_minutes, break_start, grace_minutes, rest_days, is_flexible, required_hours) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, v);
    }
    return shiftJson((await c.query(`select * from shift_templates where id = $1`, [id])).rows[0]);
  });
}

export async function setUsualShift(s: Session, employeeIds: unknown, shiftId: unknown) {
  demand(s, "edit", "attendanceSettings");
  const ids = Array.isArray(employeeIds) ? employeeIds.map(String) : [];
  if (!ids.length) throw new UserError("Choose who to change");
  return tx(async (c) => {
    let name = "no shift";
    if (shiftId !== null && shiftId !== undefined && shiftId !== "") {
      const sh = (await c.query(`select name from shift_templates where id = $1`, [String(shiftId)])).rows[0];
      if (!sh) throw new UserError("That shift no longer exists");
      name = sh.name;
    }
    const day = await today(c);
    for (const id of ids) {
      await employee(c, id);
      await c.query(`update employees set default_shift_id = $2, updated_at = now() where employee_id = $1`, [id, shiftId || null]);
      await log(c, s, id, day, "Changed usual shift", `Now on ${name}`);
    }
  });
}

/** One day only: a different shift, a rest day, or back to the usual schedule (null). */
export async function setDayShift(s: Session, employeeId: string, date: string, value: string | null) {
  demand(s, "edit", "attendanceSettings");
  if (!DATE.test(date)) throw new UserError("Choose the day");
  return tx(async (c) => {
    await employee(c, employeeId);
    let label = "back to usual schedule";
    if (value === null || value === undefined) {
      await c.query(`delete from schedule_overrides where employee_id = $1 and work_date = $2`, [employeeId, date]);
    } else {
      let shiftId: string | null = null;
      if (value === "rest") label = "rest day";
      else {
        const sh = (await c.query(`select id, name from shift_templates where id = $1`, [value])).rows[0];
        if (!sh) throw new UserError("That shift no longer exists");
        shiftId = sh.id;
        label = sh.name;
      }
      await c.query(
        `insert into schedule_overrides (employee_id, work_date, shift_id, set_by) values ($1, $2, $3, $4)
         on conflict (employee_id, work_date) do update set shift_id = excluded.shift_id, set_by = excluded.set_by`,
        [employeeId, date, shiftId, s.accountId],
      );
    }
    await log(c, s, employeeId, date, "Changed schedule", label);
  });
}

// ---- Overtime and undertime ----

export async function fileRequest(s: Session, body: any) {
  const input = { employeeId: String(body?.employeeId ?? ""), date: String(body?.date ?? ""), type: String(body?.type ?? ""), minutes: Number(body?.minutes), reason: String(body?.reason ?? "").trim() };
  demand(s, "create", "attendanceRecords", input.employeeId);
  if (input.type !== "overtime" && input.type !== "undertime") throw new UserError("Choose overtime or undertime");
  if (!DATE.test(input.date)) throw new UserError("Choose the day");
  if (!Number.isFinite(input.minutes) || input.minutes <= 0) throw new UserError("Enter how many minutes");
  if (input.minutes > 24 * 60) throw new UserError("That's more than a whole day");
  if (!input.reason) throw new UserError("Give the reason");
  return tx(async (c) => {
    await employee(c, input.employeeId);
    await c.query(`select pg_advisory_xact_lock(hashtext('time:' || $1))`, [input.employeeId]);
    const dup = await c.query(`select 1 from time_requests where employee_id = $1 and work_date = $2 and request_type = $3 and status <> 'declined'`, [input.employeeId, input.date, input.type]);
    if (dup.rowCount) throw new UserError("There's already a request for that day");
    const { rows: [r] } = await c.query(
      `insert into time_requests (employee_id, work_date, request_type, minutes, reason, filed_by_name) values ($1,$2,$3,$4,$5,$6) returning *`,
      [input.employeeId, input.date, input.type, Math.round(input.minutes), input.reason, s.name],
    );
    await log(c, s, input.employeeId, input.date, `Filed ${input.type}`, `${Math.round(input.minutes)} min: ${input.reason}`);
    return requestJson(r);
  });
}

export async function decideRequest(s: Session, id: string, approve: boolean, note: string) {
  return tx(async (c) => {
    const r = (await c.query(`select * from time_requests where id::text = $1 for update`, [id])).rows[0];
    if (!r) throw new UserError("That request no longer exists", 404);
    demand(s, "approve", "attendanceRecords", r.employee_id);
    if (r.status !== "pending") throw new UserError("This request was already decided");
    if (!approve && !note.trim()) throw new UserError("Add a short note so the employee knows why");
    const { rows: [next] } = await c.query(
      `update time_requests set status = $2, decided_by = $3, decided_by_name = $4, decided_at = now(), decision_note = $5 where id = $1 returning *`,
      [r.id, approve ? "approved" : "declined", s.accountId, s.name, note.trim() || null],
    );
    await log(c, s, r.employee_id, r.work_date, approve ? `Approved ${r.request_type}` : `Declined ${r.request_type}`, `${r.minutes} min${note.trim() ? `: ${note.trim()}` : ""}`);
    return requestJson(next);
  });
}

// ---- Tardiness rule ----

export async function saveTardinessRule(s: Session, body: any) {
  demand(s, "edit", "rules");
  const rule = { consecutive: Number(body?.consecutive), perMonth: Number(body?.perMonth) };
  const problem = tardinessRuleProblem(rule);
  if (problem) throw new UserError(problem);
  await pool.query(`update company_settings set tardy_consecutive_days = $1, tardy_per_month = $2, updated_at = now(), updated_by = $3 where id = 1`, [rule.consecutive, rule.perMonth, s.accountId]);
  return rule;
}

// ---- Remote work days and clock-in from home ----

async function remoteDayFor(c: Db, employeeId: string, date: string) {
  const branch = await branchOf(c, employeeId);
  const { rows } = await c.query(
    `select d.* from remote_work_days d
      where d.date_from <= $1 and d.date_to >= $1
        and (not exists (select 1 from remote_work_day_branches b where b.remote_work_day_id = d.id)
             or exists (select 1 from remote_work_day_branches b where b.remote_work_day_id = d.id and b.branch_id = $2))
      limit 1`,
    [date, branch?.id ?? null],
  );
  return rows[0];
}

export async function declareRemoteDay(s: Session, body: any) {
  demand(s, "create", "remoteDays");
  const from = String(body?.from ?? ""), to = String(body?.to ?? ""), reason = String(body?.reason ?? "").trim();
  const offices: string[] = Array.isArray(body?.offices) ? body.offices.map(String) : [];
  if (!DATE.test(from) || !DATE.test(to)) throw new UserError("Choose the dates");
  if (to < from) throw new UserError("The last day can't be before the first");
  return tx(async (c) => {
    if (to < (await today(c))) throw new UserError("Those days have passed. Fix past attendance with time adjustments instead.");
    if (!reason) throw new UserError('Give the reason, for example "Typhoon Kristine, Signal No. 3"');
    const branches = offices.length ? (await c.query(`select id, name from org_units where unit_type = 'branch' and name = any($1)`, [offices])).rows : [];
    if (branches.length !== offices.length) throw new UserError("One of those offices doesn't exist");
    const overlap = await c.query(
      `select 1 from remote_work_days d
        where d.date_from <= $2 and d.date_to >= $1
          and ($3::uuid[] = '{}' or not exists (select 1 from remote_work_day_branches b where b.remote_work_day_id = d.id)
               or exists (select 1 from remote_work_day_branches b where b.remote_work_day_id = d.id and b.branch_id = any($3::uuid[])))`,
      [from, to, branches.map((b) => b.id)],
    );
    if (overlap.rowCount) throw new UserError("Some of those days are already remote work days for these offices");
    const { rows: [d] } = await c.query(
      `insert into remote_work_days (date_from, date_to, reason, declared_by, declared_by_name) values ($1,$2,$3,$4,$5) returning *`,
      [from, to, reason, s.accountId, s.name],
    );
    for (const b of branches) await c.query(`insert into remote_work_day_branches (remote_work_day_id, branch_id) values ($1, $2)`, [d.id, b.id]);
    await c.query(`insert into audit_log (actor_account_id, actor_name, module, action, target, detail) values ($1, $2, 'Timekeeping', 'Declared remote work day', $3, $4)`,
      [s.accountId, s.name, offices.length ? offices.join(", ") : "All offices", `${from}${to !== from ? ` to ${to}` : ""}: ${reason}`]);
    return { id: d.id, from, to, offices: branches.map((b) => b.name), reason, declaredBy: s.name, declaredAt: iso(d.declared_at) };
  });
}

export async function cancelRemoteDay(s: Session, id: string) {
  demand(s, "delete", "remoteDays");
  return tx(async (c) => {
    const d = (await c.query(`select * from remote_work_days where id::text = $1 for update`, [id])).rows[0];
    if (!d) throw new UserError("That remote work day no longer exists", 404);
    if (d.date_from <= (await today(c))) {
      const used = await c.query(`select 1 from punches where source = 'remote' and work_date between $1 and $2 limit 1`, [d.date_from, d.date_to]);
      if (used.rowCount) throw new UserError("People already clocked in from home on these days, so they stay on record. You can only cancel days that haven't started.");
    }
    await c.query(`delete from remote_work_days where id = $1`, [d.id]);
    await c.query(`insert into audit_log (actor_account_id, actor_name, module, action, target, detail) values ($1, $2, 'Timekeeping', 'Cancelled remote work day', 'Remote work day', $3)`,
      [s.accountId, s.name, `${d.date_from}${d.date_to !== d.date_from ? ` to ${d.date_to}` : ""}: ${d.reason}`]);
  });
}

/** Time-in or time-out from home after a face scan; only on a remote work day, only for yourself. */
export async function clockRemote(s: Session, kind: string, match: unknown) {
  if (!s.employeeNo) throw new UserError("Your sign-in isn't linked to an employee record. Ask HR to link it.");
  if (kind !== "in" && kind !== "out") throw new UserError("Choose time-in or time-out");
  const employeeId = s.employeeNo;
  return tx(async (c) => {
    await c.query(`select pg_advisory_xact_lock(hashtext('clock:' || $1))`, [employeeId]);
    const date = await today(c);
    const day = await remoteDayFor(c, employeeId, date);
    if (!day) throw new UserError("Remote clock-in is only open on remote work days that HR declares");
    const mine = (await c.query(`select direction from punches where employee_id = $1 and work_date = $2 and source = 'remote' and voided_at is null`, [employeeId, date])).rows;
    if (kind === "in" && mine.some((p) => p.direction === "in")) throw new UserError("You already clocked in today");
    if (kind === "out" && !mine.some((p) => p.direction === "in")) throw new UserError("Clock in first");
    const m = Math.max(0, Math.min(100, Math.round(Number(match) || 0)));
    const { rows: [p] } = await c.query(
      `insert into punches (employee_id, work_date, punched_at, direction, source, device_label, face_match, reason, recorded_by, recorded_by_name)
       values ($1, $2, date_trunc('minute', now()), $3, 'remote', 'Remote · face scan', $4, $5, $6, $7) returning id`,
      [employeeId, date, kind, m, day.reason, s.accountId, s.name],
    );
    return punchJson((await c.query(`${PUNCH_SELECT} where id = $2`, [TZ, p.id])).rows[0]);
  });
}

// ---- Notices ----

export async function sendNotice(s: Session, body: any) {
  const employeeId = String(body?.employeeId ?? ""), kind = String(body?.kind ?? "");
  demand(s, "edit", "attendanceRecords", employeeId);
  const subject = String(body?.subject ?? "").trim(), message = String(body?.message ?? "").trim();
  const dates: string[] = Array.isArray(body?.dates) ? body.dates.map(String).filter((d: string) => DATE.test(d)) : [];
  if (kind !== "tardiness" && kind !== "awol") throw new UserError("Choose the kind of notice");
  if (!subject) throw new UserError("Give the notice a subject");
  if (!message) throw new UserError("Write the message the employee will read");
  return tx(async (c) => {
    await employee(c, employeeId);
    const { rows: [n] } = await c.query(
      `insert into attendance_notices (employee_id, notice_kind, subject, message, dates, sent_by, sent_by_name) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [employeeId, kind, subject, message, dates, s.accountId, s.name],
    );
    await log(c, s, employeeId, dates[0] ?? (await today(c)), `Sent ${kind === "awol" ? "AWOL" : "tardiness"} notice`, subject);
    return noticeJson(n);
  });
}

export async function acknowledgeNotice(s: Session, id: string) {
  const { rowCount } = await pool.query(
    `update attendance_notices set acknowledged_at = coalesce(acknowledged_at, now()) where id::text = $1 and employee_id = $2`,
    [id, s.employeeNo ?? ""],
  );
  if (!rowCount) throw new UserError("That notice no longer exists", 404);
}

// ---- Missed or wrong time-in / time-out ----

/** The time-in (earliest) or time-out (latest) still counting that day, "HH:MM". */
async function recordedTime(c: Db, employeeId: string, workDate: string, kind: string) {
  const { rows } = await c.query(
    `select to_char(punched_at at time zone $4, 'HH24:MI') as t from punches
      where employee_id = $1 and work_date = $2 and direction = $3 and voided_at is null
      order by punched_at ${kind === "in" ? "asc" : "desc"} limit 1`,
    [employeeId, workDate, kind, TZ],
  );
  return rows[0]?.t as string | undefined;
}

const CAUSES = ["not-recorded", "wrong-time", "system-error", "other"];

export async function fileFix(s: Session, body: any) {
  const input = {
    employeeId: String(body?.employeeId ?? ""), workDate: String(body?.workDate ?? ""), kind: String(body?.kind ?? ""), time: String(body?.time ?? ""),
    nextDay: !!body?.nextDay, cause: CAUSES.includes(body?.cause) ? String(body.cause) : "not-recorded", reason: String(body?.reason ?? "").trim(),
  };
  demand(s, "create", "attendanceRecords", input.employeeId);
  if (input.kind !== "in" && input.kind !== "out") throw new UserError("Choose time-in or time-out");
  if (!DATE.test(input.workDate)) throw new UserError("Choose the day");
  if (!HHMM.test(input.time)) throw new UserError("Enter the correct time");
  if (!input.reason) throw new UserError('Say what happened, for example "the scanner didn\'t read my finger"');
  return tx(async (c) => {
    await employee(c, input.employeeId);
    if (await inFuture(c, `${input.nextDay ? addDays(input.workDate, 1) : input.workDate}T${input.time}`)) throw new UserError("That time hasn't happened yet");
    if (input.workDate < addDays(await today(c), -30)) throw new UserError("Requests can only go back 30 days. Talk to HR for older records.");
    const recorded = await recordedTime(c, input.employeeId, input.workDate, input.kind);
    if (input.cause === "wrong-time" && !recorded) throw new UserError(`There's no time-${input.kind} on record that day. Choose "Biometrics didn't record it" instead.`);
    if (recorded === input.time && !input.nextDay) throw new UserError(`Your time-${input.kind} is already ${input.time} on record`);
    const dup = await c.query(`select 1 from punch_fix_requests where employee_id = $1 and work_date = $2 and direction = $3 and status = 'pending'`, [input.employeeId, input.workDate, input.kind]);
    if (dup.rowCount) throw new UserError(`You already asked to adjust the time-${input.kind} for that day`);
    const { rows: [r] } = await c.query(
      `insert into punch_fix_requests (employee_id, work_date, direction, requested_time, next_day, cause, recorded_time, reason, filed_by_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [input.employeeId, input.workDate, input.kind, input.time, input.nextDay, input.cause, recorded ?? null, input.reason, s.name],
    );
    await log(c, s, input.employeeId, input.workDate, `Asked to adjust time-${input.kind}`, `${recorded ? `${recorded} → ` : ""}${input.time}${input.nextDay ? " (next day)" : ""}: ${input.reason}`);
    return fixJson(r);
  });
}

/** Approving adds the punch exactly as if HR had added it; a wrong device time is set aside first. */
export async function decideFix(s: Session, id: string, approve: boolean, note: string) {
  return tx(async (c: pg.PoolClient) => {
    const r = (await c.query(`select * from punch_fix_requests where id::text = $1 for update`, [id])).rows[0];
    if (!r) throw new UserError("That request no longer exists", 404);
    demand(s, "approve", "attendanceRecords", r.employee_id);
    if (r.status !== "pending") throw new UserError("This request was already decided");
    if (!approve && !note.trim()) throw new UserError("Add a short note so the employee knows why");
    if (approve) {
      if (r.cause === "wrong-time") {
        const live = (await c.query(`${PUNCH_SELECT} where employee_id = $2 and work_date = $3 and direction = $4 and voided_at is null`, [TZ, r.employee_id, r.work_date, r.direction])).rows;
        for (const p of live) await setAside(c, s, p, `Wrong time from the device, replaced by an approved adjustment: ${r.reason}`);
      }
      await insertCorrection(c, s, { employeeId: r.employee_id, workDate: r.work_date, kind: r.direction, time: hhmm(r.requested_time)!, nextDay: r.next_day, reason: `Employee request: ${r.reason}` });
    }
    const { rows: [next] } = await c.query(
      `update punch_fix_requests set status = $2, decided_by = $3, decided_by_name = $4, decided_at = now(), decision_note = $5 where id = $1 returning *`,
      [r.id, approve ? "approved" : "declined", s.accountId, s.name, note.trim() || null],
    );
    if (!approve) await log(c, s, r.employee_id, r.work_date, `Declined time-${r.direction} adjustment`, note.trim());
    return fixJson(next);
  });
}

/** The built-in shifts, for the seed script. */
export async function seedShifts(c: Db) {
  for (const sh of DEFAULT_SHIFTS) {
    await c.query(
      `insert into shift_templates (id, name, start_time, end_time, break_minutes, break_start, grace_minutes, rest_days, is_flexible, required_hours, is_active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
      [sh.id, sh.name, sh.start, sh.end, sh.breakMinutes, sh.breakStart, sh.graceMinutes, sh.restDays, !!sh.flexible, sh.requiredHours ?? null, sh.active],
    );
  }
}
