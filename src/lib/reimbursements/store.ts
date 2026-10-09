// Reimbursements: expense claims employees file with a photo of the POS receipt. Two approvals:
// the employee's approver (supervisor) first, then Accounting's final approval. HR isn't involved. Saved to localStorage, receipts as compressed JPEG data URLs;
// with the API server, in the database (receipts served from /api/files).

import { api, serverMode } from "../http";

export const CATEGORIES = ["Transportation", "Meals & client meetings", "Office supplies", "Communication", "Training & seminars", "Medical", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

/** pending: waiting for the approver · endorsed: approver said yes, waiting for Accounting · approved: final. */
export type ClaimStatus = "pending" | "endorsed" | "approved" | "rejected";

export interface Claim {
  id: string;
  employeeId: string;
  category: Category;
  /** What the employee typed when the category is "Other". */
  otherType?: string;
  merchant: string;
  /** yyyy-mm-dd on the receipt. */
  purchaseDate: string;
  amount: number;
  description: string;
  /** The receipt photo, as a data URL. */
  receipt: string;
  status: ClaimStatus;
  filedAt: string;
  /** Step 1: the approver (supervisor). */
  approverDecidedBy?: string;
  approverDecidedAt?: string;
  approverNote?: string;
  /** The final decision (Accounting), or the approver's when they declined. */
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

/** The expense name to show: what they typed for "Other", else the category. */
export const claimType = (c: Pick<Claim, "category" | "otherType">) => (c.category === "Other" && c.otherType ? c.otherType : c.category);

export { CLAIM_WINDOW_DAYS, MAX_AMOUNT } from "./rules";

// v2: cleared with the rest of the sample data.
const KEY = "heyhr-reimbursements-v2";

function load(): Claim[] {
  // With the API server, claims come from the database (see refreshClaims).
  if (serverMode) return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Claim[];
  } catch {
    // Storage blocked or corrupt: start empty.
  }
  return [];
}

export let claims: Claim[] = load();

/** With the API server: the claims this account may see. Receipts load from /api/files. */
export async function refreshClaims() {
  if (serverMode) claims = await api<Claim[]>("GET", "/reimbursements/claims");
}

/** Saves the claims; false when storage is full (receipt photos are the heavy part). */
export function saveClaims(next: Claim[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    claims = next;
    return true;
  } catch {
    return false;
  }
}
