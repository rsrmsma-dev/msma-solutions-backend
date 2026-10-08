// Leave Management: leave types, how they're earned (accruals), requests and balances.

/** How the days of a leave type are earned. */
export type Earning =
  | { kind: "monthly"; perMonth: number } // e.g. 1.25 days on the 1st of each month
  | { kind: "yearly" } // the full year's days on Jan 1 (or on hire)
  | { kind: "per-event" } // statutory, granted when it happens (e.g. a birth)
  | { kind: "unlimited" }; // leave without pay

export type Eligibility = "everyone" | "female" | "male-married" | "solo-parent" | "after-1-year" | "after-6-months";

export interface LeaveType {
  id: string;
  name: string;
  /** Short code shown in tight places, e.g. "VL". */
  code: string;
  /** Days a year, or per event for statutory leave. 0 for unlimited. */
  daysPerYear: number;
  earning: Earning;
  paid: boolean;
  /** Unused days that roll into next year. */
  carryOverMax: number;
  /** Working days skip rest days and holidays; calendar days count every day (maternity). */
  countBy: "workdays" | "calendar";
  eligibility: Eligibility;
  /** An attachment is required when a request is longer than this many days (null = never). */
  attachmentOver: number | null;
  /** Reason hidden from everyone but HR (VAWC). */
  confidential: boolean;
  /** Where the rule comes from. */
  basis: string;
  active: boolean;
}

export type RequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveRequest {
  id: string;
  employeeId: string;
  typeId: string;
  start: string;
  end: string;
  /** Half a day, only when start = end. */
  halfDay?: "am" | "pm";
  days: number;
  reason: string;
  attachment?: string;
  status: RequestStatus;
  filedBy: string;
  filedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface Adjustment {
  id: string;
  employeeId: string;
  typeId: string;
  days: number;
  reason: string;
  by: string;
  at: string;
}

export interface Balance {
  typeId: string;
  /** Earned so far this year (monthly), or the whole year (yearly / per event). */
  earned: number;
  /** The full year's entitlement, for monthly types. */
  yearTotal: number;
  carriedOver: number;
  adjusted: number;
  used: number;
  pending: number;
  /** earned + carried over + adjusted − used. */
  remaining: number;
  /** remaining − pending: what can still be filed. */
  available: number;
  unlimited: boolean;
  eligible: boolean;
  eligibilityNote?: string;
}
