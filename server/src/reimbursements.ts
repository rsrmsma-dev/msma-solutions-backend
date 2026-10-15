// Reimbursements: expense claims with a receipt photo. Checks come from the shared
// src/lib/reimbursements/rules.ts. Two steps: the employee's approver endorses (or rejects),
// then Accounting gives the final approval. HR doesn't see claims. Receipt photos are kept
// in the files table and served by /api/files/:id only to those who may see the claim.

import { createHash } from "node:crypto";
import { claimProblems, type ClaimInput } from "../../src/lib/reimbursements/rules";
import { CATEGORIES } from "../../src/lib/reimbursements/store";
import { audit, can, demand, seen, type Session } from "./auth";
import { clean, need024, pool, schema020, schema024, tx, UserError, type Db } from "./db";
import { open, openBytes, seal, sealBytes } from "./crypto";
import { peso, tellApprover, tellAssigned, tellEmployees, who } from "./notify";

/** "Meals", or the type written in for Other. */
const what = (r: any) => (r.category === "Other" ? (r.other_type ?? "Other") : r.category);

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? undefined);
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

const claimJson = (r: any) => clean({
  id: r.id, employeeId: r.employee_id, category: r.category, otherType: r.other_type, merchant: r.merchant, purchaseDate: r.purchase_date,
  amount: r.amount, description: r.description, receipt: `/api/files/${r.receipt_file_id}`, status: r.status, filedAt: iso(r.filed_at),
  decidedBy: r.decided_by_name, decidedAt: iso(r.decided_at), note: r.decision_note,
  approverDecidedBy: r.approver_decided_by_name, approverDecidedAt: iso(r.approver_decided_at), approverNote: r.approver_note,
  paidAt: iso(r.paid_at), paidBy: r.paid_by_name, payoutMethod: r.release_method ?? r.payout_method, payoutRef: r.payout_reference ? open(r.payout_reference) : null,
});

/** The claims they may see: their own, their team's (approvers), or everyone's (Accounting, Super Admin). */
export async function listClaims(s: Session) {
  const { rows } = await pool.query(`select * from reimbursement_claims order by filed_at desc`);
  return seen(s, "claims", rows, (r) => r.employee_id).map(claimJson);
}

/** "data:image/jpeg;base64,..." -> bytes, only for photos. */
function decodeReceipt(dataUrl: unknown) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
  if (!m) throw new UserError("Add a photo of the receipt (JPG, PNG or WebP)");
  const bytes = Buffer.from(m[2]!, "base64");
  if (!bytes.length) throw new UserError("Add a photo of the receipt");
  if (bytes.length > MAX_RECEIPT_BYTES) throw new UserError("That receipt photo is too large. Try a smaller or cropped photo.");
  return { contentType: m[1]!, bytes };
}

