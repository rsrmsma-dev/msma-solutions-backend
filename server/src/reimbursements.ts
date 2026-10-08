// Reimbursements: expense claims with a receipt photo. Checks come from the shared
// src/lib/reimbursements/rules.ts. Receipt photos are kept in the files table and
// served by /api/files/:id only to the claimant and to people with Reimbursements access.

import { createHash } from "node:crypto";
import { claimProblems, type ClaimInput } from "../../src/lib/reimbursements/rules";
import { CATEGORIES } from "../../src/lib/reimbursements/store";
import { audit, can, demand, type Session } from "./auth";
import { clean, pool, tx, UserError, type Db } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? undefined);
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

const claimJson = (r: any) => clean({
  id: r.id, employeeId: r.employee_id, category: r.category, otherType: r.other_type, merchant: r.merchant, purchaseDate: r.purchase_date,
  amount: r.amount, description: r.description, receipt: `/api/files/${r.receipt_file_id}`, status: r.status, filedAt: iso(r.filed_at),
  decidedBy: r.decided_by_name, decidedAt: iso(r.decided_at), note: r.decision_note,
});

/** Your own claims; everyone's with Reimbursements access. */
export async function listClaims(s: Session) {
  const all = can(s, "reimbursements", "view");
  const { rows } = await pool.query(`select * from reimbursement_claims ${all ? "" : "where employee_id = $1"} order by filed_at desc`, all ? [] : [s.employeeNo ?? ""]);
  return rows.map(claimJson);
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
      `insert into files (storage_key, file_name, content_type, size_bytes, sha256, uploaded_by, content) values ('db:' || gen_random_uuid(), 'receipt', $1, $2, $3, $4, $5) returning id`,
      [receipt.contentType, receipt.bytes.length, sha, s.accountId, receipt.bytes],
    );
    const { rows: [r] } = await c.query(
      `insert into reimbursement_claims (employee_id, category, other_type, merchant, purchase_date, amount, description, receipt_file_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [input.employeeId, input.category, input.category === "Other" ? input.otherType!.trim() : null, input.merchant.trim(), input.purchaseDate,
        Math.round(input.amount * 100) / 100, input.description.trim(), f.id],
    );
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Reimbursements", action: "Filed claim", target: input.merchant.trim(), employeeNo: input.employeeId, detail: `₱${r.amount.toLocaleString("en-PH")} · ${input.purchaseDate}` });
    return claimJson(r);
  });
}

export async function decideClaim(s: Session, id: string, approve: boolean, note: string) {
  demand(s, "reimbursements", "approve");
  return tx(async (c) => {
    const r = (await c.query(`select * from reimbursement_claims where id::text = $1 for update`, [id])).rows[0];
    if (!r) throw new UserError("That claim no longer exists", 404);
    if (r.status !== "pending") throw new UserError("This claim was already decided");
    if (!approve && !note.trim()) throw new UserError("Say why, so the employee knows");
    const { rows: [next] } = await c.query(
      `update reimbursement_claims set status = $2, decided_by = $3, decided_by_name = $4, decided_at = now(), decision_note = $5 where id = $1 returning *`,
      [r.id, approve ? "approved" : "rejected", s.accountId, s.name, note.trim() || null],
    );
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Reimbursements", action: approve ? "Approved claim" : "Rejected claim", target: r.merchant, employeeNo: r.employee_id, detail: `₱${r.amount.toLocaleString("en-PH")}${note.trim() ? `: ${note.trim()}` : ""}` });
    return claimJson(next);
  });
}

/** A stored file, for whoever may see what it belongs to. */
export async function readFile(s: Session, id: string, db: Db = pool) {
  const f = (await db.query(`select id, content_type, content from files where id::text = $1`, [id])).rows[0];
  if (!f?.content) throw new UserError("That file isn't available", 404);
  const claim = (await db.query(`select employee_id from reimbursement_claims where receipt_file_id = $1`, [f.id])).rows[0];
  const photo = (await db.query(`select 1 from employees where photo_file_id = $1 limit 1`, [f.id])).rowCount;
  const doc = (await db.query(`select employee_id from employee_documents where file_id = $1 limit 1`, [f.id])).rows[0];
  // Receipts: the claimant or Reimbursements access. Photos: anyone signed in (avatars).
  // 201 documents: only Documents access; employees see their own documents' status, not the files.
  const allowed = claim ? claim.employee_id === s.employeeNo || can(s, "reimbursements", "view")
    : photo ? true
    : doc ? can(s, "documents", "view")
    : false;
  if (!allowed) throw new UserError("That file isn't available", 404);
  return { contentType: f.content_type as string, bytes: f.content as Buffer };
}
