// Payroll → Loans & deductions: SSS and Pag-IBIG loans, cash advances and company loans, deducted
// from every payroll run until paid (ported from src/lib/pay/loans.ts). Accounting manages them;
// employees may only see their own. The loan number and the note are encrypted (crypto.ts).
//
// Each run's loan installments and the approved reimbursements it pays out are worked out here too
// (automaticItems), the same way the website does in src/lib/pay/runs.ts, so a run can only be saved
// with the figures the database holds.

import { LOAN_KINDS, type LoanKind } from "../../src/lib/pay/loanStore";
import { claimType, type Category } from "../../src/lib/reimbursements/store";
import { audit, can, scopeOf, seen, type Session } from "./auth";
import { open, seal } from "./crypto";
import { clean, pool, tx, UserError, type Db } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? undefined);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nameOf = (r: { first_name: string; last_name: string }) => `${r.first_name} ${r.last_name}`;

/**
 * Changing loans and final pay is for those who run everyone's payroll (Accounting, Super Admin).
 * An employee's "own" payroll access lets them see their payslips, never add their own loan or case.
 */
export function demandPayroll(s: Session, action: "create" | "edit" | "delete" | "final") {
  if (scopeOf(s, action, "payrollRuns") !== "all") throw new UserError("You don't have access to do that.", 403);
}

/** What approved runs (other than this one) have already taken for each loan. */
export async function paidByLoan(db: Db, exceptRunId?: string): Promise<Map<string, number>> {
  const { rows } = await db.query(
    `select a.loan_id, sum(abs(a.amount)) as paid from payroll_adjustments a join payroll_runs r on r.id = a.payroll_run_id
      where a.is_automatic and a.loan_id is not null and r.status = 'approved' and ($1::uuid is null or r.id <> $1::uuid)
      group by a.loan_id`,
    [exceptRunId ?? null],
  );
  return new Map(rows.map((r) => [r.loan_id as string, Number(r.paid)]));
}

const loanJson = (r: any, paid: number) => clean({
  id: r.id, employeeId: r.employee_id, kind: r.kind, reference: open(r.reference), principal: r.principal, installment: r.installment,
  startDate: r.start_date, status: r.status, note: open(r.note) || null, createdBy: r.created_by_name, createdAt: iso(r.created_at),
  closedBy: r.closed_by_name, closedAt: iso(r.closed_at),
  /** Taken by approved payroll runs so far (the website works out the balance from it). */
  paid: round2(paid),
});

/** Everyone's loans for those who run payroll; an employee only their own. */
export async function listLoans(s: Session) {
  if (!can(s, "view", "payrollRuns")) throw new UserError("You don't have access to do that.", 403);
  const [{ rows }, paid] = await Promise.all([pool.query(`select * from loans order by created_at desc`), paidByLoan(pool)]);
  return seen(s, "payrollRuns", rows, (r) => r.employee_id).map((r) => loanJson(r, paid.get(r.id) ?? 0));
}

