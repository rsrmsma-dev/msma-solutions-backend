// PostgreSQL connection. DATABASE_URL comes from server/.env (see setup-db.ps1).

import pg from "pg";

// Return DATE as "yyyy-mm-dd" (not a JS Date shifted by the time zone) and NUMERIC as a number.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Run server/setup-db.ps1 first; it writes server/.env.");
  process.exit(1);
}

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 10) });

// A dropped connection (database restart, network blip) is logged and replaced, not fatal.
pool.on("error", (err) => console.error("Database connection lost:", err.message));

export type Db = pg.Pool | pg.PoolClient;

/** Runs fn in one transaction; rolls back if it throws. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    c.release();
    return out;
  } catch (e) {
    let broken = false;
    await c.query("ROLLBACK").catch(() => (broken = true));
    c.release(broken);
    throw e;
  }
}

/** An error whose message is safe to show the user (a 4xx). */
export class UserError extends Error {
  /** `code` goes out with the message for errors the website tells apart (e.g. SEAT_LIMIT_REACHED). */
  constructor(message: string, public status = 400, public code?: string) {
    super(message);
  }
}

/** Drops null fields so responses match the frontend's optional (undefined) fields. */
export function clean<T>(row: T): T {
  if (Array.isArray(row)) return row.map(clean) as T;
  if (row && typeof row === "object" && !(row instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) out[k] = clean(v);
    return out as T;
  }
  return row;
}

// Migration 019 (holiday calendar, leave policy and scheduling columns, personal settings). Until it's
// applied, reads fall back to the defaults so the API keeps working as before, and saves say what's missing.
let has019 = false;
let warned019 = false;
export async function schema019(db: Db = pool): Promise<boolean> {
  if (has019) return true;
  const { rows } = await db.query(
    `select to_regclass('holiday_rules') is not null and to_regclass('holiday_changes') is not null and to_regclass('user_preferences') is not null
            and exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'company_settings' and column_name = 'schedule_publish_lead_days') as ok`,
  );
  has019 = rows[0].ok === true;
  if (!has019 && !warned019) {
    warned019 = true;
    console.warn("Database migration 019_holidays_org_settings isn't applied: holidays, leave policy, scheduling rules and personal settings use the defaults until it is.");
  }
  return has019;
}

/** For saves that need migration 019. */
export async function need019(db: Db = pool) {
  if (!(await schema019(db))) throw new UserError("The database needs an update (migration 019) before this can be saved. Ask your administrator to apply it.", 503);
}

// Migration 020 (company policies, the outbox, where a clock-in from home was made). Until it's applied,
// reads come back empty, clocking in from home works without saving the location, and saves say what's missing.
let has020 = false;
let warned020 = false;
export async function schema020(db: Db = pool): Promise<boolean> {
  if (has020) return true;
  const { rows } = await db.query(
    `select to_regclass('company_policies') is not null and to_regclass('policy_acknowledgements') is not null and to_regclass('outbox_messages') is not null
            and exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'punches' and column_name = 'location') as ok`,
  );
  has020 = rows[0].ok === true;
  if (!has020 && !warned020) {
    warned020 = true;
    console.warn("Database migration 020_policies_outbox_wfh_location isn't applied: company policies and the outbox are empty, and locations of clock-ins from home aren't saved, until it is.");
  }
  return has020;
}

/** For saves that need migration 020. */
export async function need020(db: Db = pool) {
  if (!(await schema020(db))) throw new UserError("The database needs an update (migration 020) before this can be saved. Ask your administrator to apply it.", 503);
}

// Migration 023 (an office's contact person). Until it's applied, offices are listed without one and saving an office says what's missing.
let has023 = false;
export async function need023(db: Db = pool) {
  if (!has023) {
    const { rows } = await db.query(`select exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'org_units' and column_name = 'contact_phone') as ok`);
    has023 = rows[0].ok === true;
  }
  if (!has023) throw new UserError("The database needs an update (migration 023) before this can be saved. Ask your administrator to apply it.", 503);
}


