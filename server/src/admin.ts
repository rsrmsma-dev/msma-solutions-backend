// Administration & Security: user accounts, roles and their access, system
// settings, and the sign-in / administration audit trail. Ported from
// src/lib/admin/api.ts with the same rules (Super Admin guards, at least one
// active Super Admin, nobody changes their own access).

import { randomInt } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { accountJson, audit, demand, hashPassword, type Access, type ModuleKey, type Session } from "./auth";
import { clean, pool, tx, UserError, type Db } from "./db";

const MODULES: { key: ModuleKey; label: string; approvable?: boolean }[] = [
  { key: "people", label: "People" },
  { key: "company", label: "Org chart" },
  { key: "documents", label: "Documents" },
  { key: "timekeeping", label: "Timekeeping & Attendance", approvable: true },
  { key: "leave", label: "Leave Management", approvable: true },
  { key: "reimbursements", label: "Reimbursements", approvable: true },
  { key: "reports", label: "Reports & Analytics" },
  { key: "payroll", label: "Payroll & contributions" },
  { key: "administration", label: "Administration & Security" },
];
const ACCESS_LABEL: Record<Access, string> = { none: "No access", view: "View only", edit: "View and edit", approve: "Edit and approve" };
const SUPER_ONLY = "Only a Super Admin can do this.";

const log = (db: Db, s: Session, action: string, target: string, detail = "") =>
  audit(db, { actorId: s.accountId, actorName: s.name, module: "Administration", action, target, detail });

async function isSuper(db: Db, accountId: string) {
  const { rows } = await db.query(`select r.is_super_admin from user_accounts a join roles r on r.id = a.role_id where a.id = $1`, [accountId]);
  return !!rows[0]?.is_super_admin;
}
const roleIsSuper = async (db: Db, roleId: string) => !!(await db.query(`select is_super_admin from roles where id = $1`, [roleId])).rows[0]?.is_super_admin;
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

export async function listRoles(withCounts: boolean, db: Db = pool) {
  const { rows } = await db.query(
    `select r.id, r.name, r.description, r.workspace, r.is_built_in as "builtIn", r.is_super_admin as "superAdmin",
            (select count(*)::int from user_accounts a where a.role_id = r.id) as users,
            coalesce(json_object_agg(m.module, m.access) filter (where m.module is not null), '{}') as access
       from roles r left join role_module_access m on m.role_id = r.id
      group by r.id order by r.is_built_in desc, r.name`,
  );
  return rows.map((r) => {
    const access = Object.fromEntries(MODULES.map((m) => [m.key, (r.access as Record<string, Access>)[m.key] ?? "none"]));
    const out = { ...r, access, ...(r.superAdmin ? {} : { superAdmin: undefined }) };
    if (!withCounts) delete out.users;
    return clean(out);
  });
}

