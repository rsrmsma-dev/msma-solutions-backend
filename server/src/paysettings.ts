// Payroll settings (Payroll > Pay details): the two paydays each cut-off closes on, and each
// employee's pay settings. Shapes follow src/lib/pay/settings.ts (PayRules, PayProfile); the website's
// engine works out cut-offs and pay from them.

import { audit, can, demand, scopeOf, type Session } from "./auth";
import { need027, pool, schema027, schema028, tx, UserError, type Db } from "./db";

type WorkWeek = "5-day" | "6-day";
interface PayProfile { workWeek: WorkWeek; transportAllowance: number; otMealRate: number; deMinimis: number; otherNonTaxable: number; clientShare: number; client: string; skipSss: boolean; skipPhilhealth: boolean; skipPagibig: boolean }

const DEFAULT_PAYDAYS: [number, number] = [10, 25];
const round2 = (n: number) => Math.round(n * 100) / 100;
const peso = (n: number) => `₱${n}`;

/** The paydays on file (10 and 25 until migration 027 is applied or the company row exists). */
export async function paydays(db: Db = pool): Promise<[number, number]> {
  if (!(await schema027(db))) return DEFAULT_PAYDAYS;
  const r = (await db.query(`select payday_first, payday_second from company_settings where id = 1`)).rows[0];
  return r ? [r.payday_first, r.payday_second] : DEFAULT_PAYDAYS;
}

/** Whoever runs payroll for everyone sees salaries, and so the pay settings (as corehr.ts does for basic_rate). */
const seesPay = (s: Session) => can(s, "view", "payrollRuns") && scopeOf(s, "view", "payrollRuns") === "all";

const profileJson = (r: any): PayProfile => ({
  workWeek: r.work_week, transportAllowance: r.transport_allowance, otMealRate: r.ot_meal_rate, deMinimis: r.de_minimis, otherNonTaxable: r.other_non_taxable,
  clientShare: r.client_share ?? 0, client: r.client ?? "", skipSss: !!r.skip_sss, skipPhilhealth: !!r.skip_philhealth, skipPagibig: !!r.skip_pagibig,
});

/** Paydays for everyone signed in (cut-off labels); pay settings only for those who see salaries. */
export async function getPaySettings(s: Session) {
  const cutoffDays = await paydays();
  const profiles: Record<string, PayProfile> = {};
  if (seesPay(s) && (await schema027())) {
    for (const r of (await pool.query(`select * from employee_pay_profiles`)).rows) profiles[r.employee_id] = profileJson(r);
  }
  return { cutoffDays, profiles };
}

export async function savePaydays(s: Session, body: any) {
  demand(s, "edit", "payrollRuns");
  const days = Array.isArray(body?.cutoffDays) ? body.cutoffDays : [];
  const [a, b] = [Math.round(Number(days[0])), Math.round(Number(days[1]))];
  if (days.length !== 2 || !Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1 || a > 31 || b > 31) throw new UserError("Paydays are days of the month, 1 to 31");
  if (a === b) throw new UserError("Pick two different paydays");
  if (Math.abs(a - b) < 7) throw new UserError("Paydays should be at least a week apart");
  const next: [number, number] = [Math.min(a, b), Math.max(a, b)];
  await need027();
  return tx(async (c) => {
    const { rowCount } = await c.query(`update company_settings set payday_first = $1, payday_second = $2, updated_at = now(), updated_by = $3 where id = 1`, [next[0], next[1], s.accountId]);
    if (!rowCount) throw new UserError("Save the company details in Settings > Organization first.");
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Payroll", action: "Changed paydays", target: "Cut-offs", detail: `Cut-offs now close on the ${next.join(" and ")} of each month` });
    return { cutoffDays: next };
  });
}

export async function savePayProfile(s: Session, employeeId: string, body: any) {
  demand(s, "edit", "payrollRuns", employeeId);
  const money = (v: unknown) => (v === undefined || v === null || v === "" ? 0 : Number(v));
  const next: PayProfile = {
    workWeek: body?.workWeek === "6-day" ? "6-day" : "5-day",
    transportAllowance: money(body?.transportAllowance), otMealRate: money(body?.otMealRate), deMinimis: money(body?.deMinimis), otherNonTaxable: money(body?.otherNonTaxable),
    clientShare: money(body?.clientShare), client: typeof body?.client === "string" ? body.client.trim().slice(0, 80) : "",
    skipSss: body?.skipSss === true, skipPhilhealth: body?.skipPhilhealth === true, skipPagibig: body?.skipPagibig === true,
  };
  if (!Number.isFinite(next.clientShare) || next.clientShare < 0 || next.clientShare > 100) throw new UserError("The share charged to a client is 0 to 100%");
  next.clientShare = round2(next.clientShare);
  if (!next.clientShare) next.client = "";
  const has028 = await schema028();
  if ((next.clientShare || next.skipSss || next.skipPhilhealth || next.skipPagibig) && !has028) throw new UserError("The database needs an update (migration 028) before this can be saved. Ask your administrator to apply it.", 503);
  const amounts = [next.transportAllowance, next.otMealRate, next.deMinimis, next.otherNonTaxable];
  if (amounts.some((n) => !Number.isFinite(n) || n < 0)) throw new UserError("Amounts can't be negative");
  if (amounts.some((n) => n > 9_999_999)) throw new UserError("That amount is too large");
  next.transportAllowance = round2(next.transportAllowance);
  next.otMealRate = round2(next.otMealRate);
  next.deMinimis = round2(next.deMinimis);
  next.otherNonTaxable = round2(next.otherNonTaxable);
  await need027();
  return tx(async (c) => {
    const e = (await c.query(`select first_name, last_name from employees where employee_id = $1`, [employeeId])).rows[0];
    if (!e) throw new UserError("That employee no longer exists", 404);
    await c.query(
      `insert into employee_pay_profiles (employee_id, work_week, transport_allowance, ot_meal_rate, de_minimis, other_non_taxable, updated_at, updated_by, updated_by_name)
       values ($1,$2,$3,$4,$5,$6, now(), $7, $8)
       on conflict (employee_id) do update set work_week = excluded.work_week, transport_allowance = excluded.transport_allowance, ot_meal_rate = excluded.ot_meal_rate,
         de_minimis = excluded.de_minimis, other_non_taxable = excluded.other_non_taxable, updated_at = now(), updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name`,
      [employeeId, next.workWeek, next.transportAllowance, next.otMealRate, next.deMinimis, next.otherNonTaxable, s.accountId, s.name],
    );
    if (has028) {
      await c.query(`update employee_pay_profiles set client_share = $2, client = $3, skip_sss = $4, skip_philhealth = $5, skip_pagibig = $6 where employee_id = $1`, [employeeId, next.clientShare, next.client, next.skipSss, next.skipPhilhealth, next.skipPagibig]);
    }
    await audit(c, {
      actorId: s.accountId, actorName: s.name, module: "Payroll", action: "Changed pay settings", target: `${e.first_name} ${e.last_name}`.trim(), employeeNo: employeeId,
      detail: `${next.workWeek} week · transport ${peso(next.transportAllowance)} · OT meal ${peso(next.otMealRate)} · de minimis ${peso(next.deMinimis)} · other non-taxable ${peso(next.otherNonTaxable)}${next.clientShare ? ` · ${next.clientShare}% charged to ${next.client || "a client"}` : ""}`,
    });
    return next;
  });
}
