// Loads the starting setup into an empty database: company settings, the org
// structure and positions, the six roles, and a starting sign-in for each role.
// No employees. Safe to re-run: it skips anything already there.
//
// Built-in passwords match src/lib/credentials.ts. Change them after first sign-in.

import { hashPassword } from "./auth.js";
import { pool, tx } from "./db.js";
import { seedTypes } from "./leave.js";
import { seedShifts } from "./timekeeping.js";
import { seedRates } from "./payroll.js";
import { seedWorkflows } from "./admin.js";
import { LIMITS, ROLE_DESCRIPTION, ROLE_LABEL, type RoleKey } from "../../src/lib/permissions";

const BRANCHES = [
  { name: "Cebu HQ", code: "CEB", address: "8F Park Centrale Tower, Cebu IT Park, Lahug, Cebu City" },
  { name: "Manila", code: "MNL", address: "21F Zuellig Building, Makati Avenue, Makati City" },
  { name: "Davao", code: "DVO", address: "3F Abreeza Corporate Center, J.P. Laurel Avenue, Davao City" },
];
const DEPARTMENT_CODES: Record<string, string> = {
  "Audit & Assurance": "AUD", "Tax Advisory": "TAX", Bookkeeping: "BKP", "Corporate Legal": "LEG", "Admin & Support": "ADM", "Human Resources": "HRD", Partners: "PTR",
};
const TEAMED = new Set(["Audit & Assurance", "Tax Advisory"]);
/** [branch, department, position, team]; one row per budgeted slot. Same as src/lib/corehr/store.ts. */
const ORG_SEED: [string, string, string, string][] = [
  ["Cebu HQ", "Partners", "Partner", "ADS"], ["Cebu HQ", "Partners", "Partner", "RPM"], ["Cebu HQ", "Partners", "Partner", "VCM"],
  ["Cebu HQ", "Tax Advisory", "Experienced Associate", "RPM"], ["Cebu HQ", "Audit & Assurance", "Associate Director", "VCM"],
  ["Cebu HQ", "Audit & Assurance", "Junior Associate", "VCM"], ["Manila", "Corporate Legal", "Experienced Associate", "ADS"],
  ["Davao", "Bookkeeping", "Experienced Associate", "RPM"], ["Cebu HQ", "Audit & Assurance", "Experienced Associate", "VCM"],
  ["Cebu HQ", "Audit & Assurance", "Junior Associate", "ADS"], ["Cebu HQ", "Audit & Assurance", "Junior Associate", "RPM"],
  ["Cebu HQ", "Audit & Assurance", "Junior Associate", "VCM"], ["Cebu HQ", "Tax Advisory", "Junior Associate", "ADS"],
  ["Davao", "Bookkeeping", "Experienced Associate", "RPM"], ["Manila", "Corporate Legal", "Executive Assistant / Secretary", "ADS"],
  ["Cebu HQ", "Admin & Support", "BSS Team Leader", "ADS"], ["Cebu HQ", "Admin & Support", "Experienced Admin Assistant", "VCM"],
];
const levelFor = (t: string) => (/^partner$/i.test(t) ? "Executive" : /director/i.test(t) ? "Manager" : /lead|supervisor/i.test(t) ? "Supervisor" : "Rank and file");
const acronym = (t: string) => t.split(/\s+/).map((w) => w[0]).join("").toUpperCase();

// The six fixed roles (src/lib/admin/store.ts DEFAULT_ROLES; names and descriptions from src/lib/permissions.ts).
const ROLES = (["system_admin", "super_admin", "hr", "approver", "accounting", "employee"] as RoleKey[]).map((key) => ({
  id: key.replace("_", "-"), key, name: ROLE_LABEL[key], description: ROLE_DESCRIPTION[key], workspace: LIMITS.workspace[key],
}));
/** Starting sign-ins, one per role. `key` marks the ones created at setup before the six roles. Change the passwords after first sign-in. */
const ACCOUNTS = [
  { key: "superadmin", username: "superadmin", password: "Heyhr-Super-2026!", name: "System Administrator", role: "super-admin" },
  { key: "admin", username: "admin", password: "Heyhr-Admin-2026!", name: "Office Administrator", role: "hr" },
  { key: "hr", username: "admin1", password: "Heyhr-HR-2026!", name: "HR", role: "hr" },
  { key: "employee", username: "admin2", password: "Heyhr-Staff-2026!", name: "Employee", role: "employee" },
  { key: null, username: "sysadmin", password: "Heyhr-SysAdmin-2026!", name: "System Admin", role: "system-admin" },
  { key: null, username: "approver", password: "Heyhr-Approver-2026!", name: "Approver", role: "approver" },
  { key: null, username: "accounting", password: "Heyhr-Accounting-2026!", name: "Accounting", role: "accounting" },
];

