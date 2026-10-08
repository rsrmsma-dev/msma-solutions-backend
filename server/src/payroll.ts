// Payroll: government contribution rate versions, and payroll runs (one per cutoff).
//
// Pay is worked out in the browser (src/lib/reports/api.ts + src/lib/pay/engine.ts)
// from attendance, leave and salary already loaded there. The server stores each
// run's lines, checks them, and owns the life cycle: a draft can be recomputed and
// adjusted; an approved run is locked and becomes the employees' payslips.

import { BUILT_IN_RATES, rateProblem } from "../../src/lib/pay/rateRules";
import type { Agency, RateVersion } from "../../src/lib/reports/statutory";
import { audit, demand, type Session } from "./auth";
import { pool, tx, UserError, type Db } from "./db";

const AGENCIES: Agency[] = ["sss", "philhealth", "pagibig", "bir"];
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? undefined);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = async (db: Db) => (await db.query(`select to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD') as d`)).rows[0].d as string;
const log = (db: Db, s: Session, action: string, target: string, detail = "") => audit(db, { actorId: s.accountId, actorName: s.name, module: "Payroll", action, target, detail });

// ---- Contribution rates ----

const versionJson = (r: any): RateVersion => ({ id: r.id, effectiveFrom: r.effective_from, source: r.source, rates: r.rates, savedBy: r.saved_by_name, savedAt: iso(r.saved_at)! });

/** Every agency's versions. Anyone signed in may read them: they're published government rates. */
export async function listRates() {
  const { rows } = await pool.query(`select * from contribution_rate_versions order by effective_from desc`);
  return Object.fromEntries(AGENCIES.map((a) => [a, rows.filter((r) => r.agency === a).map(versionJson)]));
}

export async function saveRates(s: Session, agency: string, body: any) {
  demand(s, "payroll", "edit");
  if (!AGENCIES.includes(agency as Agency)) throw new UserError("Unknown agency");
  const a = agency as Agency;
  const input = { effectiveFrom: String(body?.effectiveFrom ?? ""), source: String(body?.source ?? "").trim(), rates: body?.rates ?? {} };
  return tx(async (c) => {
    const existing = (await c.query(`select * from contribution_rate_versions where agency = $1`, [a])).rows.map(versionJson);
    const problem = rateProblem(a, input as never, existing as never, await today(c));
    if (problem) throw new UserError(problem);
    // A version with the same effective date is a correction before it applies: it replaces that one.
    const { rows: [v] } = await c.query(
      `insert into contribution_rate_versions (agency, effective_from, source, rates, saved_by, saved_by_name) values ($1,$2,$3,$4,$5,$6)
       on conflict (agency, effective_from) do update set source = excluded.source, rates = excluded.rates, saved_by = excluded.saved_by, saved_by_name = excluded.saved_by_name, saved_at = now()
       returning *`,
      [a, input.effectiveFrom, input.source, JSON.stringify(input.rates), s.accountId, s.name],
    );
    await log(c, s, `Saved ${a.toUpperCase()} rates`, a.toUpperCase(), `Effective ${input.effectiveFrom} · ${input.source}`);
    return versionJson(v);
  });
}

/** Removes a version that hasn't taken effect yet. Versions already in force stay on record. */
export async function deleteRates(s: Session, agency: string, id: string) {
  demand(s, "payroll", "edit");
  return tx(async (c) => {
    const v = (await c.query(`select * from contribution_rate_versions where agency = $1 and id::text = $2`, [agency, id])).rows[0];
    if (!v) throw new UserError("That version no longer exists", 404);
    const n = (await c.query(`select count(*)::int as n from contribution_rate_versions where agency = $1`, [agency])).rows[0].n;
    if (v.effective_from <= (await today(c)) || n === 1) throw new UserError("Rates already in force stay on record and can't be removed");
    await c.query(`delete from contribution_rate_versions where id = $1`, [v.id]);
    await log(c, s, `Removed upcoming ${agency.toUpperCase()} rates`, agency.toUpperCase(), `Effective ${v.effective_from} · ${v.source}`);
  });
}

export async function seedRates(c: Db) {
  for (const a of AGENCIES) {
    if ((await c.query(`select 1 from contribution_rate_versions where agency = $1 limit 1`, [a])).rowCount) continue;
    for (const v of BUILT_IN_RATES[a]) {
      await c.query(`insert into contribution_rate_versions (agency, effective_from, source, rates, saved_by_name) values ($1,$2,$3,$4,'Built in')`, [a, v.effectiveFrom, v.source, JSON.stringify(v.rates)]);
    }
  }
}

// ---- Payroll runs ----

/** The amounts stored in their own columns; the whole line (with how each was worked out) goes in `computation`. */
const AMOUNTS = [
  ["basic", "basic_pay"], ["deductions", "absence_deductions"], ["overtime", "overtime_pay"], ["premiums", "premium_pay"], ["gross", "gross_pay"],
  ["sssEe", "sss_ee"], ["sssEr", "sss_er"], ["ec", "sss_ec"], ["phEe", "philhealth_ee"], ["phEr", "philhealth_er"], ["piEe", "pagibig_ee"], ["piEr", "pagibig_er"],
  ["taxable", "taxable_income"], ["tax", "withholding_tax"], ["net", "net_pay"],
] as const;

