// Leave rules: day counting, balances, the yearly credit pool, eligibility and
// the checks a request must pass. Pure functions over the data passed in, so
// the browser and the API server (server/src/leave.ts) apply the same rules.
// Imports nothing that touches browser storage.

import { HOLIDAYS } from "../holidays";
import type { Adjustment, Balance, LeaveRequest, LeaveType } from "./types";

export interface LeaveData {
  types: LeaveType[];
  requests: LeaveRequest[];
  adjustments: Adjustment[];
  /** Unused days brought over from last year, by "employeeId|typeId". */
  carryOver: Record<string, number>;
}

/** What the rules need to know about the person: sex and civil status for eligibility, hire date for accrual and service length. */
export interface LeavePersonFacts {
  personal: { sex: string; civilStatus: string };
  job: { dateHired: string };
}

export const DEFAULT_TYPES: LeaveType[] = [
  { id: "vl", name: "Vacation leave", code: "VL", daysPerYear: 15, earning: { kind: "yearly" }, paid: true, carryOverMax: 5, countBy: "workdays", eligibility: "everyone", attachmentOver: null, confidential: false, basis: "Company policy (covers the 5-day Service Incentive Leave)", active: true },
  { id: "sl", name: "Sick leave", code: "SL", daysPerYear: 15, earning: { kind: "yearly" }, paid: true, carryOverMax: 5, countBy: "workdays", eligibility: "everyone", attachmentOver: 2, confidential: false, basis: "Company policy", active: true },
  { id: "el", name: "Emergency leave", code: "EL", daysPerYear: 3, earning: { kind: "yearly" }, paid: true, carryOverMax: 0, countBy: "workdays", eligibility: "everyone", attachmentOver: null, confidential: false, basis: "Company policy", active: true },
  { id: "bl", name: "Bereavement leave", code: "BL", daysPerYear: 3, earning: { kind: "yearly" }, paid: true, carryOverMax: 0, countBy: "workdays", eligibility: "everyone", attachmentOver: 0, confidential: false, basis: "Company policy", active: true },
  { id: "ml", name: "Maternity leave", code: "ML", daysPerYear: 105, earning: { kind: "per-event" }, paid: true, carryOverMax: 0, countBy: "calendar", eligibility: "female", attachmentOver: 0, confidential: false, basis: "RA 11210 (105 days, +15 for solo parents)", active: true },
  { id: "pl", name: "Paternity leave", code: "PL", daysPerYear: 7, earning: { kind: "per-event" }, paid: true, carryOverMax: 0, countBy: "workdays", eligibility: "male-married", attachmentOver: 0, confidential: false, basis: "RA 8187 (married male, first 4 deliveries)", active: true },
  { id: "sp", name: "Solo parent leave", code: "SPL", daysPerYear: 7, earning: { kind: "yearly" }, paid: true, carryOverMax: 0, countBy: "workdays", eligibility: "solo-parent", attachmentOver: 0, confidential: false, basis: "RA 11861 (after 6 months, with Solo Parent ID)", active: true },
  { id: "vawc", name: "VAWC leave", code: "VAWC", daysPerYear: 10, earning: { kind: "per-event" }, paid: true, carryOverMax: 0, countBy: "workdays", eligibility: "female", attachmentOver: 0, confidential: true, basis: "RA 9262 (up to 10 days; details confidential)", active: true },
  { id: "slw", name: "Special leave for women", code: "SLW", daysPerYear: 60, earning: { kind: "per-event" }, paid: true, carryOverMax: 0, countBy: "workdays", eligibility: "female", attachmentOver: 0, confidential: false, basis: "RA 9710 (up to 2 months after gynecological surgery)", active: true },
  { id: "lwop", name: "Leave without pay", code: "LWOP", daysPerYear: 0, earning: { kind: "unlimited" }, paid: false, carryOverMax: 0, countBy: "workdays", eligibility: "everyone", attachmentOver: null, confidential: false, basis: "Company policy", active: true },
];

// ---- Dates ----

export function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const weekday = (date: string) => new Date(`${date}T12:00:00`).getDay();
const isHoliday = (date: string) => HOLIDAYS.some((h) => h.date === date);

