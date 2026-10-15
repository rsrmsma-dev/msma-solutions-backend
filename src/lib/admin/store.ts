// Administration & Security data: user accounts, roles and their access,
// approval workflows, system settings and the admin log. Saved to localStorage.

import type { DemoKey } from "../credentials";
import { ROLE_DESCRIPTION, ROLE_LABEL, type RoleKey } from "../permissions";
import type { Role } from "../types";

export type ModuleKey = "people" | "company" | "documents" | "timekeeping" | "leave" | "reimbursements" | "reports" | "payroll" | "administration";
export type Access = "none" | "view" | "edit" | "approve";

export const MODULES: { key: ModuleKey; label: string; approvable?: boolean }[] = [
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

export interface SystemRole {
  id: string;
  /** Which of the six roles this is (lib/permissions.ts). */
  key: RoleKey;
  name: string;
  description: string;
  /** Which workspace the role signs into. */
  workspace: Role;
  builtIn: boolean;
  /** Can manage roles, system settings and other Super Admins. */
  superAdmin?: boolean;
  /** Access per HR-workspace module. Ignored for the Employee and Partner workspaces. */
  access: Record<ModuleKey, Access>;
}

export interface UserAccount {
  id: string;
  name: string;
  username: string;
  /** Demo accounts sign in with the credentials in Settings; others with this. */
  password?: string;
  /** Set for the three built-in demo logins. */
  demo?: DemoKey;
  employeeId?: string;
  roleId: string;
  status: "active" | "disabled";
  mustChangePassword?: boolean;
  lastSignIn?: string;
  failedAttempts: number;
  lockedUntil?: string;
  createdAt: string;
  /** Who added the account, and their role at the time. */
  createdBy?: string;
  createdByRole?: string;
}

export type RequestKind = "leave" | "overtime" | "undertime" | "correction" | "profile";
export type ApproverKind = "supervisor" | "department-head" | "role";

export interface WorkflowStep {
  approver: ApproverKind;
  /** For approver = "role". */
  roleId?: string;
  /** Only add this step for leave longer than this many days. */
  overDays?: number;
}

export interface Workflow {
  kind: RequestKind;
  steps: WorkflowStep[];
  /** Remind the approver after this many days without action (0 = never). */
  remindAfterDays: number;
  active: boolean;
}

export interface Settings {
  companyName: string;
  tin: string;
  address: string;
  contactEmail: string;
  minPasswordLength: number;
  lockAfterFailed: number;
  lockMinutes: number;
  idleMinutes: number;
  /** Company logo as a data URL ("" = none). TODO(backend): file storage; not printed on documents yet. */
  logo: string;
  /** Timezone for anyone who hasn't chosen their own (Settings > Account). */
  defaultTimezone: string;
  /** TODO: payroll is in pesos only, so this is stored but amounts aren't converted or relabelled yet. */
  currency: string;
  /** Working days, 0 = Sunday … 6 = Saturday. Leave filed in working days skips the rest. */
  workWeek: number[];
  /** Standard working hours, "08:30" – "17:30". */
  workStart: string;
  workEnd: string;
  /** 1 = January. */
  fiscalYearStartMonth: number;
  /** Months to keep records (0 = keep everything). TODO(backend): a scheduled job to remove older records. */
  retentionMonths: number;
}

export interface AdminLog {
  id: string;
  at: string;
  actor: string;
  module: "Administration" | "Sign-in" | "Payroll" | "Settings";
  action: string;
  target: string;
  detail: string;
}

export interface AdminState {
  roles: SystemRole[];
  accounts: UserAccount[];
  workflows: Workflow[];
  settings: Settings;
  log: AdminLog[];
  /** 2 once the team requests moved from HR to the employee's supervisor. */
  workflowsVersion?: number;
  /** See ROLES_VERSION. */
  rolesVersion?: number;
}

const KEY = "heyhr-admin-v3";

const all = (a: Access): Record<ModuleKey, Access> => ({ people: a, company: a, documents: a, timekeeping: a, leave: a, reimbursements: a, reports: a, payroll: a, administration: a });

/**
 * The six fixed roles. What each can do is in lib/permissions.ts (the access matrix); `access`
 * here is kept only so older code and saved data still load.
 */
const role = (id: string, key: RoleKey, workspace: Role, extra: Partial<SystemRole> = {}): SystemRole => ({
  id,
  key,
  name: ROLE_LABEL[key],
  description: ROLE_DESCRIPTION[key],
  workspace,
  builtIn: true,
  access: all("none"),
  ...extra,
});

export const DEFAULT_ROLES: SystemRole[] = [
  role("system-admin", "system_admin", "admin"),
  role("super-admin", "super_admin", "admin", { superAdmin: true }),
  role("hr", "hr", "admin"),
  role("approver", "approver", "manager"),
  role("accounting", "accounting", "admin"),
  role("employee", "employee", "employee"),
];

/**
 * Bumped when roles change. 3: the six fixed roles. Older saved roles map onto them once:
 * Super Admin → super_admin; Admin and HR → hr; Employee → employee; a Partner (manager) role →
 * approver; Accountant → accounting; anything else (custom roles) → employee, the least access, for
 * a Super Admin to review. (2 was an earlier trial whose saved data also needs moving.)
 */
const ROLES_VERSION = 3;
/** Demo logins that no longer exist; their accounts are removed when saved data loads. */
const REMOVED_DEMO_IDS = ["ua-partner-mora", "ua-partner-menoza"];
const EMPLOYEE_DEMO_USERNAME = "ceb.msma";
const EMPLOYEE_DEMO_ID = "MSMA-00846";
const ROLE_UPGRADE: Record<string, string> = { "super-admin": "super-admin", admin: "hr", hr: "hr", employee: "employee", accountant: "accounting", manager: "approver" };

const DEFAULT_SETTINGS: Settings = {
  companyName: "MSMA Group",
  tin: "",
  address: "Cebu City, Cebu",
  contactEmail: "hr@msma.ph",
  minPasswordLength: 8,
  lockAfterFailed: 5,
  lockMinutes: 15,
  idleMinutes: 30,
  logo: "",
  defaultTimezone: "Asia/Manila",
  currency: "PHP",
  workWeek: [1, 2, 3, 4, 5],
  workStart: "08:30",
  workEnd: "17:30",
  fiscalYearStartMonth: 1,
  retentionMonths: 0,
};

const DEFAULT_WORKFLOWS: Workflow[] = [
  // Managers and supervisors (the Approver role) decide their team's requests; see lib/permissions.ts.
  { kind: "leave", steps: [{ approver: "supervisor" }], remindAfterDays: 2, active: true },
  { kind: "overtime", steps: [{ approver: "supervisor" }], remindAfterDays: 2, active: true },
  { kind: "undertime", steps: [{ approver: "supervisor" }], remindAfterDays: 2, active: true },
  { kind: "correction", steps: [{ approver: "supervisor" }], remindAfterDays: 1, active: true },
  { kind: "profile", steps: [{ approver: "role", roleId: "hr" }], remindAfterDays: 3, active: true },
];

function seed(): AdminState {
  const at = "2026-01-05T09:00:00";
  return {
    roles: DEFAULT_ROLES,
    accounts: [
      { id: "ua-super", name: "System Administrator", username: "superadmin", demo: "superadmin", roleId: "super-admin", status: "active", failedAttempts: 0, createdAt: at },
      { id: "ua-admin", name: "Office Administrator", username: "admin", demo: "admin", roleId: "hr", status: "active", failedAttempts: 0, createdAt: at },
      { id: "ua-hr", name: "Dinah Marquez", username: "admin1", demo: "hr", roleId: "hr", status: "active", failedAttempts: 0, createdAt: at },
      { id: "ua-employee", name: "Chris S. David", username: "ceb.msma", demo: "employee", employeeId: "MSMA-00846", roleId: "employee", status: "active", failedAttempts: 0, createdAt: at },
      { id: "ua-sysadmin", name: "System Admin (demo)", username: "sysadmin", demo: "sysadmin", roleId: "system-admin", status: "active", failedAttempts: 0, createdAt: at },
      { id: "ua-approver", name: "Approver", username: "approver", demo: "approver", roleId: "approver", status: "active", failedAttempts: 0, createdAt: at },
      { id: "ua-accounting", name: "Accounting (demo)", username: "accounting", demo: "accounting", roleId: "accounting", status: "active", failedAttempts: 0, createdAt: at },
    ],
    workflows: DEFAULT_WORKFLOWS,
    settings: DEFAULT_SETTINGS,
    log: [],
    rolesVersion: ROLES_VERSION,
    workflowsVersion: 2,
  };
}

/** One-time move to the six fixed roles (see ROLES_VERSION). Every change is written to the audit log. */
function upgradeRoles(s: AdminState): AdminState {
  const at = new Date().toISOString();
  const workspaceOf = (roleId: string) => s.roles?.find((r) => r.id === roleId)?.workspace;
  const log: AdminLog[] = [];
  const accounts = (s.accounts ?? []).map((a) => {
    const next = ROLE_UPGRADE[a.roleId] ?? (workspaceOf(a.roleId) === "manager" ? "approver" : DEFAULT_ROLES.some((r) => r.id === a.roleId) ? a.roleId : "employee");
    if (next === a.roleId) return a;
    const from = s.roles?.find((r) => r.id === a.roleId)?.name ?? a.roleId;
    log.push({ id: `al-up-${a.id}`, at, actor: "System", module: "Administration", action: "Changed role", target: a.username, detail: `${from} → ${DEFAULT_ROLES.find((r) => r.id === next)!.name} (move to the six fixed roles)` });
    return { ...a, roleId: next };
  });
  const fresh = seed();
  const missing = fresh.accounts.filter((a) => a.demo && !accounts.some((x) => x.demo === a.demo || x.username === a.username));
  return { ...fresh, ...s, roles: DEFAULT_ROLES, accounts: [...accounts, ...missing], log: [...log, ...(s.log ?? [])], settings: { ...DEFAULT_SETTINGS, ...s.settings }, rolesVersion: ROLES_VERSION };
}

function load(): AdminState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as AdminState;
      // Only request types this version knows (an older build saved a "reimbursement" workflow), and every one of them.
      const knownKinds = new Set<string>(DEFAULT_WORKFLOWS.map((w) => w.kind));
      const saved = (s.workflows ?? []).filter((w) => knownKinds.has(w.kind));
      s.workflows = [...saved, ...DEFAULT_WORKFLOWS.filter((d) => !saved.some((w) => w.kind === d.kind))];
      // Saved before the six fixed roles: move accounts onto them once.
      if ((s.rolesVersion ?? 1) < ROLES_VERSION) {
        const upgraded = upgradeRoles(s);
        localStorage.setItem(KEY, JSON.stringify(upgraded));
        return upgraded;
      }
      // The employee demo login moved from "admin2" to "ceb.msma". A "ceb.msma" account made on User
      // accounts is the person it's meant for: the demo login takes over its person and name (so it
      // signs in as them, not the default demo employee), and the hand-made duplicate goes.
      const handMade = (s.accounts ?? []).find((a) => a.username === EMPLOYEE_DEMO_USERNAME && !a.demo);
      if (handMade || (s.accounts ?? []).some((a) => a.demo === "employee" && a.username === "admin2")) {
        s.accounts = s.accounts
          .filter((a) => a !== handMade)
          .map((a) => (a.demo === "employee" ? { ...a, username: EMPLOYEE_DEMO_USERNAME, ...(handMade ? { name: handMade.name, employeeId: handMade.employeeId } : {}) } : a));
        localStorage.setItem(KEY, JSON.stringify(s));
      }
      // The employee demo login is Chris S. David.
      if ((s.accounts ?? []).some((a) => a.demo === "employee" && a.employeeId !== EMPLOYEE_DEMO_ID)) {
        s.accounts = s.accounts.map((a) => (a.demo === "employee" ? { ...a, name: "Chris S. David", employeeId: EMPLOYEE_DEMO_ID } : a));
        localStorage.setItem(KEY, JSON.stringify(s));
      }
      // Demo logins that were removed (two Partner logins) are deleted from saved data too.
      const removed = (s.accounts ?? []).some((a) => REMOVED_DEMO_IDS.includes(a.id));
      const loaded = { ...seed(), ...s, accounts: (s.accounts ?? []).filter((a) => !REMOVED_DEMO_IDS.includes(a.id)), roles: DEFAULT_ROLES, settings: { ...DEFAULT_SETTINGS, ...s.settings } };
      if (removed) localStorage.setItem(KEY, JSON.stringify(loaded));
      // Safety net: never leave an account on a role that no longer exists, or a demo login missing.
      const known = new Set(DEFAULT_ROLES.map((r) => r.id));
      if (loaded.accounts.some((a) => !known.has(a.roleId)) || seed().accounts.some((a) => a.demo && !loaded.accounts.some((x) => x.demo === a.demo))) {
        const fixed = upgradeRoles(loaded);
        localStorage.setItem(KEY, JSON.stringify(fixed));
        return fixed;
      }
      // Team requests used to go to HR; send the untouched HR defaults to the supervisor once.
      if ((s.workflowsVersion ?? 1) < 2) {
        const team = ["leave", "overtime", "undertime", "correction"];
        const byDefault = (w: Workflow) => team.includes(w.kind) && w.steps.length === 1 && w.steps[0].approver === "role" && w.steps[0].roleId === "hr";
        const moved = { ...loaded, workflows: loaded.workflows.map((w) => (byDefault(w) ? { ...w, steps: [{ approver: "supervisor" as const }] } : w)), workflowsVersion: 2 };
        localStorage.setItem(KEY, JSON.stringify(moved));
        return moved;
      }
      return loaded;
    }
  } catch {
    // Storage blocked or corrupt: start from the seed.
  }
  return seed();
}

export let admin: AdminState = load();

export function saveAdmin(next: AdminState) {
  admin = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Non-fatal in the prototype.
  }
}

export function logAdmin(entry: Omit<AdminLog, "id" | "at">) {
  const log: AdminLog = { ...entry, id: `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString() };
  saveAdmin({ ...admin, log: [log, ...admin.log].slice(0, 2000) });
}

export const roleOf = (account: UserAccount | undefined) => admin.roles.find((r) => r.id === account?.roleId);

export const isSuperAdmin = (accountId: string | undefined) => roleOf(admin.accounts.find((a) => a.id === accountId))?.key === "super_admin";

/** Modules that don't open the HR workspace by themselves: system setup and payroll (the CEO runs both). */
export const NON_HR_MODULES: ModuleKey[] = ["administration", "payroll"];
