// Final pay ("back pay") for someone leaving (ported from src/lib/pay/finalpay.ts). A case is opened
// when HR records a separation, or by Accounting. The figures are worked out in the browser (from
// attendance, leave, approved runs and loans already loaded there), like payroll lines; releasing
// stores them frozen, settles the loans and marks the approved reimbursements paid. The reason, the
// release reference and the released figures (they name loan numbers) are encrypted (crypto.ts).

import { SEPARATION_REASONS } from "../../src/lib/corehr/types.js";
import { audit, can, seen, type Session } from "./auth";
import { open, seal } from "./crypto";
import { clean, pool, tx, UserError, type Db } from "./db";
import { demandPayroll, paidByLoan, settleLoans } from "./loans";
import { tellAssigned, tellEmployees } from "./notify";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? undefined);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nameOf = (r: { first_name: string; last_name: string }) => `${r.first_name} ${r.last_name}`;

/** The released figures are stored encrypted, as one JSON string (a plain list from before passes through). */
const itemsOf = (stored: unknown) => (typeof stored === "string" ? JSON.parse(open(stored)) : stored);

const caseJson = (r: any) => clean({
  id: r.id, employeeId: r.employee_id, lastDay: r.last_day, reason: open(r.reason), openedBy: r.opened_by_name, openedAt: iso(r.opened_at),
  released: r.released_at ? { at: iso(r.released_at), by: r.released_by_name, reference: open(r.release_reference), items: itemsOf(r.release_items), total: r.release_total } : null,
});

/** One of the website's separation reasons. Releasing for someone HR separated without a case also allows "Separated". */
const validReason = (reason: string, orSeparated = false) => (SEPARATION_REASONS as readonly string[]).includes(reason) || (orSeparated && reason === "Separated");

/** Every case for those who run payroll; an employee only their own. */
export async function listCases(s: Session) {
  if (!can(s, "view", "payrollRuns")) throw new UserError("You don't have access to do that.", 403);
  const { rows } = await pool.query(`select * from final_pay_cases order by opened_at desc`);
  return seen(s, "payrollRuns", rows, (r) => r.employee_id).map(caseJson);
}

async function employee(db: Db, id: string) {
  return (await db.query(`select employee_id, first_name, last_name, date_hired, basic_rate from employees where employee_id = $1`, [id])).rows[0];
}

export async function openCase(s: Session, body: any) {
  demandPayroll(s, "create");
  const employeeId = String(body?.employeeId ?? ""), lastDay = String(body?.lastDay ?? ""), reason = String(body?.reason ?? "").trim();
  return tx(async (c) => {
    const e = await employee(c, employeeId);
    if (!e) throw new UserError("Choose the employee who is leaving");
    // Final pay is worked out from basic pay, so a record whose pay isn't filled in yet waits for it.
    if (e.basic_rate === null) throw new UserError(`Fill in ${nameOf(e)}'s basic pay on their profile first`);
    if (!DATE.test(lastDay)) throw new UserError("Enter their last day");
    if (lastDay < e.date_hired) throw new UserError("The last day can't be before they were hired");
    if (!validReason(reason)) throw new UserError("Choose why they're leaving");
    await c.query(`select pg_advisory_xact_lock(hashtext('final-pay:' || $1))`, [employeeId]);
    if ((await c.query(`select 1 from final_pay_cases where employee_id = $1`, [employeeId])).rowCount) throw new UserError(`${nameOf(e)} already has a final pay case`);
    const { rows: [r] } = await c.query(
      `insert into final_pay_cases (employee_id, last_day, reason, opened_by, opened_by_name) values ($1,$2,$3,$4,$5) returning *`,
      [employeeId, lastDay, seal(reason), s.accountId, s.name],
    );
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Payroll", action: "Opened final pay", target: nameOf(e), employeeNo: employeeId, detail: `Last day ${lastDay} · ${reason}` });
    return caseJson(r);
  });
}

export async function removeCase(s: Session, id: string) {
  demandPayroll(s, "delete");
  return tx(async (c) => {
    const r = (await c.query(`select * from final_pay_cases where id::text = $1 for update`, [id])).rows[0];
    if (!r) throw new UserError("That case no longer exists", 404);
    if (r.released_at) throw new UserError("Released final pay stays on record");
    await c.query(`delete from final_pay_cases where id = $1`, [r.id]);
    const e = await employee(c, r.employee_id);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Payroll", action: "Removed final pay", target: e ? nameOf(e) : r.employee_id, employeeNo: r.employee_id, detail: `Last day ${r.last_day}` });
  });
}

/** The released figures: a list of {label, detail, amount} adding up to the total. */
function checkItems(items: unknown, total: unknown) {
  if (!Array.isArray(items)) throw new UserError("The final pay figures are missing. Refresh and try again.");
  const out = items.map((i: any) => {
    const amount = Number(i?.amount);
    if (typeof i?.label !== "string" || !i.label.trim() || typeof i?.detail !== "string" || !Number.isFinite(amount)) throw new UserError("A final pay item isn't complete. Refresh and try again.");
    return { label: i.label, detail: i.detail, amount: round2(amount) };
  });
  const sum = round2(out.reduce((n, i) => n + i.amount, 0));
  if (typeof total !== "number" || Math.abs(sum - total) > 0.01) throw new UserError("The final pay total doesn't add up. Refresh and try again.");
  return { items: out, total: sum };
}

