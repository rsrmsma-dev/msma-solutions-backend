// One-time (safe to re-run): encrypts what was saved before encryption came in (ID numbers, leave,
// case and separation reasons, uploaded files and their names) and fills in the government numbers' fingerprints.
// Anything already encrypted is left alone.
//   npm --prefix server run encrypt-ids

import { fingerprint, isSealed, isSealedBytes, seal, sealBytes } from "./crypto.js";
import { pool, tx } from "./db.js";

/** Encrypted text columns; `hash` columns keep the uniqueness check (migration 009). */
const TABLES = [
  { table: "employees", key: "employee_id", cols: ["sss_no", "philhealth_no", "pagibig_no", "tin"], hash: true },
  { table: "employee_documents", key: "id", cols: ["reference_no", "file_name"], hash: false },
  { table: "professional_licenses", key: "id", cols: ["license_number"], hash: false },
  { table: "leave_requests", key: "id", cols: ["reason", "attachment_name"], hash: false },
  { table: "files", key: "id", cols: ["file_name"], hash: false },
  { table: "employee_cases", key: "id", cols: ["summary"], hash: false },
  { table: "offboarding_cases", key: "id", cols: ["reason"], hash: false },
] as const;

const counts = await tx(async (c) => {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const { rows } = await c.query(`select ${t.key} as key, ${t.cols.join(", ")} from ${t.table} for update`);
    let changed = 0;
    for (const r of rows) {
      // [column, value] pairs to write: the encrypted number (and its fingerprint).
      const pairs = (t.cols as readonly string[])
        .filter((col) => r[col] && !isSealed(r[col]))
        .flatMap((col): [string, string | null][] => [[col, seal(r[col])], ...(t.hash ? [[`${col}_hash`, fingerprint(r[col])] as [string, string | null]] : [])]);
      if (!pairs.length) continue;
      const sets = pairs.map(([col], i) => `${col} = $${i + 2}`).join(", ");
      await c.query(`update ${t.table} set ${sets} where ${t.key} = $1`, [r.key, ...pairs.map(([, v]) => v)]);
      changed++;
    }
    out[t.table] = changed;
  }
  // Uploaded files: the bytes themselves.
  const files = await c.query(`select id, content from files where content is not null for update`);
  let n = 0;
  for (const f of files.rows) {
    if (isSealedBytes(f.content)) continue;
    await c.query(`update files set content = $2 where id = $1`, [f.id, sealBytes(f.content)]);
    n++;
  }
  out["file contents"] = n;
  return out;
});
console.log(`Encrypted: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")} (rows).`);
await pool.end();
