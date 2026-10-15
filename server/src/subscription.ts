// Subscription & seat limits (Settings › Subscription for Super Admin and HR; Administration ›
// Clients & Subscriptions for our System Admins). Same rules as the website (src/lib/subscription,
// limits and wording from rules.ts):
//   * one seat = one employee record that isn't Separated; admin accounts = active HR, Approver and
//     Accounting logins. Both are counted every time, never stored.
//   * only adding is ever refused: a new employee (or bringing back a separated one) past the seat
//     limit plus grace, and a new HR / Approver / Accounting login past the admin-account limit plus
//     grace. Payroll, attendance, leave and reports never check.
//   * the checks run inside the add's own transaction under a lock, so two adds can't both take the
//     last seat.
// There's one client per database (SaaS later): the company in company_settings. Until a System
// Admin sets a plan (or before migration 025) nothing is limited.

import { audit, demand, type Session } from "./auth";
import { clean, need025, pool, schema025, tx, UserError, type Db } from "./db";
import {
  ADMIN_ROLES, adminLimitMessage, blockedAlert, blockedEventText, companySeatAlert, extensionNotice, overrideNotice, planNotice, platformSeatAlert,
  seatLevelOf, seatLimitMessage, seatsText, upgradeAlert, usageFrom,
  type NoticeText, type Plan, type SeatLevel, type Usage,
} from "../../src/lib/subscription/rules";
import { notify } from "./notify";

/** The one client this database holds. */
export const CLIENT_ID = "company";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Today in the Philippines, yyyy-mm-dd. */
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

type Row = Record<string, any>;
type Alerts = { company?: SeatLevel; platform?: SeatLevel };

/** Super Admins and HR (the company's subscription page) or our System Admins (Clients & Subscriptions). */
const tellCompany = (c: Db, by: Session | null, kind: "approved" | "update" | "alert", n: NoticeText) =>
  notify(c, by, { kind, topic: "subscription", roles: ["super_admin", "hr"], ...n });
const tellPlatform = (c: Db, by: Session | null, n: NoticeText) => notify(c, by, { kind: "alert", topic: "subscription", roles: ["system_admin"], ...n });

const planJson = (r: Row): Plan => ({ id: r.id, name: r.name, employeeSeatLimit: r.employee_seat_limit, adminAccountLimit: r.admin_account_limit, gracePercent: r.grace_percent });

/** The subscription in force (the newest one not cancelled or expired), with its plan; undefined before 025 or when none is set. */
async function current(db: Db, lock = false): Promise<Row | undefined> {
  if (!(await schema025(db))) return undefined;
  return (await db.query(
    `select s.*, p.name as p_name, p.employee_seat_limit, p.admin_account_limit, p.grace_percent
       from subscriptions s left join subscription_plans p on p.id = s.plan_id
      where s.status in ('trial', 'active', 'past_due') order by s.starts_on desc, s.created_at desc limit 1${lock ? " for update of s" : ""}`,
  )).rows[0];
}

async function counts(db: Db) {
  const { rows: [r] } = await db.query(
    `select (select count(*)::int from employees where record_status <> 'SEPARATED') as seats,
            (select count(*)::int from user_accounts a join roles r on r.id = a.role_id where a.status = 'active' and r.role_key = any($1)) as admins`,
    [ADMIN_ROLES],
  );
  return r as { seats: number; admins: number };
}

const companyName = async (db: Db) => ((await db.query(`select company_name from company_settings where id = 1`)).rows[0]?.company_name as string | undefined) ?? "Our company";

/**
 * Usage of the plan in `row`. With no plan the limits are 0 and the status "ok" (nothing is
 * limited); planId is then the first plan, so the System Admin's Change plan dialog starts on a real choice.
 */
