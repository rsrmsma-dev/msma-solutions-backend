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
