// Administration & Security: user accounts and the six fixed roles, system settings,
// approval workflows, and the audit trail. Ported from src/lib/admin/api.ts with the
// same rules: who may give which role (LIMITS.assignableRoles), at least one active
// Super Admin, nobody changes their own access.

import { createHash, randomInt } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { accountJson, audit, demand, hashPassword, type Session } from "./auth";
import { clean, pool, tx, UserError, type Db } from "./db";
import { LIMITS, type RoleKey } from "../../src/lib/permissions";
import { seal, sealBytes } from "./crypto";
import { turnOff as turnOffMfa } from "./mfa";

const log = (db: Db, s: Session, action: string, target: string, detail = "") =>
  audit(db, { actorId: s.accountId, actorName: s.name, module: "Administration", action, target, detail });

/** May the signed-in person give this role, or change accounts that hold it? */
const mayAssign = (s: Session, key: RoleKey | null | undefined) => !!key && LIMITS.assignableRoles[s.role ?? "employee"].includes(key);
const roleKey = async (db: Db, roleId: string): Promise<RoleKey | undefined> => (await db.query(`select role_key from roles where id = $1`, [roleId])).rows[0]?.role_key;
const activeSuperAdmins = async (db: Db) =>
  (await db.query(`select count(*)::int as n from user_accounts a join roles r on r.id = a.role_id where a.status = 'active' and r.is_super_admin`)).rows[0].n as number;

async function settingsRow(db: Db) {
  return (await db.query(`select * from company_settings where id = 1`)).rows[0];
}

/** A readable temporary password that meets the length rule. */
async function tempPassword(db: Db) {
  const words = ["Mango", "Cebu", "Lapu", "Sinulog", "Taal", "Bohol", "Malunggay", "Sampaguita"];
  const min = (await settingsRow(db))?.min_password_length ?? 8;
  let p = `${words[randomInt(words.length)]}-${randomInt(1000, 10000)}`;
  while (p.length < min) p += randomInt(10);
  return p;
}

// ---- Roles ----

/** The six fixed roles. What each may do is the access matrix (src/lib/permissions.ts); `access` is kept empty for older screens. */
export async function listRoles(withCounts: boolean, db: Db = pool) {
  const none = { people: "none", company: "none", documents: "none", timekeeping: "none", leave: "none", reimbursements: "none", reports: "none", payroll: "none", administration: "none" };
  const { rows } = await db.query(
    `select r.id, r.role_key as key, r.name, r.description, r.workspace, r.is_built_in as "builtIn", r.is_super_admin as "superAdmin",
            (select count(*)::int from user_accounts a where a.role_id = r.id) as users
       from roles r order by array_position(array['system_admin','super_admin','hr','approver','accounting','employee'], r.role_key)`,
  );
  return rows.map((r) => {
    const out = { ...r, access: none, ...(r.superAdmin ? {} : { superAdmin: undefined }) };
    if (!withCounts) delete out.users;
    return clean(out);
  });
}

export async function saveRole(_s: Session, _input: unknown): Promise<never> {
  throw new UserError("Roles are fixed. Their access is set in the access matrix, not here.");
}

export async function deleteRole(_s: Session, _id: string): Promise<never> {
  throw new UserError("Roles are fixed and can't be deleted.");
}

// ---- Accounts ----

export async function listAccounts(s: Session) {
  demand(s, "view", "roleAssignment");
  const { rows } = await pool.query(
    `select a.id, a.display_name as name, a.username, a.employee_id as "employeeId", a.role_id as "roleId", a.status,
            a.must_change_password as "mustChangePassword", a.last_sign_in_at as "lastSignIn", a.failed_attempts as "failedAttempts",
            a.locked_until as "lockedUntil", a.created_at as "createdAt", coalesce(r.name, 'No role') as "roleName",
            nullif(concat_ws(' ', e.first_name, e.last_name), '') as "employeeName", coalesce(a.locked_until > now(), false) as locked,
            (a.mfa_enabled_at is not null) as "mfaEnabled"
       from user_accounts a left join roles r on r.id = a.role_id left join employees e on e.employee_id = a.employee_id
      where $1::text is distinct from 'system_admin' or r.role_key = 'super_admin'
      order by a.display_name`,
    [s.role],
  );
  // A System Admin sees only Super Admin accounts (no client staff).
  return clean(rows);
}