export async function fileClaim(s: Session, body: any) {
  if (!s.employeeNo) throw new UserError("Your sign-in isn't linked to an employee record. Ask HR to link it.");
  demand(s, "create", "claims", s.employeeNo);
  const input: ClaimInput = {
    employeeId: s.employeeNo,
    category: (CATEGORIES as readonly string[]).includes(body?.category) ? body.category : "",
    otherType: body?.otherType === undefined ? undefined : String(body.otherType),
    merchant: String(body?.merchant ?? ""), purchaseDate: String(body?.purchaseDate ?? ""),
    amount: Number(body?.amount), description: String(body?.description ?? ""), receipt: String(body?.receipt ?? ""),
  };
  const receipt = decodeReceipt(input.receipt);
  return tx(async (c) => {
    await c.query(`select pg_advisory_xact_lock(hashtext('claim:' || $1))`, [input.employeeId]);
    const mine = (await c.query(`select employee_id, status, purchase_date, amount, merchant from reimbursement_claims where employee_id = $1`, [input.employeeId])).rows
      .map((r) => ({ employeeId: r.employee_id, status: r.status, purchaseDate: r.purchase_date, amount: r.amount, merchant: r.merchant }));
    const problem = Object.values(claimProblems(input, mine))[0];
    if (problem) throw new UserError(problem);
    const sha = createHash("sha256").update(receipt.bytes).digest("hex");
    const { rows: [f] } = await c.query(
      `insert into files (storage_key, file_name, content_type, size_bytes, sha256, uploaded_by, content) values ('db:' || gen_random_uuid(), $6, $1, $2, $3, $4, $5) returning id`,
      [receipt.contentType, receipt.bytes.length, sha, s.accountId, sealBytes(receipt.bytes), seal("receipt")],
    );
    const { rows: [r] } = await c.query(
      `insert into reimbursement_claims (employee_id, category, other_type, merchant, purchase_date, amount, description, receipt_file_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [input.employeeId, input.category, input.category === "Other" ? input.otherType!.trim() : null, input.merchant.trim(), input.purchaseDate,
        Math.round(input.amount * 100) / 100, input.description.trim(), f.id],
    );
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Reimbursements", action: "Filed claim", target: input.merchant.trim(), employeeNo: input.employeeId, detail: `₱${r.amount.toLocaleString("en-PH")} · ${input.purchaseDate}` });
    await tellApprover(c, s, r.employee_id, "claim", "request", `${await who(c, r.employee_id)} filed a ${what(r)} claim`, `${peso(r.amount)} at ${r.merchant}. Review it under Approvals.`);
    return claimJson(r);
  });
}

/**
 * One approval step. A waiting claim goes to the employee's approver (Approve, team): yes endorses it
 * to Accounting, no rejects it. An endorsed claim gets Accounting's final decision (Final Approve).
 */
export async function decideClaim(s: Session, id: string, approve: boolean, note: string) {
  return tx(async (c) => {
    const r = (await c.query(`select * from reimbursement_claims where id::text = $1 for update`, [id])).rows[0];
    if (!r) throw new UserError("That claim no longer exists", 404);
    if (r.status !== "pending" && r.status !== "endorsed") throw new UserError("This claim was already decided");
    const step = r.status === "pending" ? "approve" : "final";
    demand(s, step, "claims", r.employee_id);
    if (!approve && !note.trim()) throw new UserError("Say why, so the employee knows");
    const why = note.trim() || null;
    const { rows: [next] } = step === "approve"
      ? await c.query(
          `update reimbursement_claims set status = $2, approver_decided_by = $3::uuid, approver_decided_by_name = $4::text, approver_decided_at = now(), approver_note = $5::text,
                  decided_by = case when $6::boolean then null else $3::uuid end, decided_by_name = case when $6::boolean then null else $4::text end,
                  decided_at = case when $6::boolean then null else now() end, decision_note = case when $6::boolean then null else $5::text end
            where id = $1 returning *`,
          [r.id, approve ? "endorsed" : "rejected", s.accountId, s.name, why, approve],
        )
      : await c.query(
          `update reimbursement_claims set status = $2, decided_by = $3, decided_by_name = $4, decided_at = now(), decision_note = $5 where id = $1 returning *`,
          [r.id, approve ? "approved" : "rejected", s.accountId, s.name, why],
        );
    const action = step === "approve" ? (approve ? "Endorsed claim" : "Rejected claim") : approve ? "Approved claim" : "Rejected claim";
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Reimbursements", action, target: r.merchant, employeeNo: r.employee_id, detail: `₱${r.amount.toLocaleString("en-PH")}${why ? `: ${why}` : ""}` });
    const label = `${what(next)} claim (${peso(next.amount)})`;
    if (next.status === "endorsed") {
      await tellEmployees(c, s, next.employee_id, "claim", "update", `Your ${label} was endorsed`, `${s.name} endorsed it. Accounting gives the final approval next.`);
      await tellAssigned(c, s, "final", "claims", "claim", "request", `${await who(c, next.employee_id)}'s ${label} is ready for final approval`, `Endorsed by ${s.name}. ${next.merchant}.`);
    } else if (next.status === "approved") {
      await tellEmployees(c, s, next.employee_id, "claim", "approved", `Your ${label} was approved`, `${s.name} approved it. It's paid with the next payroll or by bank transfer.`);
    } else {
      await tellEmployees(c, s, next.employee_id, "claim", "rejected", `Your ${label} was rejected`, `Rejected by ${s.name}.${why ? ` “${why}”` : ""}`);
    }
    return claimJson(next);
  });
}

const METHODS = ["cash", "transfer", "e-wallet", "check"] as const;
const HOW: Record<(typeof METHODS)[number], string> = { cash: "in cash", transfer: "by bank transfer", "e-wallet": "by e-wallet", check: "by check" };