/** Days a request covers: working days (Mon–Fri, not holidays) or every calendar day. */
export function countDays(start: string, end: string, countBy: LeaveType["countBy"], halfDay?: "am" | "pm") {
  if (!start || !end || end < start) return 0;
  if (halfDay && start === end) return countBy === "calendar" || (weekday(start) !== 0 && weekday(start) !== 6 && !isHoliday(start)) ? 0.5 : 0;
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (countBy === "calendar" || (weekday(d) !== 0 && weekday(d) !== 6 && !isHoliday(d))) n++;
  }
  return n;
}

// ---- Balances ----

/** Months credited so far this year: 1.25 days land on the 1st of each month, from the month after hire. */
function monthsEarned(hireDate: string, today: string) {
  const year = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7));
  const hiredYear = Number(hireDate.slice(0, 4));
  const firstMonth = hiredYear < year ? 1 : hiredYear === year ? Number(hireDate.slice(5, 7)) + 1 : 13;
  return Math.max(0, thisMonth - firstMonth + 1);
}

function eligibility(e: LeavePersonFacts | undefined, type: LeaveType): { eligible: boolean; note?: string } {
  if (!e) return { eligible: false, note: "Employee not found" };
  const sex = e.personal.sex;
  const months = (Date.now() - new Date(`${e.job.dateHired}T00:00:00`).getTime()) / (30.44 * 86_400_000);
  switch (type.eligibility) {
    case "female":
      return sex === "Male" ? { eligible: false, note: "For female employees" } : { eligible: true, note: sex ? undefined : "Sex not recorded in the 201 file" };
    case "male-married":
      if (sex === "Female") return { eligible: false, note: "For married male employees" };
      return e.personal.civilStatus && e.personal.civilStatus !== "Married" ? { eligible: false, note: "For married male employees" } : { eligible: true, note: sex && e.personal.civilStatus ? undefined : "Check sex and civil status in the 201 file" };
    case "solo-parent":
      return months < 6 ? { eligible: false, note: "After 6 months of service" } : { eligible: true, note: "Needs a valid Solo Parent ID" };
    case "after-1-year":
      return months < 12 ? { eligible: false, note: "After 1 year of service" } : { eligible: true };
    case "after-6-months":
      return months < 6 ? { eligible: false, note: "After 6 months of service" } : { eligible: true };
    default:
      return { eligible: true };
  }
}

export function balanceOf(data: LeaveData, employeeId: string, person: LeavePersonFacts | undefined, type: LeaveType, today = isoToday()): Balance {
  const year = today.slice(0, 4);
  const mine = data.requests.filter((r) => r.employeeId === employeeId && r.typeId === type.id && r.start.slice(0, 4) === year);
  const used = mine.filter((r) => r.status === "approved").reduce((n, r) => n + r.days, 0);
  const pending = mine.filter((r) => r.status === "pending").reduce((n, r) => n + r.days, 0);
  const adjusted = data.adjustments.filter((a) => a.employeeId === employeeId && a.typeId === type.id && a.at.slice(0, 4) === year).reduce((n, a) => n + a.days, 0);
  const carriedOver = type.carryOverMax ? Math.min(type.carryOverMax, data.carryOver[`${employeeId}|${type.id}`] ?? 0) : 0;
  const elig = eligibility(person, type);
  const unlimited = type.earning.kind === "unlimited";
  const earned =
    type.earning.kind === "monthly" ? Math.min(type.daysPerYear, monthsEarned(person?.job.dateHired ?? `${year}-01-01`, today) * type.earning.perMonth) : unlimited ? 0 : type.daysPerYear;
  const remaining = unlimited ? Infinity : Math.max(0, earned + carriedOver + adjusted - used);
  return {
    typeId: type.id,
    earned,
    yearTotal: type.daysPerYear,
    carriedOver,
    adjusted,
    used,
    pending,
    remaining,
    available: unlimited ? Infinity : Math.max(0, remaining - pending),
    unlimited,
    eligible: elig.eligible,
    eligibilityNote: elig.note,
  };
}

/** Every employee can file this many leaves a year, any paid type. Each leave uses 1, however many days it covers. */
export const LEAVE_CREDITS_PER_YEAR = 6;

/** Adjustments with this type id change the yearly pool, not a leave type. */
export const CREDITS_ADJUSTMENT = "credits";