async function usageOf(db: Db, row: Row | undefined): Promise<Usage & { noPlan?: true }> {
  const { seats, admins } = await counts(db);
  const name = await companyName(db);
  if (!row?.plan_id) {
    const first = (await schema025(db)) ? (await db.query(`select id from subscription_plans where is_active order by sort_order, employee_seat_limit limit 1`)).rows[0]?.id : undefined;
    return {
      clientId: CLIENT_ID, clientName: name, planId: first ?? "", planName: "No plan", renewalDate: row?.current_period_end ?? today(),
      seatsUsed: seats, seatLimit: 0, seatCap: 0, adminsUsed: admins, adminLimit: 0, adminCap: 0, gracePercent: 0, status: "ok", adminStatus: "ok", noPlan: true,
    };
  }
  const plan: Plan = { id: row.plan_id, name: row.p_name, employeeSeatLimit: row.employee_seat_limit, adminAccountLimit: row.admin_account_limit, gracePercent: row.grace_percent };
  const client = {
    id: CLIENT_ID, name, renewalDate: row.current_period_end ?? today(),
    seatLimitOverride: row.seat_limit_override ?? undefined,
    extension: row.extension_seats ? { seats: row.extension_seats as number, until: row.extension_until as string } : undefined,
  };
  return clean(usageFrom(plan, client, seats, admins, today()));
}

/** Adds a line to the event log (Clients & Subscriptions). */
async function logEvent(db: Db, u: Usage, kind: string, message: string, by?: Session) {
  await db.query(
    `insert into subscription_events (kind, message, by_account, by_name, seats, admins) values ($1, $2, $3, $4, $5, $6)`,
    [kind, message, by?.accountId ?? null, by?.name ?? null, `${u.seatsUsed} / ${u.seatLimit}`, `${u.adminsUsed} / ${u.adminLimit}`],
  );
}

// ---- Checks used inside other endpoints' transactions ----

/**
 * Refuses (409 SEAT_LIMIT_REACHED) when adding `count` employees would pass the seat limit plus
 * grace. Call inside the add's transaction before the insert: the lock makes a second add wait
 * until the first is committed, then it counts again. A refusal is logged (outside the add's
 * transaction, so it stays when the add rolls back).
 */
export async function assertSeatsAvailable(c: Db, count = 1) {
  if (!(await schema025(c))) return;
  await c.query(`select pg_advisory_xact_lock(hashtext('subscription-employee-seats'))`);
  const row = await current(c);
  if (!row?.plan_id) return;
  const u = await usageOf(c, row);
  if (u.seatsUsed + count <= u.seatCap) return;
  // Logged and told outside the add's transaction, so both stay when the add rolls back.
  await logEvent(pool, u, "blocked", blockedEventText(u, count));
  await tellPlatform(pool, null, blockedAlert(u, count));
  throw new UserError(seatLimitMessage(u, count), 409, "SEAT_LIMIT_REACHED");
}

/** Refuses (409 ADMIN_LIMIT_REACHED) one more active HR / Approver / Accounting login past the plan's limit plus grace. Inside the change's transaction. */
export async function assertAdminAccountAvailable(c: Db) {
  if (!(await schema025(c))) return;
  await c.query(`select pg_advisory_xact_lock(hashtext('subscription-admin-accounts'))`);
  const row = await current(c);
  if (!row?.plan_id) return;
  const u = await usageOf(c, row);
  if (u.adminsUsed + 1 <= u.adminCap) return;
  await logEvent(pool, u, "blocked", "Admin account refused: plan's admin accounts are used up");
  throw new UserError(adminLimitMessage(u), 409, "ADMIN_LIMIT_REACHED");
}

export const isAdminRole = (key: string | undefined) => !!key && (ADMIN_ROLES as string[]).includes(key);

/**
 * Records seat-threshold crossings once each (last_seat_level for the event log and System
 * Admins, last_seat_alert for Super Admins and HR); dropping back below a level re-arms it.
 * Sends the alerts to the bell (Super Admin and HR at 80 / 90 / 100%, System Admins at 90 / 100%)
 * and returns them.
 */