// Migration 024 (how a claim was released, certificate issuing / pickup / decline, support tickets). Until
// it's applied, tickets are empty, certificates list without the new details, and saves say what's missing.
let has024 = false;
let warned024 = false;
export async function schema024(db: Db = pool): Promise<boolean> {
  if (has024) return true;
  const { rows } = await db.query(
    `select to_regclass('support_tickets') is not null and to_regclass('support_ticket_messages') is not null
            and exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'certificate_requests' and column_name = 'issued_statement')
            and exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'reimbursement_claims' and column_name = 'release_method') as ok`,
  );
  has024 = rows[0].ok === true;
  if (!has024 && !warned024) {
    warned024 = true;
    console.warn("Database migration 024_claims_certificates_support isn't applied: support tickets are empty, and releasing claims other than by bank transfer and issuing or declining certificates wait until it is.");
  }
  return has024;
}

/** For saves that need migration 024. */
export async function need024(db: Db = pool) {
  if (!(await schema024(db))) throw new UserError("The database needs an update (migration 024) before this can be saved. Ask your administrator to apply it.", 503);
}

// Migration 025 (subscription plans, the client's seat override / extension / alert levels, the
// subscription event log). Until it's applied there is no plan, so nothing is limited, the event log
// is empty, and the System Admin's changes say what's missing.
let has025 = false;
let warned025 = false;
export async function schema025(db: Db = pool): Promise<boolean> {
  if (has025) return true;
  const { rows } = await db.query(
    `select to_regclass('subscription_plans') is not null and to_regclass('subscription_events') is not null
            and exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'subscriptions' and column_name = 'last_seat_alert') as ok`,
  );
  has025 = rows[0].ok === true;
  if (!has025 && !warned025) {
    warned025 = true;
    console.warn("Database migration 025_subscription_seats isn't applied: no plan is set, so employee seats and admin accounts aren't limited, until it is.");
  }
  return has025;
}

/** For saves that need migration 025. */
export async function need025(db: Db = pool) {
  if (!(await schema025(db))) throw new UserError("The database needs an update (migration 025) before this can be saved. Ask your administrator to apply it.", 503);
}

// Migration 026 (bell notifications). Until it's applied, nothing is sent to the bell, the bell is
// empty, and every action works as before.
let has026 = false;
let warned026 = false;
export async function schema026(db: Db = pool): Promise<boolean> {
  if (has026) return true;
  const { rows } = await db.query(`select to_regclass('notifications') is not null as ok`);
  has026 = rows[0].ok === true;
  if (!has026 && !warned026) {
    warned026 = true;
    console.warn("Database migration 026_notifications isn't applied: bell notifications aren't sent or shown until it is.");
  }
  return has026;
}

// Migration 027 (paydays, each employee's pay settings, a six-day shift's Saturday end). Until it's
// applied, the paydays are the 10th and 25th, everyone is on a 5-day week with no allowances, shifts
// have no separate Saturday end, and saving any of these says what's missing.
let has027 = false;
let warned027 = false;
export async function schema027(db: Db = pool): Promise<boolean> {
  if (has027) return true;
  const { rows } = await db.query(
    `select to_regclass('employee_pay_profiles') is not null
            and exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'company_settings' and column_name = 'payday_first')
            and exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'shift_templates' and column_name = 'saturday_end') as ok`,
  );
  has027 = rows[0].ok === true;
  if (!has027 && !warned027) {
    warned027 = true;
    console.warn("Database migration 027_pay_settings isn't applied: paydays stay on the 10th and 25th, pay settings and Saturday end times can't be saved until it is.");
  }
  return has027;
}

// Migration 028 (share of salary charged to a client; leave earned by length of service). Until it's
// applied, nobody's salary is charged to a client and that kind of leave type can't be saved.
let has028 = false;
export async function schema028(db: Db = pool): Promise<boolean> {
  if (has028) return true;
  const { rows } = await db.query(`select exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'employee_pay_profiles' and column_name = 'client_share') as ok`);
  has028 = rows[0].ok === true;
  return has028;
}

// Migration 030 (start and end times on overtime and undertime requests). Until it's applied, a
// request keeps only its minutes.
let has030 = false;
export async function schema030(db: Db = pool): Promise<boolean> {
  if (has030) return true;
  const { rows } = await db.query(`select exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'time_requests' and column_name = 'start_at') as ok`);
  has030 = rows[0].ok === true;
  return has030;
}

/** For saves that need migration 027. */
export async function need027(db: Db = pool) {
  if (!(await schema027(db))) throw new UserError("The database needs an update (migration 027) before this can be saved. Ask your administrator to apply it.", 503);
}
