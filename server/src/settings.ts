// Company-wide policy from Settings > Time off & leave and Settings > Scheduling (company_settings),
// and each person's own settings (user_preferences). The theme stays on each device.

import { DEFAULT_LEAVE_POLICY, type LeavePolicy } from "../../src/lib/leave/rules";
import { audit, can, demand, type Session } from "./auth";
import { need019, pool, schema019, tx, UserError, type Db } from "./db";

const bool = (v: unknown, what: string) => {
  if (typeof v !== "boolean") throw new UserError(`Choose on or off for ${what}.`);
  return v;
};

// ---- Leave policy ----

const ACCRUALS: LeavePolicy["accrual"][] = ["yearly", "monthly", "per-payroll"];

export async function leavePolicy(db: Db = pool): Promise<LeavePolicy> {
  if (!(await schema019(db))) return DEFAULT_LEAVE_POLICY;
  const r = (await db.query(`select leave_half_days, leave_negative_balance, leave_default_carry_over, leave_accrual from company_settings where id = 1`)).rows[0];
  if (!r) return DEFAULT_LEAVE_POLICY;
  return { allowHalfDays: r.leave_half_days, allowNegative: r.leave_negative_balance, defaultCarryOver: r.leave_default_carry_over, accrual: r.leave_accrual };
}

export async function saveLeavePolicy(s: Session, body: any) {
  demand(s, "edit", "rules");
  const next: LeavePolicy = {
    allowHalfDays: bool(body?.allowHalfDays, "half days"),
    allowNegative: bool(body?.allowNegative, "negative balance"),
    defaultCarryOver: Number(body?.defaultCarryOver),
    accrual: body?.accrual,
  };
  if (!(Number.isInteger(next.defaultCarryOver) && next.defaultCarryOver >= 0 && next.defaultCarryOver <= 365)) throw new UserError("Carry-over is 0 to 365 days.");
  if (!ACCRUALS.includes(next.accrual)) throw new UserError("Choose how leave is earned.");
  await need019();
  return tx(async (c) => {
    const { rowCount } = await c.query(
      `update company_settings set leave_half_days = $1, leave_negative_balance = $2, leave_default_carry_over = $3, leave_accrual = $4, updated_at = now(), updated_by = $5 where id = 1`,
      [next.allowHalfDays, next.allowNegative, next.defaultCarryOver, next.accrual, s.accountId],
    );
    if (!rowCount) throw new UserError("Save the company details in Settings > Organization first.");
    await audit(c, {
      actorId: s.accountId, actorName: s.name, module: "Leave", action: "Changed leave policy", target: "Workspace",
      detail: `Half days ${next.allowHalfDays ? "on" : "off"}; negative balance ${next.allowNegative ? "on" : "off"}; carry-over ${next.defaultCarryOver}; accrual ${next.accrual}`,
    });
    return next;
  });
}

// ---- Scheduling rules ----

export interface SchedulingRules {
  overtimeThresholdMinutes: number;
  defaultBreakMinutes: number;
  publishLeadDays: number;
}

export async function schedulingRules(db: Db = pool): Promise<SchedulingRules | undefined> {
  if (!(await schema019(db))) return undefined;
  const r = (await db.query(`select overtime_threshold_minutes, default_break_minutes, schedule_publish_lead_days from company_settings where id = 1`)).rows[0];
  return r && { overtimeThresholdMinutes: r.overtime_threshold_minutes, defaultBreakMinutes: r.default_break_minutes, publishLeadDays: r.schedule_publish_lead_days };
}

export async function saveSchedulingRules(s: Session, body: any) {
  demand(s, "edit", "rules");
  const next: SchedulingRules = { overtimeThresholdMinutes: Number(body?.overtimeThresholdMinutes), defaultBreakMinutes: Number(body?.defaultBreakMinutes), publishLeadDays: Number(body?.publishLeadDays) };
  const whole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!whole(next.overtimeThresholdMinutes, 240)) throw new UserError("Overtime threshold is 0 to 240 minutes.");
  if (!whole(next.defaultBreakMinutes, 120)) throw new UserError("Default break is 0 to 120 minutes.");
  if (!whole(next.publishLeadDays, 60)) throw new UserError("Publish 0 to 60 days ahead.");
  await need019();
  return tx(async (c) => {
    const { rowCount } = await c.query(
      `update company_settings set overtime_threshold_minutes = $1, default_break_minutes = $2, schedule_publish_lead_days = $3, updated_at = now(), updated_by = $4 where id = 1`,
      [next.overtimeThresholdMinutes, next.defaultBreakMinutes, next.publishLeadDays, s.accountId],
    );
    if (!rowCount) throw new UserError("Save the company details in Settings > Organization first.");
    await audit(c, {
      actorId: s.accountId, actorName: s.name, module: "Timekeeping", action: "Changed scheduling rules", target: "Workspace",
      detail: `Overtime after ${next.overtimeThresholdMinutes} min; default break ${next.defaultBreakMinutes} min; publish ${next.publishLeadDays} days ahead`,
    });
    return next;
  });
}