export interface Credits {
  /** The 6 everyone gets, plus HR's changes. */
  total: number;
  /** Added (+) or removed (−) by HR this year. */
  adjusted: number;
  used: number;
  pending: number;
  /** total − used − pending: what can still be filed. */
  available: number;
}

/** The yearly credit pool. Leave without pay doesn't use credits. */
export function creditsOf(data: LeaveData, employeeId: string, today = isoToday()): Credits {
  const year = today.slice(0, 4);
  const paid = new Set(data.types.filter((t) => t.earning.kind !== "unlimited").map((t) => t.id));
  const mine = data.requests.filter((r) => r.employeeId === employeeId && paid.has(r.typeId) && r.start.slice(0, 4) === year);
  const used = mine.filter((r) => r.status === "approved").length;
  const pending = mine.filter((r) => r.status === "pending").length;
  const adjusted = data.adjustments.filter((a) => a.employeeId === employeeId && a.typeId === CREDITS_ADJUSTMENT && a.at.slice(0, 4) === year).reduce((n, a) => n + a.days, 0);
  const total = Math.max(0, LEAVE_CREDITS_PER_YEAR + adjusted);
  return { total, adjusted, used, pending, available: Math.max(0, total - used - pending) };
}

// ---- Filing ----

export interface FileInput {
  employeeId: string;
  typeId: string;
  start: string;
  end: string;
  halfDay?: "am" | "pm";
  reason: string;
  attachment?: string;
}

export interface Preview {
  days: number;
  balance?: Balance;
  /** The employee's yearly credit pool; absent for leave without pay, which uses none. */
  credits?: Credits;
  /** Problems that stop the request from being filed. */
  errors: string[];
  /** Things HR should know but that don't block filing. */
  notes: string[];
}

/** Live check for the File leave form, and the server's check before saving: days, balance after, and anything wrong. */
export function previewOf(data: LeaveData, person: LeavePersonFacts | undefined, input: FileInput, ignoreId?: string): Preview {
  const type = data.types.find((t) => t.id === input.typeId);
  const errors: string[] = [];
  const notes: string[] = [];
  if (!input.employeeId) errors.push("Choose the employee");
  if (!type) return { days: 0, errors: [...errors, "Choose the leave type"], notes };
  if (!input.start || !input.end) return { days: 0, errors: [...errors, "Pick the start and end dates"], notes };
  if (input.end < input.start) return { days: 0, errors: [...errors, "The end date is before the start date"], notes };
  const days = countDays(input.start, input.end, type.countBy, input.start === input.end ? input.halfDay : undefined);
  if (days === 0) errors.push("Those dates are all weekends or holidays, so no leave is needed");
  const holidays = HOLIDAYS.filter((h) => h.date >= input.start && h.date <= input.end);
  if (holidays.length && type.countBy === "workdays") notes.push(`${holidays.map((h) => h.name).join(", ")} ${holidays.length === 1 ? "is a holiday" : "are holidays"}, not counted.`);
  if (!input.employeeId) return { days, errors, notes };
  const balance = balanceOf(data, input.employeeId, person, type);
  if (!balance.eligible) errors.push(balance.eligibilityNote ?? "This employee can't use this leave type");
  else if (balance.eligibilityNote) notes.push(balance.eligibilityNote);
  const credits = balance.unlimited ? undefined : creditsOf(data, input.employeeId);
  if (credits && credits.available < 1) errors.push(`All ${credits.total} leaves for this year are used up. File it as Leave without pay.`);
  if (type.attachmentOver !== null && days > type.attachmentOver && !input.attachment) errors.push(type.attachmentOver === 0 ? `${type.name} needs a supporting document` : `${type.name} over ${type.attachmentOver} days needs a supporting document (e.g. medical certificate)`);
  const overlap = data.requests.find((r) => r.id !== ignoreId && r.employeeId === input.employeeId && (r.status === "pending" || r.status === "approved") && r.start <= input.end && r.end >= input.start);
  if (overlap) errors.push(`Overlaps another ${overlap.status} request (${overlap.start === overlap.end ? overlap.start : `${overlap.start} to ${overlap.end}`})`);
  if (type.countBy === "calendar") notes.push("Counted in calendar days, weekends included.");
  return { days, balance, credits, errors, notes };
}

export const fmtCredits = (n: number) => `${n} ${n === 1 ? "leave" : "leaves"}`;
