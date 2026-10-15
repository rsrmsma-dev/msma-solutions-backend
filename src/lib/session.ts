// The signed-in person as the mock API sees them: like a server reading the session, it looks up
// the account stored at sign-in, never trusting what a page says about itself. Every API that
// reads or changes data asks `deny(feature, action, employeeId?)` first (lib/permissions.ts).

import { admin, roleOf, type UserAccount } from "./admin/store";
import { fullName, state as core } from "./corehr/store";
import { currentAdmin, currentEmployee, currentManager } from "./mockData";
import { can, canFor, ForbiddenError, type Action, type Feature, type Who } from "./permissions";

/** Where AuthContext keeps the signed-in account (see features/auth/AuthContext.tsx). */
const ACCOUNT_KEY = "msma-hris-account";

/** The employee record behind an account: the one linked in Users, or the demo login's profile. */
export function employeeOfAccount(a: UserAccount | undefined): string | undefined {
  if (!a) return undefined;
  if (a.employeeId) return a.employeeId;
  const name = a.demo === "employee" ? currentEmployee.name : a.demo === "hr" ? currentAdmin.name : a.demo === "approver" ? currentManager.name : a.name;
  if (a.demo === "employee") return currentEmployee.id;
  const wanted = name.trim().toLowerCase();
  return core.employees.find((e) => e.job.status !== "Separated" && fullName(e.personal).toLowerCase() === wanted)?.id;
}

/** Active employees whose supervisor is this employee. */
export function teamOf(employeeId: string | undefined): string[] {
  if (!employeeId) return [];
  return core.employees.filter((e) => e.job.supervisorId === employeeId && e.job.status !== "Separated").map((e) => e.id);
}

export function whoFor(accountId: string | undefined | null): Who {
  const account = admin.accounts.find((a) => a.id === accountId && a.status === "active");
  const role = roleOf(account)?.key ?? null;
  const employeeId = employeeOfAccount(account);
  return { role, employeeId, team: teamOf(employeeId) };
}

/** The signed-in account's ID, as a session cookie would carry it. */
export function sessionAccountId(): string | undefined {
  try {
    return localStorage.getItem(ACCOUNT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

const SIGNED_IN_AT_KEY = "msma-hris-signed-in-at";

/** Stamps a new sign-in, so things closed "for this session" show again next time. */
export function markSignInTime() {
  try {
    localStorage.setItem(SIGNED_IN_AT_KEY, String(Date.now()));
  } catch {
    // Storage blocked: nothing to remember.
  }
}

/** When the current session began (empty when unknown). */
export function signInTime(): string {
  try {
    return localStorage.getItem(SIGNED_IN_AT_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Whoever is signed in right now (no one: no access to anything). */
export function sessionWho(): Who {
  try {
    return whoFor(localStorage.getItem(ACCOUNT_KEY));
  } catch {
    return { role: null, team: [] };
  }
}

const refuse = (message?: string): Promise<never> => new Promise((_, reject) => setTimeout(() => reject(new ForbiddenError(message)), 150));

/**
 * The API's permission check. Returns a rejected promise (403) to hand straight back when the
 * signed-in person may not do this, or null when they may. With an employee ID, the record must
 * also be inside their scope (own / team).
 */
export function deny(feature: Feature, action: Action, employeeId?: string): Promise<never> | null {
  const who = sessionWho();
  const ok = employeeId === undefined ? can(who, action, feature) : canFor(who, action, feature, employeeId);
  return ok ? null : refuse();
}

/** The same check for synchronous helpers: throws a 403 instead of returning one. */
export function assertCan(feature: Feature, action: Action, employeeId?: string) {
  const who = sessionWho();
  const ok = employeeId === undefined ? can(who, action, feature) : canFor(who, action, feature, employeeId);
  if (!ok) throw new ForbiddenError();
}

export { refuse as forbidden };