export async function createAccount(s: Session, input: { name?: string; username?: string; roleId?: string; employeeId?: string }) {
  demand(s, "create", "roleAssignment");
  const name = String(input.name ?? "").trim();
  const username = String(input.username ?? "").trim().toLowerCase();
  if (!name) throw new UserError("Enter the person's name");
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new UserError("Username: 3 to 30 letters, numbers, dots or dashes, no spaces");
  return tx(async (c) => {
    if ((await c.query(`select 1 from user_accounts where lower(username) = $1`, [username])).rowCount) throw new UserError("That username is taken");
    const role = (await c.query(`select * from roles where id = $1`, [input.roleId ?? ""])).rows[0];
    if (!role) throw new UserError("Choose a role");
    if (!mayAssign(s, role.role_key)) throw new UserError("You can't give that role.", 403);
    const employeeId = input.employeeId || null;
    if (employeeId) {
      if (!(await c.query(`select 1 from employees where employee_id = $1`, [employeeId])).rowCount) throw new UserError("That employee no longer exists");
      // One person, one account.
      const holder = (await c.query(`select username from user_accounts where employee_id = $1`, [employeeId])).rows[0];
      if (holder) throw new UserError(`This person already has an account (username ${holder.username}).`);
    }
    if (role.role_key !== "system_admin") await assertSeatFree(c);
    const password = await tempPassword(c);
    await c.query(
      `insert into user_accounts (username, display_name, password_hash, employee_id, role_id, must_change_password) values ($1, $2, $3, $4, $5, true)`,
      [username, name, await hashPassword(password), employeeId, role.id],
    );
    await log(c, s, "Added user", username, `${name} as ${role.name}`);
    return { username, password };
  });
}

/** No changing your own access, and at least one active Super Admin left. Runs after the change, inside the transaction. */
async function guard(c: Db, s: Session, target: { id: string }) {
  if (target.id === s.accountId) throw new UserError("You can't change your own access. Ask another administrator.");
  if ((await activeSuperAdmins(c)) === 0) throw new UserError("There must always be at least one active Super Admin.");
}

/** The account to change; only when the signed-in person may handle accounts with its role. */
const accountRow = async (c: Db, s: Session, id: string) => {
  const a = (await c.query(`select * from user_accounts where id::text = $1`, [id])).rows[0];
  if (!a) throw new UserError("That account no longer exists", 404);
  if (!mayAssign(s, await roleKey(c, a.role_id))) throw new UserError("You don't have access to do that.", 403);
  return a;
};

export async function setAccountRole(s: Session, id: string, roleId: string) {
  demand(s, "edit", "roleAssignment");
  return tx(async (c) => {
    const a = await accountRow(c, s, id);
    const role = (await c.query(`select * from roles where id = $1`, [roleId])).rows[0];
    if (!role) throw new UserError("Choose a role");
    if (!mayAssign(s, role.role_key)) throw new UserError("You can't give or change that role.", 403);
    if ((await roleKey(c, a.role_id)) === "system_admin" && role.role_key !== "system_admin") await assertSeatFree(c);
    const before = (await c.query(`select name from roles where id = $1`, [a.role_id])).rows[0]?.name ?? "None";
    await c.query(`update user_accounts set role_id = $2 where id = $1`, [a.id, roleId]);
    await guard(c, s, a);
    await log(c, s, "Changed role", a.username, `${before} → ${role.name}`);
  });
}