async function thresholds(c: Db, row: Row, u: Usage): Promise<Alerts> {
  const level = seatLevelOf(u);
  const alerts: Alerts = {};
  const alerted = (row.last_seat_alert ?? 0) as SeatLevel;
  const last = row.last_seat_level as SeatLevel;
  if (level === alerted && level === last) return alerts;
  await c.query(`update subscriptions set last_seat_alert = $2, last_seat_level = $2 where id = $1`, [row.id, level]);
  if (level > alerted && level !== 0) alerts.company = level;
  if (level > last) {
    await logEvent(c, u, "threshold", `Reached ${level}% of employee seats (${seatsText(u)})`);
    if (level === 100) alerts.platform = 100;
    else if (level >= 90 && last < 90) alerts.platform = 90;
  }
  if (alerts.company) await tellCompany(c, null, "alert", companySeatAlert(u, alerts.company));
  if (alerts.platform) await tellPlatform(c, null, platformSeatAlert(u, alerts.platform));
  return alerts;
}

/** After anything that changes the head count, inside its transaction: sends any seat alert it crossed. */
export async function checkSeatThresholds(c: Db) {
  const row = await current(c, true);
  if (!row?.plan_id) return;
  await thresholds(c, row, await usageOf(c, row));
}

/** The usage with any new seat alerts, checked under the subscription row's lock so each crossing is reported once. */
async function usageWithAlerts() {
  return tx(async (c) => {
    const row = await current(c, true);
    const u = await usageOf(c, row);
    if (!row?.plan_id) return u;
    const alerts = await thresholds(c, row, u);
    return alerts.company || alerts.platform ? { ...u, alerts } : u;
  });
}

// ---- The company's own subscription (Super Admin, HR) ----

export async function getSubscription(s: Session) {
  demand(s, "view", "subscription");
  const u = await usageWithAlerts();
  if ((u as { noPlan?: true }).noPlan) throw new UserError("No plan has been set for your company yet, so there's no seat limit.", 404);
  return u;
}

/** Asked when someone starts adding an employee: a 409 when no seat is free. The add checks again. */
export async function seatCheck(s: Session) {
  demand(s, "create", "people");
  return tx(async (c) => {
    await assertSeatsAvailable(c);
    return { ok: true };
  });
}

export async function requestUpgrade(s: Session, body: any) {
  demand(s, "create", "subscriptionUpgrade");
  await need025();
  const note = String(body?.note ?? "").trim().slice(0, 1000);
  return tx(async (c) => {
    const u = await usageOf(c, await current(c));
    await logEvent(c, u, "upgrade-request", `Upgrade requested${note ? `: "${note}"` : ""}`, s);
    await tellPlatform(c, s, upgradeAlert(u, s.name, note));
    return u;
  });
}

// ---- Clients & Subscriptions (System Admin) ----

export async function listClients(s: Session) {
  demand(s, "view", "clients");
  const { noPlan: _, ...u } = (await usageWithAlerts()) as Usage & { noPlan?: true };
  return [u];
}

export async function listPlans(s: Session) {
  demand(s, "view", "clients");
  if (!(await schema025())) return [];
  return (await pool.query(`select * from subscription_plans where is_active order by sort_order, employee_seat_limit`)).rows.map(planJson);
}

export async function listEvents(s: Session) {
  demand(s, "view", "clients");
  if (!(await schema025())) return [];
  const name = await companyName(pool);
  const { rows } = await pool.query(`select * from subscription_events order by occurred_at desc limit 500`);
  return rows.map((r) => clean({ id: r.id, clientId: CLIENT_ID, clientName: name, kind: r.kind, message: r.message, by: r.by_name, at: r.occurred_at.toISOString(), seats: r.seats, admins: r.admins }));
}