export async function saveLoan(s: Session, id: string | undefined, body: any) {
  demandPayroll(s, id ? "edit" : "create");
  const input = {
    employeeId: String(body?.employeeId ?? ""),
    kind: String(body?.kind ?? "") as LoanKind | "",
    reference: String(body?.reference ?? "").trim(),
    principal: round2(Number(body?.principal)),
    installment: round2(Number(body?.installment)),
    startDate: String(body?.startDate ?? ""),
    note: String(body?.note ?? "").trim(),
  };
  return tx(async (c) => {
    const e = (await c.query(`select employee_id, first_name, last_name, record_status from employees where employee_id = $1`, [input.employeeId])).rows[0];
    if (!e || e.record_status === "SEPARATED") throw new UserError("Choose a current employee");
    if (!input.kind || !LOAN_KINDS.includes(input.kind)) throw new UserError("Choose the kind of loan or deduction");
    if (!input.reference) throw new UserError(input.kind === "Other deduction" ? "Say what the deduction is for" : "Enter the loan or reference number");
    if (!(input.principal > 0)) throw new UserError("Enter the total amount to deduct");
    if (!(input.installment > 0)) throw new UserError("Enter how much to deduct each cutoff");
    if (input.installment > input.principal) throw new UserError("The amount per cutoff can't be more than the total");
    if (!DATE.test(input.startDate)) throw new UserError("Choose the first cutoff to deduct from");
    let row;
    if (id) {
      const old = (await c.query(`select * from loans where id::text = $1 for update`, [id])).rows[0];
      if (!old) throw new UserError("That loan no longer exists", 404);
      if (old.status !== "active") throw new UserError("This loan is closed");
      const paid = (await paidByLoan(c)).get(old.id) ?? 0;
      if (paid > 0 && input.employeeId !== old.employee_id) throw new UserError("Installments were already taken from this employee's pay, so the loan can't move to someone else");
      if (input.principal < paid) throw new UserError(`₱${paid.toLocaleString("en-PH")} is already paid, so the total can't be less than that`);
      row = (await c.query(
        `update loans set employee_id = $2, kind = $3, reference = $4, principal = $5, installment = $6, start_date = $7, note = $8 where id = $1 returning *`,
        [old.id, input.employeeId, input.kind, seal(input.reference), input.principal, input.installment, input.startDate, seal(input.note)],
      )).rows[0];
    } else {
      row = (await c.query(
        `insert into loans (employee_id, kind, reference, principal, installment, start_date, note, created_by, created_by_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [input.employeeId, input.kind, seal(input.reference), input.principal, input.installment, input.startDate, seal(input.note), s.accountId, s.name],
      )).rows[0];
    }
    // The loan number stays out of the trail (it's encrypted in the table).
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Payroll", action: id ? "Changed loan" : "Added loan", target: nameOf(e), employeeNo: e.employee_id,
      detail: `${input.kind}: ₱${input.principal.toLocaleString("en-PH")}, ₱${input.installment.toLocaleString("en-PH")} per cutoff from ${input.startDate}` });
    return loanJson(row, (await paidByLoan(c)).get(row.id) ?? 0);
  });
}

/** Stops deductions, e.g. when the balance was paid outside payroll. */
export async function stopLoan(s: Session, id: string, reason: string) {
  demandPayroll(s, "edit");
  return tx(async (c) => {
    const l = (await c.query(`select l.*, e.first_name, e.last_name from loans l join employees e on e.employee_id = l.employee_id where l.id::text = $1 for update of l`, [id])).rows[0];
    if (!l) throw new UserError("That loan no longer exists", 404);
    if (l.status !== "active") throw new UserError("This loan is already closed");
    if (!reason.trim()) throw new UserError("Say why the deductions stop");
    await c.query(`update loans set status = 'stopped', closed_by = $2, closed_by_name = $3, closed_at = now(), note = $4 where id = $1`, [l.id, s.accountId, s.name, seal(reason.trim())]);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Payroll", action: "Stopped loan deductions", target: nameOf(l), employeeNo: l.employee_id, detail: l.kind });
  });
}

/** Final pay closes these loans of someone's (their balance is deducted there). */
export async function settleLoans(c: Db, s: Session, employeeId: string, loanIds: string[]) {
  if (!loanIds.length) return;
  await c.query(
    `update loans set status = 'settled', closed_by = $2, closed_by_name = $3, closed_at = now(), note = $4 where employee_id = $1 and status = 'active' and id = any($5::uuid[])`,
    [employeeId, s.accountId, s.name, seal("Balance deducted from final pay"), loanIds],
  );
}

// ---- What payroll adds by itself ----

export interface AutoItem {
  id: string;
  label: string;
  amount: number;
  taxable: false;
  reason: string;
  loanId?: string;
  claimId?: string;
}

/**
 * Loan installments due this cutoff and approved reimbursements not paid out yet, per employee on
 * the run: the website's autoAdjustments (src/lib/pay/runs.ts) from the database.
 */
export async function automaticItems(c: Db, run: { id?: string; to: string }, onRun: Set<string>): Promise<Record<string, AutoItem[]>> {
  const out: Record<string, AutoItem[]> = {};
  const add = (employeeId: string, a: AutoItem) => {
    if (onRun.has(employeeId)) (out[employeeId] ??= []).push(a);
  };
  const paid = await paidByLoan(c, run.id);
  const loans = (await c.query(`select * from loans where status = 'active' and start_date <= $1 order by created_at desc`, [run.to])).rows;
  for (const l of loans) {
    const balance = round2(l.principal - (paid.get(l.id) ?? 0));
    if (balance <= 0) continue;
    const amount = Math.min(l.installment, balance);
    add(l.employee_id, { id: `loan-${l.id}`, label: l.kind, amount: -amount, taxable: false, reason: `${open(l.reference)} · balance ${money(balance - amount)} after this`, loanId: l.id });
  }
  const claims = (await c.query(`select * from reimbursement_claims where status = 'approved' and paid_at is null order by filed_at desc`)).rows;
  for (const r of claims) {
    add(r.employee_id, { id: `claim-${r.id}`, label: `Reimbursement: ${claimType({ category: r.category as Category, otherType: r.other_type ?? undefined })}`, amount: r.amount, taxable: false, reason: r.merchant, claimId: r.id });
  }
  return out;
}

/** The website worked out pay with the same loan installments and reimbursements, or it's out of date. */
export function sameItems(expected: Record<string, AutoItem[]>, sent: unknown) {
  const given = (sent && typeof sent === "object" ? sent : {}) as Record<string, { id?: unknown; amount?: unknown }[]>;
  const key = (list: { id?: unknown; amount?: unknown }[] | undefined) =>
    (Array.isArray(list) ? list : []).map((a) => `${String(a?.id)}:${Math.round(Number(a?.amount) * 100)}`).sort().join("|");
  for (const id of new Set([...Object.keys(expected), ...Object.keys(given)])) {
    if (key(expected[id]) !== key(given[id])) {
      throw new UserError("Loans or reimbursements changed since this pay was worked out. Refresh and try again.", 409);
    }
  }
}

/** Replaces a draft run's automatic items. The loan number in the reason is encrypted. */
export async function storeAutomatic(c: Db, runId: string, items: Record<string, AutoItem[]>) {
  for (const [employeeId, list] of Object.entries(items)) {
    for (const a of list) {
      await c.query(
        `insert into payroll_adjustments (payroll_run_id, employee_id, label, amount, is_taxable, reason, reimbursement_claim_id, loan_id, is_automatic) values ($1,$2,$3,$4,false,$5,$6,$7,true)`,
        [runId, employeeId, a.label, a.amount, seal(a.reason), a.claimId ?? null, a.loanId ?? null],
      );
    }
  }
}