export async function setAccountStatus(s: Session, id: string, status: string) {
  demand(s, "edit", "roleAssignment");
  if (status !== "active" && status !== "disabled") throw new UserError("Unknown status");
  return tx(async (c) => {
    const a = await accountRow(c, s, id);
    await c.query(`update user_accounts set status = $2 where id = $1`, [a.id, status]);
    await guard(c, s, a);
    // Turning an account off signs it out everywhere.
    if (status === "disabled") await c.query(`delete from user_sessions where account_id = $1`, [a.id]);
    await log(c, s, status === "active" ? "Turned on account" : "Turned off account", a.username, a.display_name);
  });
}

export async function unlockAccount(s: Session, id: string) {
  demand(s, "edit", "roleAssignment");
  return tx(async (c) => {
    const a = await accountRow(c, s, id);
    await c.query(`update user_accounts set locked_until = null, failed_attempts = 0 where id = $1`, [a.id]);
    await log(c, s, "Unlocked account", a.username, a.display_name);
  });
}

export async function resetPassword(s: Session, id: string) {
  demand(s, "edit", "roleAssignment");
  return tx(async (c) => {
    const a = await accountRow(c, s, id);
    const password = await tempPassword(c);
    await c.query(`update user_accounts set password_hash = $2, must_change_password = true, locked_until = null, failed_attempts = 0 where id = $1`, [a.id, await hashPassword(password)]);
    // Sessions that used the old password end.
    await c.query(`delete from user_sessions where account_id = $1`, [a.id]);
    await log(c, s, "Reset password", a.username, a.display_name);
    return { username: a.username, password };
  });
}

/** For someone who lost their phone: turns their two-factor sign-in off and signs them out everywhere. */
export async function resetMfa(s: Session, id: string) {
  demand(s, "edit", "roleAssignment");
  return tx(async (c) => {
    const a = await accountRow(c, s, id);
    if (a.id === s.accountId) throw new UserError("Turn off your own two-factor sign-in in Settings › Security.");
    if (!a.mfa_enabled_at) throw new UserError("Two-factor sign-in is already off for this account.");
    await turnOffMfa(c, a.id);
    await c.query(`delete from user_sessions where account_id = $1`, [a.id]);
    await log(c, s, "Reset two-factor sign-in", a.username, a.display_name);
  });
}

/** Anyone signed in changes their own password. Required after a temporary one. */
export async function changeOwnPassword(s: Session, currentPassword: string, newPassword: string) {
  const a = (await pool.query(`select * from user_accounts where id = $1`, [s.accountId])).rows[0];
  if (!a || !(await verify(a.password_hash, currentPassword))) throw new UserError("Your current password is incorrect.");
  const min = (await settingsRow(pool))?.min_password_length ?? 8;
  if (newPassword.length < min) throw new UserError(`Use at least ${min} characters.`);
  if (newPassword === currentPassword) throw new UserError("Choose a password different from the current one.");
  if (newPassword.toLowerCase().includes(a.username.toLowerCase())) throw new UserError("Don't use your username in your password.");
  await pool.query(`update user_accounts set password_hash = $2, must_change_password = false where id = $1`, [a.id, await hashPassword(newPassword)]);
  await audit(pool, { actorId: a.id, actorName: a.display_name, module: "Sign-in", action: "Changed password", target: a.username });
  return accountJson(pool, a.id);
}

// ---- Settings ----

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_LOGO_BYTES = 1024 * 1024;

/** System settings in the shape of the website's Settings (src/lib/admin/store.ts). The logo is served by /api/files. */
export async function getSettings(db: Db = pool) {
  const r = (await db.query(`select *, to_char(work_start, 'HH24:MI') as start_hm, to_char(work_end, 'HH24:MI') as end_hm from company_settings where id = 1`)).rows[0];
  return {
    companyName: r?.company_name ?? "", tin: r?.tin ?? "", address: r?.address ?? "", contactEmail: r?.contact_email ?? "",
    minPasswordLength: r?.min_password_length ?? 8, lockAfterFailed: r?.lock_after_failed ?? 5, lockMinutes: r?.lock_minutes ?? 15, idleMinutes: r?.idle_minutes ?? 30,
    logo: r?.logo_file_id ? `/api/files/${r.logo_file_id}` : "",
    defaultTimezone: r?.default_timezone ?? "Asia/Manila", currency: r?.currency ?? "PHP",
    workWeek: (r?.work_week as number[] | undefined) ?? [1, 2, 3, 4, 5], workStart: r?.start_hm ?? "08:30", workEnd: r?.end_hm ?? "17:30",
    fiscalYearStartMonth: r?.fiscal_year_start_month ?? 1, retentionMonths: r?.retention_months ?? 0,
  };
}

