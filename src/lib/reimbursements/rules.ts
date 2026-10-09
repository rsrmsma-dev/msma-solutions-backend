// Reimbursement claim rules shared by the browser and the API server
// (server/src/reimbursements.ts). Imports nothing that touches browser storage.

import type { Category, Claim } from "./store";

/** Receipts older than this can't be claimed. */
export const CLAIM_WINDOW_DAYS = 60;
export const MAX_AMOUNT = 50_000;

function localIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface ClaimInput {
  employeeId: string;
  category: Category | "";
  otherType?: string;
  merchant: string;
  purchaseDate: string;
  amount: number;
  description: string;
  receipt: string;
}

/** Problems that stop a claim from being filed, keyed by field. `claims` are the ones already filed. */
export function claimProblems(input: ClaimInput, claims: Pick<Claim, "employeeId" | "status" | "purchaseDate" | "amount" | "merchant">[]): Partial<Record<keyof ClaimInput, string>> {
  const errors: Partial<Record<keyof ClaimInput, string>> = {};
  const today = localIso(new Date());
  const oldest = new Date();
  oldest.setDate(oldest.getDate() - CLAIM_WINDOW_DAYS);
  if (!input.receipt) errors.receipt = "Add a photo of the receipt";
  if (!input.category) errors.category = "Choose what the expense was for";
  else if (input.category === "Other" && !input.otherType?.trim()) errors.otherType = "Type what kind of expense it is";
  else if ((input.otherType?.trim().length ?? 0) > 60) errors.otherType = "Keep it under 60 characters";
  if (!input.merchant.trim()) errors.merchant = "Enter the store or merchant on the receipt";
  if (!input.purchaseDate) errors.purchaseDate = "Enter the date on the receipt";
  else if (input.purchaseDate > today) errors.purchaseDate = "The receipt date can't be in the future";
  else if (input.purchaseDate < localIso(oldest)) errors.purchaseDate = `Receipts older than ${CLAIM_WINDOW_DAYS} days can't be claimed`;
  if (!Number.isFinite(input.amount) || input.amount <= 0) errors.amount = "Enter the total on the receipt";
  else if (input.amount > MAX_AMOUNT) errors.amount = `Claims over ₱${MAX_AMOUNT.toLocaleString("en-PH")} go through Finance, not here`;
  if (!input.description.trim()) errors.description = "Say what it was for";
  if (!errors.amount && !errors.purchaseDate) {
    const dup = claims.find(
      (c) => c.employeeId === input.employeeId && c.status !== "rejected" && c.purchaseDate === input.purchaseDate && c.amount === Math.round(input.amount * 100) / 100 && c.merchant.trim().toLowerCase() === input.merchant.trim().toLowerCase(),
    );
    if (dup) errors.receipt = "You've already claimed this receipt";
  }
  return errors;
}