// ---- Personal settings ----
// Shapes follow src/lib/settings/store.ts (UserSettings); anything never saved is left out so the
// website fills in its defaults (and the company's timezone).

const DATE_FORMATS = ["MMM d, yyyy", "dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"];
const EVENTS = ["leaveSubmitted", "leaveDecided", "shiftChanged", "schedulePublished", "documentUploaded", "announcement"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SECTION_LABEL: Record<string, string> = { account: "Account preferences", notifications: "Notifications", appearance: "Appearance", security: "Security" };

function prefsJson(r: any) {
  if (!r) return {};
  return {
    account: { displayName: r.display_name ?? "", language: r.language, ...(r.timezone ? { timezone: r.timezone } : {}), dateFormat: r.date_format, weekStart: r.week_start },
    notifications: { enabled: r.notifications_on, matrix: r.notification_matrix ?? {}, quietHours: { enabled: r.quiet_hours_on, from: r.quiet_from.slice(0, 5), to: r.quiet_to.slice(0, 5) }, digest: r.digest },
    appearance: { density: r.density, reduceMotion: r.reduce_motion, landing: r.landing_path },
    security: { twoFactor: r.two_step_requested },
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

/** Your own settings; everyone has them (personalSettings is "own" for every role). */
export async function myPreferences(s: Session) {
  demand(s, "view", "personalSettings");
  if (!(await schema019())) return {};
  const r = (await pool.query(`select * from user_preferences where account_id = $1`, [s.accountId])).rows[0];
  return prefsJson(r);
}


/** Saves one section of your own settings. */
export async function saveMyPreferences(s: Session, section: string, v: any) {
  demand(s, "view", "personalSettings");
  if (!can(s, "create", "personalSettings")) throw new UserError("You don't have access to do that.", 403);
  if (!SECTION_LABEL[section]) throw new UserError("Unknown settings section", 404);
  if (!v || typeof v !== "object") throw new UserError("Nothing to save.");
  const cols: Record<string, unknown> = {};
  if (section === "account") {
    // Empty: follow the company's default timezone.
    const tz = String(v.timezone ?? "").trim();
    try {
      if (tz) new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      throw new UserError("Pick a timezone from the list.");
    }
    if (tz.length > 64) throw new UserError("Pick a timezone from the list.");
    if (v.language !== "en") throw new UserError("Pick a language from the list.");
    if (!DATE_FORMATS.includes(v.dateFormat)) throw new UserError("Pick a date format from the list.");
    if (![0, 1, 6].includes(v.weekStart)) throw new UserError("Pick the first day of the week.");
    const displayName = String(v.displayName ?? "").trim().slice(0, 120);
    Object.assign(cols, { display_name: displayName || null, language: v.language, timezone: tz || null, date_format: v.dateFormat, week_start: v.weekStart });
  } else if (section === "notifications") {
    const matrix: Record<string, { inApp: boolean; email: boolean }> = {};
    for (const [k, x] of Object.entries((v.matrix ?? {}) as Record<string, any>)) {
      if (!EVENTS.includes(k)) continue;
      matrix[k] = { inApp: bool(x?.inApp, "in-app alerts"), email: bool(x?.email, "email alerts") };
    }
    const q = v.quietHours ?? {};
    if (!HHMM.test(String(q.from ?? "")) || !HHMM.test(String(q.to ?? ""))) throw new UserError("Enter the quiet hours.");
    if (!["off", "daily", "weekly"].includes(v.digest)) throw new UserError("Choose how often to get the summary.");
    Object.assign(cols, { notifications_on: bool(v.enabled, "notifications"), notification_matrix: JSON.stringify(matrix), quiet_hours_on: bool(q.enabled, "quiet hours"), quiet_from: q.from, quiet_to: q.to, digest: v.digest });
  } else if (section === "appearance") {
    if (v.density !== "comfortable" && v.density !== "compact") throw new UserError("Choose the density.");
    const landing = String(v.landing ?? "");
    if (landing && !/^\/[A-Za-z0-9/_-]*$/.test(landing)) throw new UserError("Choose the page to open after signing in.");
    Object.assign(cols, { density: v.density, reduce_motion: bool(v.reduceMotion, "reduce motion"), landing_path: landing });
  } else {
    Object.assign(cols, { two_step_requested: bool(v.twoFactor, "two-step sign-in") });
  }
  const names = Object.keys(cols);
  const values = Object.values(cols);
  await need019();
  await tx(async (c) => {
    await c.query(
      `insert into user_preferences (account_id, ${names.join(", ")}, updated_at) values ($1, ${names.map((_, i) => `$${i + 2}`).join(", ")}, now())
       on conflict (account_id) do update set ${names.map((n) => `${n} = excluded.${n}`).join(", ")}, updated_at = now()`,
      [s.accountId, ...values],
    );
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Administration", action: "Changed personal settings", target: s.name, detail: SECTION_LABEL[section] });
  });
  return myPreferences(s);
}
