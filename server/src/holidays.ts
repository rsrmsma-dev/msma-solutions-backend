// Holiday calendar: the holidays HR adds (proclaimed, local to some offices, company holidays from
// Settings) and one-year moves and cancellations from proclamations. The national and movable
// holidays are built into src/lib/holidays.ts, the same file the browser uses, so the server counts
// exactly the holidays the website shows.

import { BUILT_IN_RULES, dateOf, holidaysFrom, holidayYears, type Holiday, type HolidayChange, type HolidayRule, type HolidayType, type SavedHolidays } from "../../src/lib/holidays";
import { audit, can, type Session } from "./auth";
import { need019, pool, schema019, tx, UserError, type Db } from "./db";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = process.env.APP_TIME_ZONE ?? "Asia/Manila";
/** This year in the company's timezone, not the server's. */
const thisYear = () => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" }).format(new Date()));
const validYear = (y: number) => Number.isInteger(y) && y >= 1900 && y <= 2200;
const COMPANY = "Company";
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ""));
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function ruleJson(r: any): HolidayRule {
  return {
    id: r.id, name: r.name, type: r.holiday_type,
    repeat: r.repeat_kind === "fixed" ? { kind: "fixed", month: r.repeat_month, day: r.repeat_day } : { kind: "once", date: r.once_date },
    offices: r.offices ?? [], source: r.source, builtIn: false, active: true,
  };
}

const changeJson = (c: any): HolidayChange => ({
  id: c.id, ruleId: c.builtin_rule_id ?? c.holiday_rule_id, year: c.year, kind: c.change_kind,
  ...(c.new_date ? { date: c.new_date } : {}), source: c.source, by: c.changed_by_name, at: iso(c.changed_at),
});

/** HR's holidays and the one-year changes, in the browser's shapes (built-ins not included). */
export async function loadSaved(db: Db = pool): Promise<SavedHolidays> {
  // Before migration 019: only the built-in holidays, as before.
  if (!(await schema019(db))) return { rules: [], changes: [] };
  const rules = await db.query(
    `select h.*, coalesce(array_agg(u.name order by u.name) filter (where u.name is not null), '{}') as offices
       from holiday_rules h left join holiday_rule_branches b on b.holiday_rule_id = h.id left join org_units u on u.id = b.branch_id
      group by h.id order by h.created_at`,
  );
  const changes = await db.query(`select * from holiday_changes order by changed_at`);
  return { rules: rules.rows.map(ruleJson), changes: changes.rows.map(changeJson) };
}

/** Every holiday from last year to next year, as the website's HOLIDAYS list has them. */
export async function companyHolidays(db: Db = pool): Promise<Holiday[]> {
  const saved = await loadSaved(db);
  const all = { rules: [...BUILT_IN_RULES, ...saved.rules], changes: saved.changes };
  return holidayYears(thisYear()).flatMap((y) => holidaysFrom(all, y));
}

/** Anyone signed in: attendance, leave and payroll all need the calendar. */
export const listHolidays = () => loadSaved();

/** The Holiday calendar is attendance setup; company holidays can also be added from Settings > Time off & leave. */
function demandEdit(s: Session, company: boolean) {
  if (can(s, "edit", "attendanceSettings") || (company && can(s, "edit", "rules"))) return;
  throw new UserError("You don't have access to do that.", 403);
}

const log = (db: Db, s: Session, action: string, detail: string) =>
  audit(db, { actorId: s.accountId, actorName: s.name, module: "Timekeeping", action, target: "Holiday calendar", detail });

/** Built-in rule by id, or HR's rule from the database. */
async function findRule(db: Db, id: string): Promise<{ rule: HolidayRule; builtIn: boolean } | undefined> {
  const b = BUILT_IN_RULES.find((r) => r.id === id);
  if (b) return { rule: b, builtIn: true };
  if (!isUuid(id)) return undefined;
  const saved = await loadSaved(db);
  const r = saved.rules.find((x) => x.id === id);
  return r && { rule: r, builtIn: false };
}

