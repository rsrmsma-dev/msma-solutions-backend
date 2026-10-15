// Seat and admin-account rules shared by the website (store.ts, api.ts) and the API server
// (server/src/subscription.ts), so both work out the same limits, statuses and alert levels.
// No storage here: plain functions over the plan, the client and the two counts.

import type { RoleKey } from "../permissions";

export interface Plan {
  id: string;
  name: string;
  employeeSeatLimit: number;
  adminAccountLimit: number;
  /** Overage allowed past the limit before new adds are refused, in percent (rounded down to whole seats). */
  gracePercent: number;
}

export type SeatLevel = 0 | 80 | 90 | 100;

export type SeatStatus = "ok" | "near" | "at" | "grace" | "over";

/** What usageOf needs from a client record. */
export interface ClientTerms {
  id: string;
  name: string;
  /** yyyy-mm-dd */
  renewalDate: string;
  /** Replaces the plan's employee seat limit when set. */
  seatLimitOverride?: number;
  /** Temporary extra seats, until (and including) a date. */
  extension?: { seats: number; until: string };
}

export interface Usage {
  clientId: string;
  clientName: string;
  planId: string;
  planName: string;
  renewalDate: string;
  seatsUsed: number;
  /** The limit in force: override or plan, plus any running extension. */
  seatLimit: number;
  /** Highest count new adds may reach (limit + grace). */
  seatCap: number;
  adminsUsed: number;
  adminLimit: number;
  adminCap: number;
  gracePercent: number;
  seatLimitOverride?: number;
  extension?: { seats: number; until: string };
  status: SeatStatus;
  adminStatus: SeatStatus;
}

/** The roles that take an admin account. */
export const ADMIN_ROLES: RoleKey[] = ["hr", "approver", "accounting"];

export const capOf = (limit: number, grace: number) => limit + Math.floor((limit * grace) / 100);

export function statusOf(used: number, limit: number, cap: number): SeatStatus {
  if (used > cap) return "over";
  if (used > limit) return "grace";
  if (used >= limit) return "at";
  if (used >= limit * 0.8) return "near";
  return "ok";
}

/** The plan's limits applied to the counts. `today` (yyyy-mm-dd) decides whether an extension still runs. */
export function usageFrom(plan: Plan, client: ClientTerms, seats: number, admins: number, today: string): Usage {
  const extension = client.extension && client.extension.until >= today ? client.extension : undefined;
  const seatLimit = (client.seatLimitOverride ?? plan.employeeSeatLimit) + (extension?.seats ?? 0);
  const seatCap = capOf(seatLimit, plan.gracePercent);
  const adminCap = capOf(plan.adminAccountLimit, plan.gracePercent);
  return {
    clientId: client.id,
    clientName: client.name,
    planId: plan.id,
    planName: plan.name,
    renewalDate: client.renewalDate,
    seatsUsed: seats,
    seatLimit,
    seatCap,
    adminsUsed: admins,
    adminLimit: plan.adminAccountLimit,
    adminCap,
    gracePercent: plan.gracePercent,
    seatLimitOverride: client.seatLimitOverride,
    extension: client.extension,
    status: statusOf(seats, seatLimit, seatCap),
    adminStatus: statusOf(admins, plan.adminAccountLimit, adminCap),
  };
}

export const seatLevelOf = (u: Usage): SeatLevel => (u.seatsUsed >= u.seatLimit ? 100 : u.seatsUsed >= u.seatLimit * 0.9 ? 90 : u.seatsUsed >= u.seatLimit * 0.8 ? 80 : 0);

/** Refusal texts, the same from the website and the server. */
export const seatsText = (u: Usage) => `${u.seatsUsed} of ${u.seatLimit} employee seats`;

export function seatLimitMessage(u: Usage, count: number) {
  const free = Math.max(0, u.seatCap - u.seatsUsed);
  return count > 1
    ? `This import has ${count} employees but only ${free} ${free === 1 ? "seat is" : "seats are"} available.`
    : `Seat limit reached. ${u.clientName} is using ${seatsText(u)}${u.seatCap > u.seatLimit ? `, and the ${u.gracePercent}% grace is used up` : ""}.`;
}