/** Runs a System Admin change on the subscription in force, then logs and audits it. Returns the usage with any new seat alerts. */
async function change(s: Session, clientId: string, fn: (c: Db, row: Row) => Promise<{ kind: string; message: string; notice: [kind: "approved" | "update", text: NoticeText] }>, needPlan = true) {
  demand(s, "edit", "clients");
  await need025();
  if (clientId !== CLIENT_ID) throw new UserError("That client no longer exists", 404);
  return tx(async (c) => {
    let row = await current(c, true);
    if (needPlan && !row?.plan_id) throw new UserError("Choose a plan for this client first");
    const { kind, message, notice } = await fn(c, row ?? {});
    await tellCompany(c, s, notice[0], notice[1]);
    row = await current(c, true);
    const u = await usageOf(c, row);
    await logEvent(c, u, kind, message, s);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Administration", action: "Changed subscription", target: u.clientName, detail: message });
    const alerts = row?.plan_id ? await thresholds(c, row, u) : {};
    return alerts.company || alerts.platform ? { ...u, alerts } : u;
  });
}

export async function changePlan(s: Session, clientId: string, body: any) {
  const planId = String(body?.planId ?? "");
  let plan: Plan | undefined;
  let from = "No plan";
  const usage = await change(s, clientId, async (c, row) => {
    const p = (await c.query(`select * from subscription_plans where id = $1 and is_active`, [planId])).rows[0];
    if (!p) throw new UserError("Choose a plan");
    plan = planJson(p);
    if (row.id) {
      from = row.p_name ?? "No plan";
      await c.query(`update subscriptions set plan_id = $2, plan_name = $3, updated_by = $4, updated_at = now() where id = $1`, [row.id, p.id, p.name, s.accountId]);
    } else {
      // First plan: renews a year from today until our team changes the billing period.
      await c.query(
        `insert into subscriptions (plan_name, plan_id, status, billing_cycle, current_period_end, created_by, updated_by)
         values ($1, $2, 'active', 'yearly', ((now() at time zone 'Asia/Manila')::date + interval '1 year')::date, $3, $3)`,
        [p.name, p.id, s.accountId],
      );
    }
    return { kind: "plan-changed", message: `Plan changed: ${from} → ${p.name}`, notice: ["approved", planNotice(plan, from)] };
  }, false);
  return { plan, from, usage };
}

export async function setSeatOverride(s: Session, clientId: string, body: any) {
  const raw = body?.seats;
  const seats = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (seats !== null && (!Number.isInteger(seats) || seats < 1 || seats > 100000)) throw new UserError("Enter a whole number of seats, 1 or more");
  return change(s, clientId, async (c, row) => {
    await c.query(`update subscriptions set seat_limit_override = $2, updated_by = $3, updated_at = now() where id = $1`, [row.id, seats, s.accountId]);
    return { kind: "seat-override", message: seats === null ? "Seat limit override removed (plan limit applies)" : `Seat limit overridden to ${seats}`, notice: ["update", overrideNotice(seats)] };
  });
}

export async function setExtension(s: Session, clientId: string, body: any) {
  const e = body?.extension;
  const input = e === null || e === undefined ? null : { seats: Number(e.seats), until: String(e.until ?? "") };
  if (input) {
    if (!Number.isInteger(input.seats) || input.seats < 1 || input.seats > 10000) throw new UserError("Enter how many extra seats, 1 or more");
    if (!DATE.test(input.until)) throw new UserError("Choose when the extension ends");
    if (input.until < today()) throw new UserError("The end date can't be in the past");
  }
  return change(s, clientId, async (c, row) => {
    await c.query(`update subscriptions set extension_seats = $2, extension_until = $3, updated_by = $4, updated_at = now() where id = $1`, [row.id, input?.seats ?? null, input?.until ?? null, s.accountId]);
    return { kind: "extension", message: input ? `Temporary extension: +${input.seats} seats until ${input.until}` : "Temporary extension ended", notice: [input ? "approved" : "update", extensionNotice(input)] };
  });
}