async function runJson(db: Db, run: any) {
  const [lines, adjs] = await Promise.all([
    db.query(`select computation from payroll_run_lines where payroll_run_id = $1`, [run.id]),
    db.query(`select * from payroll_adjustments where payroll_run_id = $1 order by label`, [run.id]),
  ]);
  const adjustments: Record<string, unknown[]> = {};
  for (const a of adjs.rows) (adjustments[a.employee_id] ??= []).push({ id: a.id, label: a.label, amount: a.amount, taxable: a.is_taxable, reason: a.reason });
  return {
    id: run.id, label: run.label, from: run.period_from, to: run.period_to, status: run.status,
    lines: lines.rows.map((l) => l.computation).sort((a: any, b: any) => String(a.person?.name).localeCompare(String(b.person?.name))),
    adjustments, createdBy: run.created_by_name, createdAt: iso(run.created_at), computedAt: iso(run.computed_at),
    ...(run.approved_at ? { approvedBy: run.approved_by_name, approvedAt: iso(run.approved_at) } : {}),
  };
}

async function runRow(c: Db, id: string, forUpdate = false) {
  const r = (await c.query(`select * from payroll_runs where id::text = $1 ${forUpdate ? "for update" : ""}`, [id])).rows[0];
  if (!r) throw new UserError("That payroll run no longer exists", 404);
  return r;
}

/** Checks the lines the browser computed: real employees, once each, amounts that are numbers. */
async function checkLines(c: Db, lines: unknown) {
  if (!Array.isArray(lines)) throw new UserError("The payroll lines are missing. Refresh and try again.");
  const ids = new Set<string>();
  for (const l of lines as any[]) {
    const id = l?.person?.id;
    if (typeof id !== "string" || !id) throw new UserError("A payroll line has no employee");
    if (ids.has(id)) throw new UserError("An employee appears twice in the run");
    ids.add(id);
    for (const [k] of AMOUNTS) if (typeof l[k] !== "number" || !Number.isFinite(l[k])) throw new UserError("A payroll line has an amount that isn't a number. Refresh and try again.");
    if (l.gross < 0 || l.tax < 0) throw new UserError("A payroll line has a negative gross pay or tax. Refresh and try again.");
  }
  if (ids.size) {
    const found = (await c.query(`select employee_id from employees where employee_id = any($1)`, [[...ids]])).rows.length;
    if (found !== ids.size) throw new UserError("A payroll line is for an employee who no longer exists. Refresh and try again.");
  }
  return lines as any[];
}

/** Replaces a draft's lines. People with adjustments must stay in the run. */
async function saveLines(c: Db, runId: string, lines: any[]) {
  const ids = lines.map((l) => l.person.id as string);
  const kept = (await c.query(`select distinct employee_id from payroll_adjustments where payroll_run_id = $1 and not (employee_id = any($2))`, [runId, ids])).rows;
  if (kept.length) throw new UserError("Someone with a pay adjustment is missing from the run. Remove their adjustment first.");
  await c.query(`delete from payroll_run_lines where payroll_run_id = $1 and not (employee_id = any($2))`, [runId, ids]);
  for (const l of lines) {
    const cols = AMOUNTS.map(([, col]) => col);
    await c.query(
      `insert into payroll_run_lines (payroll_run_id, employee_id, ${cols.join(", ")}, computation) values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}, $${cols.length + 3})
       on conflict (payroll_run_id, employee_id) do update set ${cols.map((col) => `${col} = excluded.${col}`).join(", ")}, computation = excluded.computation`,
      [runId, l.person.id, ...AMOUNTS.map(([k]) => Math.round(l[k] * 100) / 100), JSON.stringify(l)],
    );
  }
  await c.query(`update payroll_runs set computed_at = now() where id = $1`, [runId]);
}

export async function listRuns(s: Session) {
  demand(s, "payroll", "view");
  const { rows } = await pool.query(`select * from payroll_runs order by period_from desc`);
  return Promise.all(rows.map((r) => runJson(pool, r)));
}

export async function getRun(s: Session, id: string) {
  demand(s, "payroll", "view");
  return runJson(pool, await runRow(pool, id));
}