export async function saveRole(s: Session, input: { id?: string; name?: string; description?: string; access?: Record<ModuleKey, Access> }) {
  if (!(await isSuper(pool, s.accountId))) throw new UserError(SUPER_ONLY, 403);
  const name = String(input.name ?? "").trim();
  if (!name) throw new UserError("Name the role");
  return tx(async (c) => {
    if ((await c.query(`select 1 from roles where lower(name) = lower($1) and id is distinct from $2`, [name, input.id ?? null])).rowCount) throw new UserError("There's already a role with that name");
    const existing = input.id ? (await c.query(`select * from roles where id = $1`, [input.id])).rows[0] : undefined;
    if (input.id && !existing) throw new UserError("That role no longer exists", 404);
    if (existing?.is_super_admin) throw new UserError("The Super Admin role is fixed: it runs the system and has no access to employee data.");
    // "Approve" only applies to modules with requests.
    const access = Object.fromEntries(
      MODULES.map((m) => {
        const a = (input.access?.[m.key] ?? "none") as Access;
        return [m.key, !["none", "view", "edit", "approve"].includes(a) ? "none" : !m.approvable && a === "approve" ? "edit" : a];
      }),
    ) as Record<ModuleKey, Access>;
    const myRole = (await c.query(`select role_id from user_accounts where id = $1`, [s.accountId])).rows[0]?.role_id;
    if (existing && myRole === existing.id && access.administration !== "edit") throw new UserError("This is your own role. Removing its Administration access would lock you out.");
    const before = existing ? Object.fromEntries((await c.query(`select module, access from role_module_access where role_id = $1`, [existing.id])).rows.map((r) => [r.module, r.access])) : {};
    const id = existing?.id ?? `role-${Date.now().toString(36)}`;
    const description = String(input.description ?? "").trim();
    if (existing) await c.query(`update roles set name = $2, description = $3 where id = $1`, [id, name, description]);
    else await c.query(`insert into roles (id, name, description, workspace) values ($1, $2, $3, 'admin')`, [id, name, description]);
    for (const m of MODULES) {
      await c.query(`insert into role_module_access (role_id, module, access) values ($1, $2, $3) on conflict (role_id, module) do update set access = excluded.access`, [id, m.key, access[m.key]]);
    }
    const changes = existing ? MODULES.filter((m) => (before[m.key] ?? "none") !== access[m.key]).map((m) => `${m.label}: ${ACCESS_LABEL[(before[m.key] ?? "none") as Access]} → ${ACCESS_LABEL[access[m.key]]}`) : [];
    await log(c, s, existing ? "Changed role access" : "Added role", name, existing ? changes.join("; ") || "Name or description" : description);
    return (await listRoles(false, c)).find((r: { id: string }) => r.id === id);
  });
}

export async function deleteRole(s: Session, id: string) {
  if (!(await isSuper(pool, s.accountId))) throw new UserError(SUPER_ONLY, 403);
  return tx(async (c) => {
    const role = (await c.query(`select * from roles where id = $1`, [id])).rows[0];
    if (!role) throw new UserError("That role no longer exists", 404);
    if (role.is_built_in) throw new UserError("Built-in roles can't be deleted");
    const users = (await c.query(`select count(*)::int as n from user_accounts where role_id = $1`, [id])).rows[0].n;
    if (users) throw new UserError(`${users} ${users === 1 ? "user has" : "users have"} this role. Move them to another role first.`);
    await c.query(`delete from approval_workflow_steps where role_id = $1`, [id]);
    await c.query(`delete from roles where id = $1`, [id]);
    await log(c, s, "Deleted role", role.name);
  });
}

// ---- Accounts ----

export async function listAccounts(s: Session) {
  demand(s, "administration", "view");
  const { rows } = await pool.query(
    `select a.id, a.display_name as name, a.username, a.builtin_key as demo, a.employee_id as "employeeId", a.role_id as "roleId", a.status,
            a.must_change_password as "mustChangePassword", a.last_sign_in_at as "lastSignIn", a.failed_attempts as "failedAttempts",
            a.locked_until as "lockedUntil", a.created_at as "createdAt", coalesce(r.name, 'No role') as "roleName",
            nullif(concat_ws(' ', e.first_name, e.last_name), '') as "employeeName", coalesce(a.locked_until > now(), false) as locked
       from user_accounts a left join roles r on r.id = a.role_id left join employees e on e.employee_id = a.employee_id
      order by a.display_name`,
  );
  return clean(rows);
}