/** What the browser worked the figures out from: the claims it paid out and the loan balances it deducted. */
function checkBasis(basis: any) {
  const claimIds = Array.isArray(basis?.claimIds) ? basis.claimIds.map(String) : null;
  const loans = Array.isArray(basis?.loans) ? basis.loans.map((l: any) => ({ id: String(l?.id), balance: round2(Number(l?.balance)) })) : null;
  if (!claimIds || !loans || loans.some((l: { balance: number }) => !Number.isFinite(l.balance))) throw new UserError("The final pay figures are missing. Refresh and try again.");
  return { claimIds: claimIds as string[], loans: loans as { id: string; balance: number }[] };
}

const CHANGED = "These figures changed. Reopen final pay to see the latest.";

/** Locks the figures, closes the loans and marks the reimbursements paid. The final approval. */
export async function releaseCase(s: Session, body: any) {
  demandPayroll(s, "final");
  const employeeId = String(body?.employeeId ?? ""), reference = String(body?.reference ?? "").trim();
  if (!reference) throw new UserError("Enter the check or transfer reference");
  const { items, total } = checkItems(body?.items, body?.total);
  const basis = checkBasis(body?.basis);
  return tx(async (c) => {
    const e = await employee(c, employeeId);
    if (!e) throw new UserError("That employee no longer exists");
    if (e.basic_rate === null) throw new UserError(`Fill in ${nameOf(e)}'s basic pay on their profile first`);
    // The same lock payroll runs take, so a run can't pay the same claim or installment meanwhile.
    await c.query(`select pg_advisory_xact_lock(hashtext('payroll-automatic-items'))`);
    await c.query(`select pg_advisory_xact_lock(hashtext('final-pay:' || $1))`, [employeeId]);
    // The figures must come from the claims and loan balances the database holds now.
    const openClaims = (await c.query(`select id from reimbursement_claims where employee_id = $1 and status = 'approved' and paid_at is null`, [employeeId])).rows.map((r) => r.id as string);
    const paid = await paidByLoan(c);
    const openLoans = (await c.query(`select id, principal from loans where employee_id = $1 and status = 'active'`, [employeeId])).rows
      .map((l) => ({ id: l.id as string, balance: round2(Math.max(0, l.principal - (paid.get(l.id) ?? 0))) }))
      .filter((l) => l.balance > 0);
    const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
    if (!same(openClaims, basis.claimIds) || !same(openLoans.map((l) => `${l.id}:${l.balance.toFixed(2)}`), basis.loans.map((l) => `${l.id}:${l.balance.toFixed(2)}`))) {
      throw new UserError(CHANGED, 409);
    }
    let r = (await c.query(`select * from final_pay_cases where employee_id = $1 for update`, [employeeId])).rows[0];
    if (r?.released_at) throw new UserError("This final pay was already released");
    if (!r) {
      // Someone HR marked separated without a case yet: opened and released together.
      const lastDay = String(body?.lastDay ?? ""), reason = String(body?.reason ?? "").trim();
      if (!DATE.test(lastDay)) throw new UserError("Enter their last day");
      if (lastDay < e.date_hired) throw new UserError("The last day can't be before they were hired");
      if (!validReason(reason, true)) throw new UserError("Choose why they're leaving");
      r = (await c.query(
        `insert into final_pay_cases (employee_id, last_day, reason, opened_by, opened_by_name) values ($1,$2,$3,$4,$5) returning *`,
        [employeeId, lastDay, seal(reason), s.accountId, s.name],
      )).rows[0];
    }
    const { rows: [next] } = await c.query(
      `update final_pay_cases set released_at = now(), released_by = $2, released_by_name = $3, release_reference = $4, release_items = $5, release_total = $6 where id = $1 returning *`,
      [r.id, s.accountId, s.name, seal(reference), JSON.stringify(seal(JSON.stringify(items))), total],
    );
    // Only the loans and claims these figures include.
    await settleLoans(c, s, employeeId, openLoans.map((l) => l.id));
    if (openClaims.length) {
      await c.query(
        `update reimbursement_claims set paid_at = now(), paid_by = $2, paid_by_name = $3, payout_method = 'final pay', payout_reference = $4 where id = any($1::uuid[]) and paid_at is null`,
        [openClaims, s.accountId, s.name, seal("Final pay")],
      );
    }
    // The reference stays out of the trail (it's encrypted in the table).
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Payroll", action: "Released final pay", target: nameOf(e), employeeNo: employeeId, detail: money(total) });
    await tellEmployees(c, s, employeeId, "payslip", "approved", "Your final pay was released", `${money(total)} · reference ${reference}.`);
    await tellAssigned(c, s, "edit", "people", "separation", "update", `Final pay released for ${nameOf(e)}`, `${money(total)} by ${s.name} (${reference}).`);
    return caseJson(next);
  });
}

// ---- Called when HR records or cancels a separation (corehr.ts) ----

/** Opens (or updates the last day of) someone's unreleased case. */
export async function ensureCase(c: Db, s: Session, employeeId: string, lastDay: string, reason: string) {
  const r = (await c.query(`select * from final_pay_cases where employee_id = $1 for update`, [employeeId])).rows[0];
  if (r?.released_at) return;
  // No basic pay on file yet: no final pay to work out until it's filled in.
  if (!r && (await c.query(`select 1 from employees where employee_id = $1 and basic_rate is null`, [employeeId])).rowCount) return;
  if (r) await c.query(`update final_pay_cases set last_day = $2, reason = $3 where id = $1`, [r.id, lastDay, seal(reason)]);
  else await c.query(`insert into final_pay_cases (employee_id, last_day, reason, opened_by, opened_by_name) values ($1,$2,$3,$4,$5)`, [employeeId, lastDay, seal(reason), s.accountId, s.name]);
}

/** Drops an unreleased case, when HR cancels a separation. */
export async function dropCase(c: Db, employeeId: string) {
  await c.query(`delete from final_pay_cases where employee_id = $1 and released_at is null`, [employeeId]);
}
