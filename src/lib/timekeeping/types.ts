// Timekeeping & Attendance: shifts, schedules, punches from biometric and
// face-recognition devices, and the overtime / undertime / tardiness that
// follow from them. Mock data for now; shaped like future API payloads.

export interface ShiftTemplate {
  id: string;
  name: string;
  /** "08:00", 24-hour local time. */
  start: string;
  /** Earlier than or equal to start means the shift ends the next day. */
  end: string;
  breakMinutes: number;
  /** When the unpaid lunch break starts, "12:00". Lunch out and lunch in are recorded automatically from it. */
  breakStart: string;
  /** Minutes after the start before someone counts as late. */
  graceMinutes: number;
  /** Days of the week off, 0 = Sunday. */
  restDays: number[];
  /** Flexible time: clock in any time between start and end; only the hours worked count. */
  flexible?: boolean;
  /** Hours to work on a flexible day, not counting the break. */
  requiredHours?: number;
  active: boolean;
}

export type PunchSource = "biometric" | "face" | "manual";

export interface Punch {
  id: string;
  employeeId: string;
  /** The schedule day this punch belongs to (an overnight shift's 6 AM time-out belongs to the day before). */
  workDate: string;
  /** Local date-time, "2026-10-02T08:07". */
  at: string;
  kind: "in" | "out";
  source: PunchSource;
  device: string;
  /** Branch the device is installed in. */
  deviceBranch?: string;
  deviceRegistered: boolean;
  /** Face recognition match, 0–100. */
  match?: number;
  /** Manual corrections only. */
  reason?: string;
  recordedBy?: string;
  /** Punches are never deleted; HR can set one aside with a reason. */
  voided?: { reason: string; by: string; at: string };
  /** HR looked at a flagged punch and kept it. */
  confirmed?: { by: string; at: string };
}

import type { Holiday } from "../holidays";
export type { Holiday };

export type DayKind = "work" | "rest" | "leave" | "holiday" | "unscheduled";
export type DayType = "ordinary" | "rest" | "special" | "regular";

export type IssueKind = "missing-out" | "missing-in" | "double-punch" | "low-match" | "unknown-device" | "outside-branch";

export interface DayIssue {
  kind: IssueKind;
  punchId?: string;
  text: string;
}

export type DayStatus = "done" | "working" | "not-in" | "upcoming" | "absent" | "rest" | "leave" | "holiday" | "unscheduled";

export interface DayResult {
  employeeId: string;
  date: string;
  kind: DayKind;
  dayType: DayType;
  status: DayStatus;
  shift?: ShiftTemplate;
  holiday?: Holiday;
  /** Epoch ms. */
  shiftStart?: number;
  shiftEnd?: number;
  timeIn?: Punch;
  timeOut?: Punch;
  /** Every punch for the day, set-aside ones included. */
  punches: Punch[];
  /** Automatic lunch out / lunch in (epoch ms), when the person was at work for them. */
  lunchOut?: number;
  lunchIn?: number;
  /** Lunch minutes taken out of the worked time. */
  lunchMinutes: number;
  workedMinutes: number;
  /** Minutes late past the grace period (what gets deducted). */
  lateMinutes: number;
  /** Minutes after the shift start, ignoring grace. */
  lateRawMinutes: number;
  undertimeMinutes: number;
  /** Time worked past the shift end (or all of it on a rest day). Not overtime until approved. */
  extraMinutes: number;
  approvedOvertimeMinutes: number;
  undertimeExcused: boolean;
  /** Minutes worked between 10 PM and 6 AM. */
  nightMinutes: number;
  issues: DayIssue[];
}

export interface TimeRequest {
  id: string;
  employeeId: string;
  date: string;
  type: "overtime" | "undertime";
  minutes: number;
  reason: string;
  status: "pending" | "approved" | "declined";
  filedBy: string;
  filedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

/**
 * When repeated lateness gets flagged for HR to look at. 0 turns a check off.
 * Flags never change pay or mark anyone absent; HR decides what to do.
 */
export interface TardinessRule {
  /** Late on this many scheduled work days in a row. */
  consecutive: number;
  /** Late this many times in the current month. */
  perMonth: number;
}

/**
 * A day (or days) HR declares as work-from-home, for a typhoon or other emergency.
 * The office scanners record nothing; everyone covered clocks in from home with a face scan.
 */
export interface RemoteDay {
  id: string;
  from: string;
  to: string;
  /** Branches covered; empty means every office. */
  offices: string[];
  reason: string;
  declaredBy: string;
  declaredAt: string;
}

/** A memo HR sends an employee about repeated lateness or absences. Never changes pay. */
export interface AttendanceNotice {
  id: string;
  employeeId: string;
  kind: "tardiness" | "awol";
  subject: string;
  message: string;
  /** The days it is about. */
  dates: string[];
  sentBy: string;
  sentAt: string;
  acknowledgedAt?: string;
}

/** What went wrong with the device or system. */
export type FixCause = "not-recorded" | "wrong-time" | "system-error" | "other";

/** An employee asking HR to adjust a time-in or time-out the biometrics or system got wrong. */
export interface FixRequest {
  id: string;
  employeeId: string;
  workDate: string;
  kind: "in" | "out";
  /** "HH:MM" */
  time: string;
  nextDay?: boolean;
  /** Older requests have none; read as "not-recorded". */
  cause?: FixCause;
  /** The time on record when the request was sent, "HH:MM". */
  recorded?: string;
  reason: string;
  status: "pending" | "approved" | "declined";
  filedBy: string;
  filedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface TimeAudit {
  id: string;
  employeeId: string;
  workDate: string;
  actor: string;
  action: string;
  detail: string;
  at: string;
}

/** Statutory premium, as a share of the daily/hourly rate. Stored as dated data, not code. */
export interface PremiumRate {
  dayType: DayType;
  firstEightHours: number;
  overtime: number;
  effectiveFrom: string;
  source: string;
  lastVerified: string;
}
