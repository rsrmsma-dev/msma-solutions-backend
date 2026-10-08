// Timekeeping rules shared by the browser and the API server (server/src/timekeeping.ts):
// the built-in shifts, the default tardiness rule, and the checks a shift or rule must pass.
// Imports nothing that touches browser storage.

import type { ShiftTemplate, TardinessRule } from "./types";

export const DEFAULT_SHIFTS: ShiftTemplate[] = [
  { id: "sh-day", name: "Busy season", start: "08:30", end: "17:00", breakMinutes: 60, breakStart: "12:00", graceMinutes: 5, restDays: [0, 6], active: true },
  { id: "sh-peak", name: "Peak season", start: "08:30", end: "17:30", breakMinutes: 60, breakStart: "12:00", graceMinutes: 5, restDays: [0, 6], active: true },
  { id: "sh-mid", name: "Mid shift", start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "13:00", graceMinutes: 5, restDays: [0, 6], active: true },
  { id: "sh-flex", name: "Flexible time", start: "08:30", end: "19:00", breakMinutes: 60, breakStart: "12:00", graceMinutes: 0, restDays: [0, 6], active: true, flexible: true, requiredHours: 8 },
];

/** Everyone without a usual shift works this one. */
export const DEFAULT_SHIFT_ID = "sh-day";

export const DEFAULT_TARDINESS_RULE: TardinessRule = { consecutive: 3, perMonth: 5 };

const HHMM = /^\d{2}:\d{2}$/;

/** What's wrong with a shift, or null. `others` are the other saved shifts (for the unique name). */
export function shiftProblem(input: Omit<ShiftTemplate, "id" | "active"> & { id?: string }, others: ShiftTemplate[]): string | null {
  const name = input.name.trim();
  if (!name) return "Name the shift";
  if (!HHMM.test(input.start) || !HHMM.test(input.end)) return "Enter start and end times";
  if (input.start === input.end) return "Start and end can't be the same time";
  if (!(input.breakMinutes >= 0 && input.breakMinutes <= 120)) return "Break should be between 0 and 120 minutes";
  if (input.breakMinutes > 0) {
    if (!HHMM.test(input.breakStart)) return "Enter when lunch starts";
    const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const len = (mins(input.end) - mins(input.start) + 1440) % 1440 || 1440;
    const into = (mins(input.breakStart) - mins(input.start) + 1440) % 1440;
    if (into === 0 || into + input.breakMinutes >= len) return "Lunch has to start and end within the shift";
  }
  if (!(input.graceMinutes >= 0 && input.graceMinutes <= 30)) return "Grace period should be between 0 and 30 minutes";
  if (!input.restDays.length) return "Pick at least one rest day. Everyone is entitled to a rest day each week.";
  if (input.restDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "Rest days are Sunday (0) to Saturday (6)";
  if (others.some((s) => s.id !== input.id && s.name.toLowerCase() === name.toLowerCase())) return "There's already a shift with that name";
  return null;
}

export function tardinessRuleProblem(rule: TardinessRule): string | null {
  if (!Number.isInteger(rule.consecutive) || rule.consecutive < 0 || rule.consecutive === 1 || rule.consecutive > 10) return "Days in a row should be 2 to 10, or 0 to turn it off";
  if (!Number.isInteger(rule.perMonth) || rule.perMonth < 0 || rule.perMonth === 1 || rule.perMonth > 31) return "Times a month should be 2 to 31, or 0 to turn it off";
  return null;
}