export const blockedEventText = (u: Usage, count: number) =>
  count > 1 ? `Import of ${count} employees refused (${Math.max(0, u.seatCap - u.seatsUsed)} seats free)` : "Add employee refused: no seats left";

export const adminLimitMessage = (u: Usage) =>
  `Admin account limit reached. ${u.clientName} is using ${u.adminsUsed} of ${u.adminLimit} admin accounts (HR, Approver and Accounting logins). Ask your System Admin to upgrade the plan.`;

// ---- Bell notifications (the same words from the website and the server) ----

export interface NoticeText {
  title: string;
  body: string;
}

/** Super Admin and HR: seats almost full (80%, then 90%) or all used (100%). */
export function companySeatAlert(u: Usage, level: SeatLevel): NoticeText {
  const planLeft = Math.max(0, u.seatLimit - u.seatsUsed);
  const left = Math.max(0, u.seatCap - u.seatsUsed);
  const seats = (n: number) => `${n} ${n === 1 ? "seat" : "seats"}`;
  const after = "Payroll, attendance and leave keep working. A Super Admin can request more seats from the seat counter at the top of the page.";
  if (level === 100) {
    const now = left ? `You can add ${left === 1 ? "1 more employee" : `${left} more employees`} for now, then adding stops.` : "New employees can't be added until the plan is upgraded.";
    return { title: "All employee seats are used", body: `You've used all ${u.seatLimit} seats on your ${u.planName} plan. ${now} ${after}` };
  }
  return {
    title: level === 90 ? `Only ${seats(planLeft)} left` : "Employee seats are almost full",
    body: `You've used ${u.seatsUsed} of your ${u.seatLimit} seats, so ${seats(planLeft)} ${planLeft === 1 ? "is" : "are"} left. When they run out, you can't add new employees. ${after}`,
  };
}

/** System Admins: a client reached 90% or 100% of its seats. */
export const platformSeatAlert = (u: Usage, level: SeatLevel): NoticeText => ({
  title: level === 100 ? `${u.clientName} is at its seat limit` : `${u.clientName} is at 90% of its seats`,
  body: `${u.clientName} (${u.planName}) is using ${seatsText(u)} and ${u.adminsUsed} of ${u.adminLimit} admin accounts.`,
});

/** System Admins: an add was refused. */
export const blockedAlert = (u: Usage, count: number): NoticeText => ({
  title: `${u.clientName}: add employee blocked`,
  body: `${u.clientName} (${u.planName}) tried to add ${count === 1 ? "an employee" : `${count} employees`} at ${seatsText(u)} (${u.seatCap} with grace).`,
});

/** System Admins: a Super Admin asked for an upgrade. */
export const upgradeAlert = (u: Usage, actor: string, note: string): NoticeText => ({
  title: `${u.clientName} requested an upgrade`,
  body: `${actor} asked to upgrade from ${u.planName}. Using ${seatsText(u)} and ${u.adminsUsed} of ${u.adminLimit} admin accounts.${note ? ` Note: ${note}` : ""}`,
});

/** Super Admin and HR: our team changed the plan, the seat limit or the extension. */
export const planNotice = (plan: Plan, from: string): NoticeText => ({ title: `Your plan is now ${plan.name}`, body: `Changed from ${from}: ${plan.employeeSeatLimit} employee seats and ${plan.adminAccountLimit} admin accounts.` });
export const overrideNotice = (seats: number | null): NoticeText => ({ title: seats === null ? "Your seat limit is back to the plan's" : `Your seat limit is now ${seats}`, body: "Set by our team. See Settings › Subscription." });
export const extensionNotice = (input: { seats: number; until: string } | null): NoticeText =>
  input
    ? { title: `${input.seats} extra seats until ${input.until}`, body: "A temporary extension from our team while your upgrade is arranged." }
    : { title: "Your extra seats ended", body: "The temporary extension is over; your plan's limit applies." };