export async function createRun(s: Session, body: any) {
  demand(s, "payroll", "edit");
  const label = String(body?.label ?? "").trim(), from = String(body?.from ?? ""), to = String(body?.to ?? "");
  if (!label || !DATE.test(from) || !DATE.test(to) || to < from) throw new UserError("Choose the cutoff");
  return tx(async (c) => {
    await c.query(`lock table payroll_runs in share row exclusive mode`);
    if ((await c.query(`select 1 from payroll_runs where period_from = $1 and period_to = $2`, [from, to])).rowCount) throw new UserError("There's already a payroll run for this cutoff");
    const lines = await checkLines(c, body?.lines);
    const { rows: [run] } = await c.query(
      `insert into payroll_runs (label, period_from, period_to, created_by, created_by_name) values ($1,$2,$3,$4,$5) returning *`,
      [label, from, to, s.accountId, s.name],
    );
    await saveLines(c, run.id, lines);
    await log(c, s, "Started payroll run", label, `${lines.length} employees`);
    return runJson(c, await runRow(c, run.id));
  });
}

async function draftRow(c: Db, id: string, lockedMessage: string) {
  const r = await runRow(c, id, true);
  if (r.status !== "draft") throw new UserError(lockedMessage);
  return r;
}

/** Recomputed from the latest attendance (in the browser). */
export async function refreshRun(s: Session, id: string, body: any) {
  demand(s, "payroll", "edit");
  return tx(async (c) => {
    const r = await draftRow(c, id, "This run is approved and locked");
    await saveLines(c, r.id, await checkLines(c, body?.lines));
    return runJson(c, await runRow(c, r.id));
  });
}

export async function addAdjustment(s: Session, id: string, body: any) {
  demand(s, "payroll", "edit");
  const employeeId = String(body?.employeeId ?? "");
  const label = String(body?.label ?? "").trim(), reason = String(body?.reason ?? "").trim();
  const amount = Math.round(Number(body?.amount) * 100) / 100;
  if (!label) throw new UserError('Name the adjustment, for example "Rice allowance" or "Salary loan"');
  if (!Number.isFinite(amount) || amount === 0) throw new UserError("Enter an amount: positive adds to pay, negative takes away");
  if (!reason) throw new UserError("Give the reason");
  return tx(async (c) => {
    const r = await draftRow(c, id, "This run is approved and locked. Add the correction to the next run.");
    const lines = await checkLines(c, body?.lines);
    if (!lines.some((l) => l.person.id === employeeId)) throw new UserError("That employee isn't in this run");
    await saveLines(c, r.id, lines);
    await c.query(
      `insert into payroll_adjustments (payroll_run_id, employee_id, label, amount, is_taxable, reason) values ($1,$2,$3,$4,$5,$6)`,
      [r.id, employeeId, label, amount, !!body?.taxable, reason],
    );
    await log(c, s, "Added pay adjustment", employeeId, `${r.label}: ${label} ₱${amount.toLocaleString("en-PH")} (${body?.taxable ? "taxable" : "non-taxable"}) · ${reason}`);
    return runJson(c, await runRow(c, r.id));
  });
}

export async function removeAdjustment(s: Session, id: string, adjustmentId: string, body: any) {
  demand(s, "payroll", "edit");
  return tx(async (c) => {
    const r = await draftRow(c, id, "This run is approved and locked");
    const { rowCount } = await c.query(`delete from payroll_adjustments where payroll_run_id = $1 and id::text = $2`, [r.id, adjustmentId]);
    if (!rowCount) throw new UserError("That adjustment no longer exists", 404);
    await saveLines(c, r.id, await checkLines(c, body?.lines));
    await log(c, s, "Removed pay adjustment", r.label);
    return runJson(c, await runRow(c, r.id));
  });
}

/** Locks the run with the numbers as computed now, and releases the payslips. */
export async function approveRun(s: Session, id: string, body: any) {
  demand(s, "payroll", "edit");
  return tx(async (c) => {
    const r = await draftRow(c, id, "This run is already approved");
    const lines = await checkLines(c, body?.lines);
    await saveLines(c, r.id, lines);
    await c.query(`update payroll_runs set status = 'approved', approved_by = $2, approved_by_name = $3, approved_at = now(), payslips_released_at = now() where id = $1`, [r.id, s.accountId, s.name]);
    const total = lines.reduce((n, l) => n + l.net, 0);
    await log(c, s, "Approved payroll run", r.label, `${lines.length} employees · take-home ₱${total.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    return runJson(c, await runRow(c, r.id));
  });
}

export async function deleteRun(s: Session, id: string) {
  demand(s, "payroll", "edit");
  return tx(async (c) => {
    const r = await draftRow(c, id, "Approved runs stay on record");
    await c.query(`delete from payroll_runs where id = $1`, [r.id]);
    await log(c, s, "Deleted draft payroll run", r.label);
  });
}

/** The signed-in employee's own payslips: their line in every approved run, newest first. */
export async function myPayslips(s: Session) {
  if (!s.employeeNo) return [];
  const { rows } = await pool.query(
    `select r.id, r.label, r.period_from, r.period_to, l.computation from payroll_runs r join payroll_run_lines l on l.payroll_run_id = r.id
      where r.status = 'approved' and l.employee_id = $1 order by r.period_from desc`,
    [s.employeeNo],
  );
  return rows.map((r) => ({ run: { id: r.id, label: r.label, from: r.period_from, to: r.period_to }, line: r.computation }));
}