await tx(async (c) => {
  await c.query(`insert into company_settings (id, company_name, address, contact_email) values (1, 'MSMA Group', 'Cebu City, Cebu', 'hr@msma.ph') on conflict do nothing`);

  for (const r of ROLES) {
    await c.query(`insert into roles (id, role_key, name, description, workspace, is_built_in, is_super_admin) values ($1,$2,$3,$4,$5,true,$6) on conflict do nothing`, [r.id, r.key, r.name, r.description, r.workspace, r.key === "super_admin"]);
  }
  await seedTypes(c);
  await seedShifts(c);
  await seedRates(c);
  await seedWorkflows(c);

  for (const a of ACCOUNTS) {
    const exists = await c.query(`select 1 from user_accounts where builtin_key = $1 or lower(username) = $2`, [a.key, a.username]);
    if (!exists.rowCount) await c.query(`insert into user_accounts (username, builtin_key, display_name, password_hash, role_id) values ($1,$2,$3,$4,$5)`, [a.username, a.key, a.name, await hashPassword(a.password), a.role]);
  }

  if ((await c.query(`select 1 from org_units limit 1`)).rowCount) return console.log("Org structure already present; left as is.");
  const ins = async (type: string, name: string, code: string, parent: string | null, address?: string) =>
    (await c.query(`insert into org_units (unit_type, name, code, parent_id, address) values ($1,$2,$3,$4,$5) returning id`, [type, name, code, parent, address ?? null])).rows[0].id as string;
  const company = await ins("company", "MSMA Group", "MSMA", null);
  const branch: Record<string, string> = {};
  for (const b of BRANCHES) branch[b.name] = await ins("branch", b.name, b.code, company, b.address);
  const dept: Record<string, string> = {}, team: Record<string, string> = {};
  const deptId = async (office: string, d: string) => (dept[`${office}|${d}`] ??= await ins("department", d, DEPARTMENT_CODES[d] ?? d.slice(0, 3).toUpperCase(), branch[office]!));
  await deptId("Cebu HQ", "Human Resources");

  const slots = new Map<string, { office: string; dept: string; title: string; n: number }>();
  for (const [office, d, title, cluster] of ORG_SEED) {
    const dId = await deptId(office, d);
    if (TEAMED.has(d)) team[`${dId}|${cluster}`] ??= await ins("team", cluster, cluster, dId);
    const k = `${office}|${d}|${title}`;
    slots.set(k, { office, dept: d, title, n: (slots.get(k)?.n ?? 0) + 1 });
  }
  const positions: { id: string; dept: string; level: string }[] = [];
  for (const p of slots.values()) {
    const level = levelFor(p.title);
    const n = level === "Rank and file" && p.n >= 2 ? p.n + 1 : p.n; // a little headroom
    const d = dept[`${p.office}|${p.dept}`]!;
    const { rows } = await c.query(`insert into positions (title, code, department_id, job_level, default_employment_type, budgeted_slots) values ($1,$2,$3,$4,'REGULAR',$5) returning id`, [p.title, acronym(p.title), d, level, n]);
    positions.push({ id: rows[0].id, dept: d, level });
  }
  const hr = dept["Cebu HQ|Human Resources"]!;
  const { rows } = await c.query(`insert into positions (title, code, department_id, job_level, default_employment_type, budgeted_slots, description) values ('Experienced Admin Assistant','EAA',$1,'Rank and file','PROBATIONARY',2,'Recruitment, onboarding and 201 file upkeep.') returning id`, [hr]);
  positions.push({ id: rows[0].id, dept: hr, level: "Rank and file" });
  // Rank-and-file report to their department's supervisory position.
  for (const p of positions.filter((x) => x.level === "Rank and file")) {
    const lead = positions.find((x) => x.dept === p.dept && x.level !== "Rank and file");
    if (lead) await c.query(`update positions set reports_to_position_id = $2 where id = $1`, [p.id, lead.id]);
  }
  console.log(`Seeded ${Object.keys(dept).length} departments, ${Object.keys(team).length} teams, ${positions.length} positions.`);
});
console.log("Roles and built-in sign-ins are ready.");
await pool.end();