export async function createAccount(s: Session, input: { name?: string; username?: string; roleId?: string; employeeId?: string }) {
  demand(s, "administration", "edit");
  const name = String(input.name ?? "").trim();
  const username = String(input.username ?? "").trim().toLowerCase();
  if (!name) throw new UserError("Enter the person's name");
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new UserError("Username: 3 to 30 letters, numbers, dots or dashes, no spaces");
  return tx(async (c) => {
    if ((await c.query(`select 1 from user_accounts where lower(username) = $1`, [username])).rowCount) throw new UserError("That username is taken");
    const role = (await c.query(`select * from roles where id = $1`, [input.roleId ?? ""])).rows[0];
    if (!role) throw new UserError("Choose a role");
    if (role.is_super_admin && !(await isSuper(c, s.accountId))) throw new UserError(SUPER_ONLY, 403);
    const employeeId = input.employeeId || null;
    if (employeeId) {
      if (!(await c.query(`select 1 from employees where employee_id = $1`, [employeeId])).rowCount) throw new UserError("That employee no longer exists");
      if ((await c.query(`select 1 from user_accounts where employee_id = $1`, [employeeId])).rowCount) throw new UserError("That employee already has a sign-in");
    }
    const password = await tempPassword(c);
    await c.query(
      `insert into user_accounts (username, display_name, password_hash, employee_id, role_id, must_change_password) values ($1, $2, $3, $4, $5, true)`,
      [username, name, await hashPassword(password), employeeId, role.id],
    );
    await log(c, s, "Added user", username, `${name} as ${role.name}`);
    return { username, password };
  });
}

/** Super Admin guards, no changing your own access, and at least one active Super Admin left. Runs after the change, inside the transaction. */
async function guard(c: Db, s: Session, target: { id: string; role_id: string }, newRoleId: string) {
  if (((await roleIsSuper(c, target.role_id)) || (await roleIsSuper(c, newRoleId))) && !(await isSuper(c, s.accountId)))
    throw new UserError("Only a Super Admin can change a Super Admin account or give the Super Admin role.", 403);
  if (target.id === s.accountId) throw new UserError("You can't change your own access. Ask another HR administrator.");
  if ((await activeSuperAdmins(c)) === 0) throw new UserError("There must always be at least one active Super Admin.");
}

const accountRow = async (c: Db, id: string) => {
  const a = (await c.query(`select * from user_accounts where id::text = $1`, [id])).rows[0];
  if (!a) throw new UserError("That account no longer exists", 404);
  return a;
};

export async function setAccountRole(s: Session, id: string, roleId: string) {
  demand(s, "administration", "edit");
  return tx(async (c) => {
    const a = await accountRow(c, id);
    const role = (await c.query(`select * from roles where id = $1`, [roleId])).rows[0];
    if (!role) throw new UserError("Choose a role");
    const before = (await c.query(`select name from roles where id = $1`, [a.role_id])).rows[0]?.name ?? "None";
    await c.query(`update user_accounts set role_id = $2 where id = $1`, [a.id, roleId]);
    await guard(c, s, a, roleId);
    await log(c, s, "Changed role", a.username, `${before} → ${role.name}`);
  });
}

export async function setAccountStatus(s: Session, id: string, status: string) {
  demand(s, "administration", "edit");
  if (status !== "active" && status !== "disabled") throw new UserError("Unknown status");
  return tx(async (c) => {
    const a = await accountRow(c, id);
    await c.query(`update user_accounts set status = $2 where id = $1`, [a.id, status]);
    await guard(c, s, a, a.role_id);
    // Turning an account off signs it out everywhere.
    if (status === "disabled") await c.query(`delete from user_sessions where account_id = $1`, [a.id]);
    await log(c, s, status === "active" ? "Turned on account" : "Turned off account", a.username, a.display_name);
  });
}

export async function unlockAccount(s: Session, id: string) {
  demand(s, "administration", "edit");
  return tx(async (c) => {
    const a = await accountRow(c, id);
    if ((await roleIsSuper(c, a.role_id)) && !(await isSuper(c, s.accountId))) throw new UserError(SUPER_ONLY, 403);
    await c.query(`update user_accounts set locked_until = null, failed_attempts = 0 where id = $1`, [a.id]);
    await log(c, s, "Unlocked account", a.username, a.display_name);
  });
}

