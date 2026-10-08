// Sign-in, sessions and module access.

import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool, UserError, type Db } from "./db.js";

export const COOKIE = "heyhr_session";
const MAX_SESSION_HOURS = 12;

export type ModuleKey = "people" | "company" | "documents" | "timekeeping" | "leave" | "reimbursements" | "reports" | "payroll" | "administration";
export type Access = "none" | "view" | "edit" | "approve";
const RANK: Record<Access, number> = { none: 0, view: 1, edit: 2, approve: 3 };

export interface Session {
  accountId: string;
  name: string;
  username: string;
  roleId: string;
  workspace: "employee" | "manager" | "admin";
  /** EMPLOYEE_ID of the linked employee, if any. */
  employeeNo?: string;
  access: Record<ModuleKey, Access>;
  /** Signed in with a temporary password: only changing it is allowed. */
  mustChangePassword: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export const hashPassword = (p: string) => hash(p, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function audit(db: Db, e: { actorId?: string; actorName: string; module: string; action: string; target: string; employeeNo?: string; detail?: string }) {
  await db.query(
    `insert into audit_log (actor_account_id, actor_name, module, action, target, employee_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.actorId ?? null, e.actorName, e.module, e.action, e.target, e.employeeNo ?? null, e.detail ?? null],
  );
}

/** The account in the shape the frontend's Administration store uses. */
export async function accountJson(db: Db, id: string) {
  const { rows } = await db.query(
    `select a.id, a.display_name as name, a.username, a.builtin_key as demo, a.employee_id as "employeeId", a.role_id as "roleId",
            a.status, a.must_change_password as "mustChangePassword", a.last_sign_in_at as "lastSignIn",
            a.failed_attempts as "failedAttempts", a.locked_until as "lockedUntil", a.created_at as "createdAt", r.workspace
       from user_accounts a join roles r on r.id = a.role_id
      where a.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const { workspace, ...account } = r;
  for (const k of Object.keys(account)) if (account[k] === null) delete account[k];
  return { workspace, account };
}

async function settings() {
  const { rows } = await pool.query(`select lock_after_failed, lock_minutes, idle_minutes from company_settings where id = 1`);
  return rows[0] ?? { lock_after_failed: 5, lock_minutes: 15, idle_minutes: 30 };
}

export async function signIn(username: string, password: string, userAgent: string | undefined) {
  const u = username.trim().toLowerCase();
  const { rows } = await pool.query(
    `select a.*, r.id as role_ok from user_accounts a left join roles r on r.id = a.role_id where lower(a.username) = $1`,
    [u],
  );
  const a = rows[0];
  const s = await settings();
  const now = new Date();
  const failed = async (error: string, detail: string) => {
    await audit(pool, { actorId: a?.id, actorName: a?.display_name ?? (u || "(blank)"), module: "Sign-in", action: "Failed sign-in", target: u || "(blank)", detail });
    throw new UserError(error, 401);
  };
  if (!a) return failed("Incorrect username or password.", "Unknown username");
  if (a.locked_until && new Date(a.locked_until) > now) {
    const mins = Math.ceil((new Date(a.locked_until).getTime() - now.getTime()) / 60000);
    return failed(`Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? "" : "s"}, or ask HR to unlock your account.`, "Account locked");
  }
  if (!(await verify(a.password_hash, password))) {
    const n = a.failed_attempts + 1;
    const lock = n >= s.lock_after_failed;
    await pool.query(`update user_accounts set failed_attempts = $2, locked_until = $3 where id = $1`, [
      a.id,
      lock ? 0 : n,
      lock ? new Date(now.getTime() + s.lock_minutes * 60000) : a.locked_until,
    ]);
    return failed(
      lock ? `Too many wrong passwords. Your account is locked for ${s.lock_minutes} minutes.` : "Incorrect username or password.",
      lock ? `Wrong password; locked after ${n} tries` : `Wrong password (${n} of ${s.lock_after_failed})`,
    );
  }
  if (a.status === "disabled") return failed("This account has been turned off. Please contact HR.", "Account turned off");
  if (!a.role_ok) return failed("This account has no role yet. Please contact HR.", "No role");

  await pool.query(`update user_accounts set failed_attempts = 0, locked_until = null, last_sign_in_at = now() where id = $1`, [a.id]);
  const token = randomBytes(32).toString("base64url");
  await pool.query(`insert into user_sessions (token_hash, account_id, expires_at, user_agent) values ($1, $2, now() + make_interval(hours => $3), $4)`, [
    sha256(token),
    a.id,
    MAX_SESSION_HOURS,
    userAgent?.slice(0, 300) ?? null,
  ]);
  await audit(pool, { actorId: a.id, actorName: a.display_name, module: "Sign-in", action: "Signed in", target: a.username, detail: a.role_id });
  return { token, ...(await accountJson(pool, a.id))! };
}

export async function signOut(token: string | undefined, reason: "manual" | "idle") {
  if (!token) return;
  const { rows } = await pool.query(
    `delete from user_sessions s using user_accounts a where s.token_hash = $1 and a.id = s.account_id returning a.id, a.display_name, a.username`,
    [sha256(token)],
  );
  const a = rows[0];
  if (a) await audit(pool, { actorId: a.id, actorName: a.display_name, module: "Sign-in", action: reason === "idle" ? "Signed out (inactive)" : "Signed out", target: a.username });
}

/** Loads the session from the cookie; idle or expired sessions are removed. */
export async function loadSession(req: FastifyRequest): Promise<Session | undefined> {
  const token = req.cookies[COOKIE];
  if (!token) return undefined;
  const { idle_minutes } = await settings();
  const { rows } = await pool.query(
    `update user_sessions s set last_seen_at = now()
       from user_accounts a join roles r on r.id = a.role_id
      where s.token_hash = $1 and a.id = s.account_id and a.status = 'active'
        and s.expires_at > now() and s.last_seen_at > now() - make_interval(mins => $2)
      returning a.id, a.display_name, a.username, a.role_id, r.workspace, a.employee_id, a.must_change_password`,
    [sha256(token), idle_minutes],
  );
  const r = rows[0];
  if (!r) {
    await pool.query(`delete from user_sessions where token_hash = $1`, [sha256(token)]);
    return undefined;
  }
  const access = Object.fromEntries(
    ["people", "company", "documents", "timekeeping", "leave", "reimbursements", "reports", "payroll", "administration"].map((m) => [m, "none"]),
  ) as Record<ModuleKey, Access>;
  const acc = await pool.query(`select module, access from role_module_access where role_id = $1`, [r.role_id]);
  for (const x of acc.rows) access[x.module as ModuleKey] = x.access;
  return { accountId: r.id, name: r.display_name, username: r.username, roleId: r.role_id, workspace: r.workspace, employeeNo: r.employee_id ?? undefined, access, mustChangePassword: r.must_change_password };
}

/** Fastify preHandler: 401 unless signed in. */
export async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  req.session = await loadSession(req);
  if (!req.session) return reply.code(401).send({ error: "Your session has ended. Please sign in again." });
  if (req.session.mustChangePassword && req.url !== "/api/auth/change-password")
    return reply.code(403).send({ error: "Set a new password before continuing." });
}

export function can(s: Session, module: ModuleKey, needed: Access) {
  return RANK[s.access[module]] >= RANK[needed];
}

export function demand(s: Session, module: ModuleKey, needed: Access) {
  if (!can(s, module, needed)) throw new UserError("You don't have access to do that.", 403);
}