export async function addHoliday(s: Session, body: any) {
  const name = String(body?.name ?? "").trim();
  const type: HolidayType = body?.type === "special" ? "special" : "regular";
  const date = String(body?.date ?? "");
  const everyYear = body?.everyYear === true;
  const source = String(body?.source ?? "").trim();
  const offices: string[] = Array.isArray(body?.offices) ? [...new Set<string>(body.offices.map(String))] : [];
  const company = source === COMPANY && !everyYear && !offices.length;
  demandEdit(s, company);
  if (body?.type !== "regular" && body?.type !== "special") throw new UserError("Choose regular or special");
  if (!name) throw new UserError("Name the holiday");
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new UserError("Choose the date");
  if (!source) throw new UserError("Name the source, for example the proclamation number or the city ordinance");
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  await need019();
  return tx(async (c) => {
    await c.query(`select pg_advisory_xact_lock(hashtext('holidays'))`);
    const saved = await loadSaved(c);
    const all = { rules: [...BUILT_IN_RULES, ...saved.rules], changes: saved.changes };
    if (holidaysFrom(all, y).some((h) => h.date === date && h.name.toLowerCase() === name.toLowerCase())) throw new UserError("That holiday is already on the calendar for that date");
    if (company && saved.rules.some((r) => r.source === COMPANY && r.repeat.kind === "once" && r.repeat.date === date)) throw new UserError("There's already a company holiday on that date.");
    const branches = offices.length ? (await c.query(`select id, name from org_units where unit_type = 'branch' and name = any($1)`, [offices])).rows : [];
    if (branches.length !== offices.length) throw new UserError("One of those offices doesn't exist");
    const { rows: [r] } = await c.query(
      `insert into holiday_rules (name, holiday_type, repeat_kind, repeat_month, repeat_day, once_date, source, created_by, created_by_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [name, type, everyYear ? "fixed" : "once", everyYear ? m : null, everyYear ? d : null, everyYear ? null : date, source, s.accountId, s.name],
    );
    for (const b of branches) await c.query(`insert into holiday_rule_branches (holiday_rule_id, branch_id) values ($1, $2)`, [r.id, b.id]);
    await log(c, s, "Added a holiday", `${name} (${date}${everyYear ? ", every year" : ""}; ${type}${offices.length ? `; ${offices.join(", ")}` : ""}; ${source})`);
    return (await loadSaved(c)).rules.find((x) => x.id === r.id)!;
  });
}

export async function removeHoliday(s: Session, id: string) {
  if (BUILT_IN_RULES.some((r) => r.id === id)) {
    demandEdit(s, false);
    throw new UserError("National holidays can't be deleted. Cancel it for one year instead, if a proclamation says so.");
  }
  await need019();
  return tx(async (c) => {
    const r = isUuid(id) ? (await c.query(`select * from holiday_rules where id = $1 for update`, [id])).rows[0] : undefined;
    demandEdit(s, r?.source === COMPANY && r?.repeat_kind === "once");
    if (!r) throw new UserError("That holiday no longer exists", 404);
    // Its offices and one-year changes go with it (ON DELETE CASCADE).
    await c.query(`delete from holiday_rules where id = $1`, [r.id]);
    await log(c, s, "Removed a holiday", `${r.name} (${r.once_date ?? `every year, ${r.repeat_month}/${r.repeat_day}`})`);
  });
}

/** Move a holiday to another date, or cancel it, for one year only (replaces an earlier change that year). */
export async function changeForYear(s: Session, body: any) {
  demandEdit(s, false);
  const ruleId = String(body?.ruleId ?? "");
  const year = Number(body?.year);
  const kind = body?.kind === "move" ? "move" : body?.kind === "cancel" ? "cancel" : null;
  const source = String(body?.source ?? "").trim();
  const date = kind === "move" ? String(body?.date ?? "") : undefined;
  if (!kind) throw new UserError("Choose move or cancel");
  if (!validYear(year)) throw new UserError("Choose the year");
  await need019();
  return tx(async (c) => {
    await c.query(`select pg_advisory_xact_lock(hashtext('holidays'))`);
    const found = await findRule(c, ruleId);
    if (!found) throw new UserError("That holiday no longer exists");
    if (!source) throw new UserError("Name the proclamation that changes it");
    if (kind === "move") {
      if (!date || !DATE.test(date) || !date.startsWith(`${year}-`) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new UserError(`Choose the new date in ${year}`);
      if (date === dateOf(found.rule, year)) throw new UserError("That's already its date");
    }
    const col = found.builtIn ? "builtin_rule_id" : "holiday_rule_id";
    await c.query(`delete from holiday_changes where ${col} = $1 and year = $2`, [ruleId, year]);
    const { rows: [row] } = await c.query(
      `insert into holiday_changes (${col}, year, change_kind, new_date, source, changed_by, changed_by_name) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [ruleId, year, kind, date ?? null, source, s.accountId, s.name],
    );
    await log(c, s, kind === "move" ? "Moved a holiday" : "Cancelled a holiday", `${found.rule.name} ${year}${date ? ` → ${date}` : ""} (${source})`);
    return changeJson(row);
  });
}

/** Put a holiday back on its usual date for that year. */
export async function undoChange(s: Session, ruleId: string, year: number) {
  demandEdit(s, false);
  if (!validYear(year)) throw new UserError("Choose the year");
  await need019();
  return tx(async (c) => {
    const found = await findRule(c, ruleId);
    if (!found) return;
    const col = found.builtIn ? "builtin_rule_id" : "holiday_rule_id";
    const { rowCount } = await c.query(`delete from holiday_changes where ${col} = $1 and year = $2`, [ruleId, year]);
    if (rowCount) await log(c, s, "Put a holiday back on its usual date", `${found.rule.name} ${year}`);
  });
}