export async function resetPassword(s: Session, id: string) {
  demand(s, "administration", "edit");
  return tx(async (c) => {
    const a = await accountRow(c, id);
    if ((await roleIsSuper(c, a.role_id)) && !(await isSuper(c, s.accountId))) throw new UserError(SUPER_ONLY, 403);
    const password = await tempPassword(c);
    await c.query(`update user_accounts set password_hash = $2, must_change_password = true, locked_until = null, failed_attempts = 0 where id = $1`, [a.id, await hashPassword(password)]);
    // Sessions that used the old password end.
    await c.query(`delete from user_sessions where account_id = $1`, [a.id]);
    await log(c, s, "Reset password", a.username, a.display_name);
    return { username: a.username, password };
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

export async function getSettings() {
  const r = await settingsRow(pool);
  return {
    companyName: r?.company_name ?? "", tin: r?.tin ?? "", address: r?.address ?? "", contactEmail: r?.contact_email ?? "",
    minPasswordLength: r?.min_password_length ?? 8, lockAfterFailed: r?.lock_after_failed ?? 5, lockMinutes: r?.lock_minutes ?? 15, idleMinutes: r?.idle_minutes ?? 30,
  };
}

export async function saveSettings(s: Session, input: any) {
  if (!(await isSuper(pool, s.accountId))) throw new UserError(SUPER_ONLY, 403);
  const str = (k: string) => String(input?.[k] ?? "").trim();
  const num = (k: string) => Number(input?.[k]);
  const next = {
    companyName: str("companyName"), tin: str("tin"), address: str("address"), contactEmail: str("contactEmail"),
    minPasswordLength: num("minPasswordLength"), lockAfterFailed: num("lockAfterFailed"), lockMinutes: num("lockMinutes"), idleMinutes: num("idleMinutes"),
  };
  if (!next.companyName) throw new UserError("Enter the company name");
  if (next.tin && !/^\d{3}-\d{3}-\d{3}(-\d{3,5})?$/.test(next.tin)) throw new UserError("TIN looks like 000-000-000-00000");
  if (next.contactEmail && !/^\S+@\S+\.\S+$/.test(next.contactEmail)) throw new UserError("Enter a valid HR email");
  if (!(next.minPasswordLength >= 8 && next.minPasswordLength <= 64)) throw new UserError("Passwords should be at least 8 characters (up to 64)");
  if (!(next.lockAfterFailed >= 3 && next.lockAfterFailed <= 10)) throw new UserError("Lock after 3 to 10 wrong passwords");
  if (!(next.lockMinutes >= 5 && next.lockMinutes <= 1440)) throw new UserError("Lock for 5 minutes to 24 hours");
  if (!(next.idleMinutes >= 5 && next.idleMinutes <= 480)) throw new UserError("Sign out after 5 minutes to 8 hours without activity");
  const before = await getSettings();
  await pool.query(
    `update company_settings set company_name = $1, tin = $2, address = $3, contact_email = $4, min_password_length = $5, lock_after_failed = $6, lock_minutes = $7, idle_minutes = $8, updated_at = now(), updated_by = $9 where id = 1`,
    [next.companyName, next.tin || null, next.address || null, next.contactEmail || null, next.minPasswordLength, next.lockAfterFailed, next.lockMinutes, next.idleMinutes, s.accountId],
  );
  const labels: Record<keyof typeof next, string> = { companyName: "Company name", tin: "TIN", address: "Address", contactEmail: "HR email", minPasswordLength: "Minimum password length", lockAfterFailed: "Lock after wrong passwords", lockMinutes: "Lock minutes", idleMinutes: "Idle sign-out minutes" };
  const changed = (Object.keys(labels) as (keyof typeof next)[]).filter((k) => before[k] !== next[k]).map((k) => `${labels[k]}: ${before[k] || "—"} → ${next[k] || "—"}`);
  if (changed.length) await log(pool, s, "Changed system settings", "Settings", changed.join("; "));
  return getSettings();
}

// ---- Audit trail (sign-in and administration; other modules add their own) ----

export async function listAdminAudit(s: Session) {
  demand(s, "administration", "view");
  const { rows } = await pool.query(
    `select 'db-' || id as id, occurred_at as at, actor_name as actor, module, action, target, coalesce(detail, '') as detail
       from audit_log where module in ('Sign-in', 'Administration') order by occurred_at desc limit 5000`,
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
  demand(s, "administration", "edit");
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
