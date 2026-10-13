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
  constructor(message: string, public status = 400) {
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