/** "data:image/png;base64,..." -> bytes, for the company logo. */
function decodeLogo(dataUrl: string) {
  const m = /^data:(image\/(?:png|jpeg|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new UserError("Choose an image file (PNG, JPG or SVG).");
  const bytes = Buffer.from(m[2]!, "base64");
  if (!bytes.length || bytes.length > MAX_LOGO_BYTES) throw new UserError("Choose an image under 1 MB.");
  return { contentType: m[1]!, bytes };
}

export async function saveSettings(s: Session, input: any) {
  demand(s, "edit", "systemSettings");
  const str = (k: string) => String(input?.[k] ?? "").trim();
  const num = (k: string) => Number(input?.[k]);
  const workWeek: number[] = Array.isArray(input?.workWeek) ? [...new Set<number>(input.workWeek.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  const next = {
    companyName: str("companyName"), tin: str("tin"), address: str("address"), contactEmail: str("contactEmail"),
    minPasswordLength: num("minPasswordLength"), lockAfterFailed: num("lockAfterFailed"), lockMinutes: num("lockMinutes"), idleMinutes: num("idleMinutes"),
    logo: str("logo"), defaultTimezone: str("defaultTimezone") || "Asia/Manila", currency: str("currency") || "PHP",
    workWeek, workStart: str("workStart"), workEnd: str("workEnd"), fiscalYearStartMonth: num("fiscalYearStartMonth"), retentionMonths: num("retentionMonths"),
  };
  // Same checks as the Organization page (src/lib/admin/api.ts saveSettings).
  if (!next.companyName) throw new UserError("Enter the company name");
  if (next.tin && !/^\d{3}-\d{3}-\d{3}(-\d{3,5})?$/.test(next.tin)) throw new UserError("TIN looks like 000-000-000-00000");
  if (next.contactEmail && !/^\S+@\S+\.\S+$/.test(next.contactEmail)) throw new UserError("Enter a valid HR email");
  if (!(next.minPasswordLength >= 8 && next.minPasswordLength <= 64)) throw new UserError("Passwords should be at least 8 characters (up to 64)");
  if (!(next.lockAfterFailed >= 3 && next.lockAfterFailed <= 10)) throw new UserError("Lock after 3 to 10 wrong passwords");
  if (!(next.lockMinutes >= 5 && next.lockMinutes <= 1440)) throw new UserError("Lock for 5 minutes to 24 hours");
  if (!(next.idleMinutes >= 5 && next.idleMinutes <= 480)) throw new UserError("Sign out after 5 minutes to 8 hours without activity");
  if (!next.workWeek.length) throw new UserError("Pick at least one working day");
  if (!HHMM.test(next.workStart) || !HHMM.test(next.workEnd)) throw new UserError("Enter the working hours");
  if (!(next.workStart < next.workEnd)) throw new UserError("Working hours must end after they start");
  if (!(Number.isInteger(next.fiscalYearStartMonth) && next.fiscalYearStartMonth >= 1 && next.fiscalYearStartMonth <= 12)) throw new UserError("Pick the month the fiscal year starts");
  if (!(Number.isInteger(next.retentionMonths) && next.retentionMonths >= 0 && next.retentionMonths <= 240)) throw new UserError("Keep records for 0 to 240 months");
  if (next.defaultTimezone.length > 64 || next.currency.length > 8) throw new UserError("Pick a timezone and currency from the lists");
  return tx(async (c) => {
    const before = await getSettings(c);
    // The logo: unchanged (its /api/files link comes back), removed (""), or a new upload (a data URL).
    let logoFileId: string | null = before.logo ? before.logo.slice("/api/files/".length) : null;
    if (next.logo !== before.logo) {
      if (!next.logo) logoFileId = null;
      else {
        const img = decodeLogo(next.logo);
        const sha = createHash("sha256").update(img.bytes).digest("hex");
        logoFileId = (await c.query(
          `insert into files (storage_key, file_name, content_type, size_bytes, sha256, uploaded_by, content) values ('db:' || gen_random_uuid(), $6, $1, $2, $3, $4, $5) returning id`,
          [img.contentType, img.bytes.length, sha, s.accountId, sealBytes(img.bytes), seal("company-logo")],
        )).rows[0].id;
      }
    }
    await c.query(
      `update company_settings set company_name = $1, tin = $2, address = $3, contact_email = $4, min_password_length = $5, lock_after_failed = $6, lock_minutes = $7, idle_minutes = $8,
              logo_file_id = $9, default_timezone = $10, currency = $11, work_week = $12, work_start = $13, work_end = $14, fiscal_year_start_month = $15, retention_months = $16,
              updated_at = now(), updated_by = $17 where id = 1`,
      [next.companyName, next.tin || null, next.address || null, next.contactEmail || null, next.minPasswordLength, next.lockAfterFailed, next.lockMinutes, next.idleMinutes,
        logoFileId, next.defaultTimezone, next.currency, next.workWeek, next.workStart, next.workEnd, next.fiscalYearStartMonth, next.retentionMonths, s.accountId],
    );
    const after = await getSettings(c);
    const labels: Record<keyof typeof after, string> = { companyName: "Company name", tin: "TIN", address: "Address", contactEmail: "HR email", minPasswordLength: "Minimum password length", lockAfterFailed: "Lock after wrong passwords", lockMinutes: "Lock minutes", idleMinutes: "Idle sign-out minutes", logo: "Logo", defaultTimezone: "Default timezone", currency: "Currency", workWeek: "Work week", workStart: "Work starts", workEnd: "Work ends", fiscalYearStartMonth: "Fiscal year start", retentionMonths: "Keep records (months)" };
    const show = (k: keyof typeof after, v: unknown) => (k === "logo" ? (v ? "set" : "none") : Array.isArray(v) ? v.join(",") : String(v || "—"));
    const changed = (Object.keys(labels) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => `${labels[k]}: ${show(k, before[k])} → ${show(k, after[k])}`);
    if (changed.length) await log(c, s, "Changed system settings", "Settings", changed.join("; "));
    return after;
  });
}

// ---- Subscription (SaaS plan and seats) ----

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUB_STATUSES = ["trial", "active", "past_due", "cancelled", "expired"];
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? undefined);

/** The plan in force: the newest one that isn't cancelled or expired. */
async function currentSubscription(db: Db) {
  return (await db.query(`select * from subscriptions where status in ('trial', 'active', 'past_due') order by starts_on desc, created_at desc limit 1`)).rows[0];
}

/** Seats in use: every client account, active or turned off. System Admin accounts (our team) don't count. */
async function seatsUsed(db: Db) {
  return (await db.query(`select count(*)::int as n from user_accounts a join roles r on r.id = a.role_id where r.role_key <> 'system_admin'`)).rows[0].n as number;
}

/** Refuses a new client account when the plan's seats are all taken. Runs inside the account's transaction. */
export async function assertSeatFree(db: Db) {
  // One new account at a time, so two can't both take the last seat.
  await db.query(`select pg_advisory_xact_lock(hashtext('seats'))`);
  const sub = await currentSubscription(db);
  if (sub?.seat_limit && (await seatsUsed(db)) >= sub.seat_limit)
    throw new UserError(`All ${sub.seat_limit} seats on the ${sub.plan_name} plan are in use. Turn off an account you no longer need, or ask us to add seats.`);
}

const subscriptionJson = (r: any) => r && clean({
  id: r.id, planName: r.plan_name, status: r.status, seatLimit: r.seat_limit ?? undefined, billingCycle: r.billing_cycle, pricePerSeat: r.price_per_seat ?? undefined,
  currency: r.currency, startsOn: r.starts_on, currentPeriodEnd: r.current_period_end, trialEndsOn: r.trial_ends_on, cancelledAt: iso(r.cancelled_at), notes: r.notes, updatedAt: iso(r.updated_at),
});

/** The plan, seats used and seat limit (Administration > Subscription & seats). */
export async function getSubscription(s: Session) {
  demand(s, "view", "subscription");
  const sub = await currentSubscription(pool);
  return { subscription: subscriptionJson(sub) ?? null, seatsUsed: await seatsUsed(pool), seatLimit: sub?.seat_limit ?? null };
}

/** Sets or changes the company's plan (our team: System Admin). A changed plan replaces the current one; the old row stays as history. */
export async function saveSubscription(s: Session, body: any) {
  demand(s, "edit", "subscription");
  const str = (k: string) => (body?.[k] === undefined || body?.[k] === null ? "" : String(body[k]).trim());
  const next = {
    planName: str("planName"), status: str("status") || "active", billingCycle: str("billingCycle") || "monthly", currency: str("currency") || "PHP",
    seatLimit: str("seatLimit") === "" ? null : Number(str("seatLimit")), pricePerSeat: str("pricePerSeat") === "" ? null : Number(str("pricePerSeat")),
    startsOn: str("startsOn"), currentPeriodEnd: str("currentPeriodEnd") || null, trialEndsOn: str("trialEndsOn") || null, notes: str("notes") || null,
  };
  if (!next.planName) throw new UserError("Name the plan");
  if (!SUB_STATUSES.includes(next.status)) throw new UserError("Choose the status");
  if (!["monthly", "yearly"].includes(next.billingCycle)) throw new UserError("Choose monthly or yearly billing");
  if (next.seatLimit !== null && !(Number.isInteger(next.seatLimit) && next.seatLimit > 0)) throw new UserError("Seat limit is a whole number above 0, or empty for no limit");
  if (next.pricePerSeat !== null && !(Number.isFinite(next.pricePerSeat) && next.pricePerSeat >= 0)) throw new UserError("Enter the price per seat");
  for (const [k, label] of [["startsOn", "start date"], ["currentPeriodEnd", "renewal date"], ["trialEndsOn", "trial end date"]] as const)
    if (next[k] && !DATE_RE.test(next[k]!)) throw new UserError(`Enter the ${label}`);
  if (next.status === "trial" && !next.trialEndsOn) throw new UserError("Enter when the trial ends");
  return tx(async (c) => {
    await c.query(`lock table subscriptions in share row exclusive mode`);
    const cur = await currentSubscription(c);
    const vals = [next.planName, next.status, next.seatLimit, next.billingCycle, next.pricePerSeat, next.currency, next.currentPeriodEnd, next.trialEndsOn, next.notes, s.accountId];
    let row;
    if (cur && cur.plan_name === next.planName) {
      // Same plan: its details change (status, seats, renewal date...).
      row = (await c.query(
        `update subscriptions set plan_name = $1, status = $2, seat_limit = $3, billing_cycle = $4, price_per_seat = $5, currency = $6, current_period_end = $7, trial_ends_on = $8, notes = $9,
                updated_by = $10, updated_at = now(), cancelled_at = case when $2 = 'cancelled' then coalesce(cancelled_at, now()) else null end${next.startsOn ? ", starts_on = $12" : ""}
          where id = $11 returning *`,
        [...vals, cur.id, ...(next.startsOn ? [next.startsOn] : [])],
      )).rows[0];
    } else {
      // A new plan: the previous one ends.
      if (cur) await c.query(`update subscriptions set status = 'expired', updated_by = $2, updated_at = now() where id = $1`, [cur.id, s.accountId]);
      row = (await c.query(
        `insert into subscriptions (plan_name, status, seat_limit, billing_cycle, price_per_seat, currency, current_period_end, trial_ends_on, notes, created_by, updated_by, starts_on, cancelled_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10, coalesce($11::date, current_date), case when $2 = 'cancelled' then now() end) returning *`,
        [...vals, next.startsOn || null],
      )).rows[0];
    }
    await log(c, s, cur && cur.plan_name === next.planName ? "Changed subscription" : "Set subscription plan", next.planName,
      `${next.status}; seats ${next.seatLimit ?? "no limit"}; ${next.billingCycle}${next.pricePerSeat !== null ? `; ${next.currency} ${next.pricePerSeat}/seat` : ""}`);
    return { subscription: subscriptionJson(row), seatsUsed: await seatsUsed(c), seatLimit: row.status === "cancelled" || row.status === "expired" ? null : row.seat_limit ?? null };
  });
}

// ---- Audit trail ----

/** Sign-in, administration and payroll entries; each role sees its own areas (LIMITS.auditAreas). People, attendance and leave come with those modules' data. */
export async function listAdminAudit(s: Session) {
  demand(s, "view", "audit");
  const areas = LIMITS.auditAreas[s.role ?? "employee"];
  const modules = ["Sign-in", "Administration", "Payroll"].filter((m) => areas === "all" || areas.includes(m));
  const { rows } = await pool.query(
    `select 'db-' || id as id, occurred_at as at, actor_name as actor, module, action, target, coalesce(detail, '') as detail
       from audit_log where module = any($1) order by occurred_at desc limit 5000`,
    [modules],
  );
  return rows;
}

// ---- Self-registration ----

/** Slows down guessing: per address, at most this many tries in the window. */
const REGISTER_TRIES = 8;
const REGISTER_WINDOW_MS = 15 * 60_000;
const registerTries = new Map<string, number[]>();

/**
 * An employee HR already added creates their own sign-in. They prove who they are with
 * the work email and birth date on their 201 File; the account is linked to that record.
 */
export async function registerAccount(ip: string, body: any) {
  const now = Date.now();
  const recent = (registerTries.get(ip) ?? []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (recent.length >= REGISTER_TRIES) throw new UserError("Too many tries. Wait 15 minutes, or ask HR to create your sign-in.", 429);
  registerTries.set(ip, [...recent, now]);

  const email = String(body?.workEmail ?? "").trim().toLowerCase();
  const birthDate = String(body?.birthDate ?? "");
  const username = String(body?.username ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (!email || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) throw new UserError("Enter your work email and birth date");
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new UserError("Username: 3 to 30 letters, numbers, dots or dashes, no spaces");
  const min = (await settingsRow(pool))?.min_password_length ?? 8;
  if (password.length < min) throw new UserError(`Use at least ${min} characters for your password.`);
  if (password.toLowerCase().includes(username)) throw new UserError("Don't use your username in your password.");

  return tx(async (c) => {
    const e = (await c.query(
      `select employee_id, first_name, last_name from employees where lower(email) = $1 and birth_date = $2 and record_status <> 'SEPARATED' for update`,
      [email, birthDate],
    )).rows[0];
    // Same message whichever part didn't match, so the form can't be used to find out who works here.
    if (!e) throw new UserError("We couldn't match that work email and birth date to an employee record. Check both, or ask HR.");
    if ((await c.query(`select 1 from user_accounts where employee_id = $1`, [e.employee_id])).rowCount) throw new UserError("You already have a sign-in. Use it to sign in, or ask HR to reset your password.");
    if ((await c.query(`select 1 from user_accounts where lower(username) = $1`, [username])).rowCount) throw new UserError("That username is taken. Try another.");
    const name = `${e.first_name} ${e.last_name}`;
    await assertSeatFree(c);
    await c.query(
      `insert into user_accounts (username, display_name, password_hash, employee_id, role_id) values ($1, $2, $3, $4, 'employee')`,
      [username, name, await hashPassword(password), e.employee_id],
    );
    await audit(c, { actorName: name, module: "Sign-in", action: "Registered", target: username, employeeNo: e.employee_id, detail: "Created own sign-in with work email and birth date" });
    registerTries.delete(ip);
    return { username, name };
  });
}

// ---- Approval workflows ----

const REQUEST_KINDS = ["leave", "overtime", "undertime", "correction", "profile"] as const;
const WORKFLOW_NAMES: Record<string, string> = { leave: "Leave", overtime: "Overtime", undertime: "Undertime", correction: "Time correction", profile: "Profile change" };

/** Who approves each kind of request. Everyone signed in reads them (the leave screens show the approval path). */
export async function listWorkflows(db: Db = pool) {
  // One after the other: inside a transaction the client can't run two queries at once.
  const flows = await db.query(`select * from approval_workflows order by request_kind`);
  const steps = await db.query(`select * from approval_workflow_steps order by request_kind, step_no`);
  return flows.rows.map((w) => ({
    kind: w.request_kind,
    steps: steps.rows.filter((s) => s.request_kind === w.request_kind).map((s) => clean({ approver: s.approver_kind, roleId: s.role_id, overDays: s.over_days ?? undefined })),
    remindAfterDays: w.remind_after_days,
    active: w.is_active,
  }));
}

export async function saveWorkflow(s: Session, body: any) {
  demand(s, "edit", "rules");
  const kind = String(body?.kind ?? "");
  if (!(REQUEST_KINDS as readonly string[]).includes(kind)) throw new UserError("Unknown kind of request");
  const steps: any[] = Array.isArray(body?.steps) ? body.steps : [];
  const remind = Number(body?.remindAfterDays);
  if (steps.length === 0) throw new UserError("Add at least one approval step");
  if (steps.length > 3) throw new UserError("Keep it to 3 steps or fewer so requests don't get stuck");
  return tx(async (c) => {
    const roles = new Set((await c.query(`select id from roles`)).rows.map((r) => r.id));
    for (const st of steps) {
      if (!["supervisor", "department-head", "role"].includes(st?.approver)) throw new UserError("Choose who approves each step");
      if (st.approver === "role" && !roles.has(st.roleId)) throw new UserError("Choose the role for each 'Anyone with a role' step");
      if (st.overDays !== undefined && st.overDays !== null && (!Number.isFinite(Number(st.overDays)) || Number(st.overDays) < 1)) throw new UserError("The 'only when longer than' days must be 1 or more");
    }
    if (!Number.isFinite(remind) || remind < 0) throw new UserError("Reminder days must be 0 or more");
    await c.query(
      `insert into approval_workflows (request_kind, remind_after_days, is_active) values ($1, $2, $3)
       on conflict (request_kind) do update set remind_after_days = excluded.remind_after_days, is_active = excluded.is_active`,
      [kind, Math.round(remind), body?.active !== false],
    );
    await c.query(`delete from approval_workflow_steps where request_kind = $1`, [kind]);
    for (const [i, st] of steps.entries()) {
      await c.query(`insert into approval_workflow_steps (request_kind, step_no, approver_kind, role_id, over_days) values ($1,$2,$3,$4,$5)`,
        [kind, i + 1, st.approver, st.approver === "role" ? st.roleId : null, st.overDays ? Number(st.overDays) : null]);
    }
    const describe = steps.map((st) => (st.approver === "role" ? `role ${st.roleId}` : st.approver) + (st.overDays ? ` (over ${st.overDays} days)` : "")).join(" → ");
    await log(c, s, "Changed approval workflow", WORKFLOW_NAMES[kind]!, describe);
    return (await listWorkflows(c)).find((w) => w.kind === kind);
  });
}

/** The starting workflows: HR approves everything. Same as DEFAULT_WORKFLOWS in src/lib/admin/store.ts. */
export async function seedWorkflows(c: Db) {
  const defaults: [string, number][] = [["leave", 2], ["overtime", 2], ["undertime", 2], ["correction", 1], ["profile", 3]];
  for (const [kind, remind] of defaults) {
    const { rowCount } = await c.query(`insert into approval_workflows (request_kind, remind_after_days) values ($1, $2) on conflict do nothing`, [kind, remind]);
    if (rowCount) await c.query(`insert into approval_workflow_steps (request_kind, step_no, approver_kind, role_id) values ($1, 1, 'role', 'hr')`, [kind]);
  }
}