/**
 * Accounting releases approved claims straight to the employee: cash, bank transfer, e-wallet or check
 * (Final Approve on each). Claims never go through payroll. The reference is encrypted. Without
 * migration 024 only a bank transfer can be recorded, as before.
 */
export async function releaseClaims(s: Session, body: any) {
  const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
  const method = METHODS.find((m) => m === (body?.method ?? "transfer"));
  const reference = String(body?.reference ?? "").trim(), paidOn = String(body?.paidOn ?? "");
  return tx(async (c) => {
    const picked = ids.length ? (await c.query(`select * from reimbursement_claims where id::text = any($1) for update`, [ids])).rows : [];
    for (const r of picked) demand(s, "final", "claims", r.employee_id);
    if (!picked.length || picked.length !== new Set(ids).size) throw new UserError("Choose the claims to pay");
    if (picked.some((r) => r.status !== "approved" || r.paid_at)) throw new UserError("Only approved claims that aren't paid yet can be paid out");
    if (!method) throw new UserError("Choose how it was released");
    if (method !== "cash" && !reference) throw new UserError(method === "check" ? "Enter the check number" : "Enter the transfer reference");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new UserError("Enter the date it was released");
    if (reference.length > 100) throw new UserError("Keep the reference under 100 characters");
    const withMethod = await schema024(c);
    if (!withMethod && method !== "transfer") await need024(c);
    await c.query(
      `update reimbursement_claims set paid_at = ($2::date + time '12:00') at time zone 'Asia/Manila', paid_by = $3, paid_by_name = $4, payout_method = 'transfer', payout_reference = $5${withMethod ? ", release_method = $6" : ""} where id = any($1::uuid[])`,
      [picked.map((r) => r.id), paidOn, s.accountId, s.name, seal(reference || "Cash"), ...(withMethod ? [method] : [])],
    );
    const total = Math.round(picked.reduce((n, r) => n + r.amount, 0) * 100) / 100;
    for (const r of picked) await audit(c, { actorId: s.accountId, actorName: s.name, module: "Reimbursements", action: "Released claim", target: r.merchant, employeeNo: r.employee_id, detail: `₱${r.amount.toLocaleString("en-PH")} · ${HOW[method]} · ${paidOn}` });
    const how = method === "cash" ? "in cash" : method === "check" ? `by check (no. ${reference})` : `by ${method === "transfer" ? "bank transfer" : method} (ref. ${reference})`;
    for (const r of picked) await tellEmployees(c, s, r.employee_id, "claim", "approved", `Your ${what(r)} reimbursement was released`, `${peso(r.amount)} released to you ${how}.`);
    return { paid: picked.length, total };
  });
}

/** A stored file, for whoever may see what it belongs to. */
export async function readFile(s: Session, id: string, db: Db = pool) {
  const f = (await db.query(`select id, content_type, content from files where id::text = $1`, [id])).rows[0];
  if (!f?.content) throw new UserError("That file isn't available", 404);
  const claim = (await db.query(`select employee_id from reimbursement_claims where receipt_file_id = $1`, [f.id])).rows[0];
  const photo = (await db.query(`select 1 from employees where photo_file_id = $1 limit 1`, [f.id])).rowCount;
  const doc = (await db.query(`select employee_id from employee_documents where file_id = $1 limit 1`, [f.id])).rows[0];
  const logo = (await db.query(`select 1 from company_settings where logo_file_id = $1`, [f.id])).rowCount;
  const policy = (await schema020(db)) ? (await db.query(`select status from company_policies where file_id = $1 order by (status = 'published') desc limit 1`, [f.id])).rows[0] : undefined;
  // Receipts: whoever may see the claim. Photos and the company logo: anyone signed in.
  // 201 documents: whoever may see that person's documents. Company policy documents: anyone signed
  // in once published; drafts and archived ones only whoever has Rules access.
  const allowed = claim ? claim.employee_id === s.employeeNo || can(s, "view", "claims", claim.employee_id)
    : photo || logo ? true
    : doc ? can(s, "view", "documents", doc.employee_id)
    : policy ? policy.status === "published" || can(s, "view", "rules")
    : false;
  if (!allowed) throw new UserError("That file isn't available", 404);
  return { contentType: f.content_type as string, bytes: openBytes(f.content as Buffer) };
}
