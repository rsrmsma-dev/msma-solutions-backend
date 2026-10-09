// Sign-in, sessions and access. What each role may do is the team's access matrix in
// src/lib/permissions.ts, the same table the website's pages and buttons read.

import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool, UserError, type Db } from "./db.js";
import { matrixRole, type AccountRole } from "./hierarchy.js";
import { can as allowed, canFor, scopeFor, visible, type Action, type Feature, type RoleKey, type Scope, type Who } from "../../src/lib/permissions";

export const COOKIE = "heyhr_session";
const MAX_SESSION_HOURS = 12;

export interface Session {
  accountId: string;
  name: string;
  username: string;
  roleId: string;
  /** Which of the six roles the access table knows (src/lib/permissions.ts); Admin counts as Super Admin. */
  role: RoleKey | null;
  /** The account's own role, Admin included (server/src/hierarchy.ts). */
  accountRole: AccountRole | null;
  workspace: "employee" | "manager" | "admin";
  /** EMPLOYEE_ID of the linked employee, if any. */
  employeeNo?: string;
  /** EMPLOYEE_IDs of their direct reports (active), for "team" access. */
  team: string[];
  /** Signed in with a temporary password: only changing it is allowed. */
  mustChangePassword: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export const hashPassword = (p: string) => hash(p, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
/** Checked against when the username doesn't exist (see signIn). */
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** How a session token is stored (only its hash). */
export const sessionHash = sha256;
/** A sign-in waiting for its two-factor code may only enter the code, for this long. */
const MFA_WAIT_MINUTES = 5;

export async function audit(db: Db, e: { actorId?: string; actorName: string; module: string; action: string; target: string; employeeNo?: string; detail?: string }) {
  await db.query(
    `insert into audit_log (actor_account_id, actor_name, module, action, target, employee_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.actorId ?? null, e.actorName, e.module, e.action, e.target, e.employeeNo ?? null, e.detail ?? null],
  );
}

/**
 * The account in the shape the frontend's Administration store uses. Every account here is a real
 * one, so no "demo" key is sent (the website would otherwise treat it as a demo login).
 */
export async function accountJson(db: Db, id: string) {
  const { rows } = await db.query(
    `select a.id, a.display_name as name, a.username, a.employee_id as "employeeId", a.role_id as "roleId",
            a.status, a.must_change_password as "mustChangePassword", a.last_sign_in_at as "lastSignIn",
            a.failed_attempts as "failedAttempts", a.locked_until as "lockedUntil", a.created_at as "createdAt", r.workspace,
            (a.mfa_enabled_at is not null) as "mfaEnabled"
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
  // An unknown username takes as long as a wrong password, so timing doesn't reveal which usernames exist.
  if (!a) {
    await verify(await DUMMY_HASH, password).catch(() => false);
    return failed("Incorrect username or password.", "Unknown username");
  }
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

  const token = randomBytes(32).toString("base64url");
  // Two-factor sign-in: the password was right, but the session can only enter the code until it is.
  if (a.mfa_enabled_at) {
    await pool.query(`insert into user_sessions (token_hash, account_id, expires_at, user_agent, mfa_pending) values ($1, $2, now() + make_interval(mins => $3), $4, true)`, [
      sha256(token), a.id, MFA_WAIT_MINUTES, userAgent?.slice(0, 300) ?? null,
    ]);
    await audit(pool, { actorId: a.id, actorName: a.display_name, module: "Sign-in", action: "Password accepted", target: a.username, detail: "Waiting for the two-factor code" });
    return { token, mfaRequired: true as const };
  }
  await pool.query(`update user_accounts set failed_attempts = 0, locked_until = null, last_sign_in_at = now() where id = $1`, [a.id]);
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
      where s.token_hash = $1 and a.id = s.account_id and a.status = 'active' and not s.mfa_pending
        and s.expires_at > now() and s.last_seen_at > now() - make_interval(mins => $2)
      returning a.id, a.display_name, a.username, a.role_id, r.role_key, r.workspace, a.employee_id, a.must_change_password`,
    [sha256(token), idle_minutes],
  );
  const r = rows[0];
  if (!r) {
    // Ended, idle or expired: removed. A sign-in still waiting for its two-factor code stays until it expires.
    await pool.query(`delete from user_sessions where token_hash = $1 and (not mfa_pending or expires_at <= now())`, [sha256(token)]);
    return undefined;
  }
  const team = r.employee_id
    ? (await pool.query(`select employee_id from employees where supervisor_id = $1 and record_status <> 'SEPARATED'`, [r.employee_id])).rows.map((x) => x.employee_id as string)
    : [];
  return { accountId: r.id, name: r.display_name, username: r.username, roleId: r.role_id, role: matrixRole(r.role_key), accountRole: r.role_key ?? null, workspace: r.workspace, employeeNo: r.employee_id ?? undefined, team, mustChangePassword: r.must_change_password };
}

/** Fastify preHandler: 401 unless signed in. */
export async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  req.session = await loadSession(req);
  if (!req.session) return reply.code(401).send({ error: "Your session has ended. Please sign in again." });
  // The website has no "set a new password" screen, so a temporary password isn't forced to change here.
}

/** The signed-in person as the access matrix sees them. */
export const whoOf = (s: Session): Who => ({ role: s.role, employeeId: s.employeeNo, team: s.team });

/** May they do this (at all, or to this employee's record when one is given)? */
export function can(s: Session, action: Action, feature: Feature, employeeNo?: string) {
  return employeeNo === undefined ? allowed(whoOf(s), action, feature) : canFor(whoOf(s), action, feature, employeeNo);
}

export function demand(s: Session, action: Action, feature: Feature, employeeNo?: string) {
  if (!can(s, action, feature, employeeNo)) throw new UserError("You don't have access to do that.", 403);
}

/** Everyone, their team, only themselves, or null for no access. */
export const scopeOf = (s: Session, action: Action, feature: Feature): Scope | null => scopeFor(whoOf(s), action, feature);

/** The rows they may see, by the employee each row belongs to. */
export const seen = <T,>(s: Session, feature: Feature, rows: T[], employeeOf: (r: T) => string | undefined): T[] => visible(whoOf(s), feature, rows, employeeOf);

/** EMPLOYEE_IDs whose records they may see for this feature, or "all". */
export function seenIds(s: Session, feature: Feature, action: Action = "view"): "all" | string[] {
  const sc = scopeOf(s, action, feature);
  if (sc === "all") return "all";
  if (sc === "team") return s.team;
  if (sc === "own") return s.employeeNo ? [s.employeeNo] : [];
  return [];
}
