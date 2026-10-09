// Role-based access: the ONE place that says what each role can do. The sidebars, pages, buttons
// (through can / useCan) and the mock API (through deny / inScope) all read this table, so hiding
// something and refusing it always agree. Change access here, nowhere else.
//
// A cell is a level, optionally with a scope after a colon:
//   full           view, create, edit, delete (and approve)
//   manage         view, create, edit
//   approve        view, approve / decline
//   final          view, final approval (only after an approver has approved)
//   view           read only
//   own            create and view their own records only
//   none           hidden in the UI, refused by the API
// "manage+final" combines levels. Scopes: all (default), team (the person's direct reports in
// Core HR) and own (their own records; implied by "own").
// No imports on purpose: the data stores read role names from here when they load.

export type RoleKey = "system_admin" | "super_admin" | "hr" | "approver" | "accounting" | "employee";
export type Level = "full" | "manage" | "approve" | "final" | "view" | "own" | "none";
export type Scope = "all" | "team" | "own";
export type Action = "view" | "create" | "edit" | "delete" | "approve" | "final";

export const ROLE_LABEL: Record<RoleKey, string> = {
  system_admin: "System Admin",
  super_admin: "Super Admin",
  hr: "HR",
  approver: "Approver",
  accounting: "Accounting",
  employee: "Employee",
};

export const ROLE_DESCRIPTION: Record<RoleKey, string> = {
  system_admin: "Our development team. Plan and seats, and setting up a client's first Super Admin. No access to client data.",
  super_admin: "The client, usually their IT. Full access within the company; handles the initial setup.",
  hr: "HR staff. Employee records, leave, attendance setup and rules. Views payroll reports; never sees claims.",
  approver: "Managers and supervisors. Approve their own team's claims, overtime, undertime and time adjustments.",
  accounting: "Accountants. Prepare and give final approval on payroll; final approval and payout of claims.",
  employee: "Regular employees. File leave and claims and see their own records.",
};

type Cell = string;
type Row = Record<RoleKey, Cell>;

/** Features (rows of the approved access matrix). */
export const PERMISSIONS = {
  dashboard: { label: "Home dashboard", system_admin: "none", super_admin: "full", hr: "view", approver: "view:team", accounting: "view", employee: "own" },
  people: { label: "Maintenance › People (incl. 201 file)", system_admin: "none", super_admin: "full", hr: "full", approver: "view:team", accounting: "view", employee: "own" },
  departments: { label: "Maintenance › Departments", system_admin: "none", super_admin: "full", hr: "full", approver: "view", accounting: "view", employee: "none" },
  locations: { label: "Maintenance › Locations", system_admin: "none", super_admin: "full", hr: "full", approver: "view", accounting: "view", employee: "none" },
  orgChart: { label: "Maintenance › Org chart", system_admin: "none", super_admin: "full", hr: "full", approver: "view", accounting: "view", employee: "none" },
  documents: { label: "Maintenance › Documents", system_admin: "none", super_admin: "full", hr: "full", approver: "view:team", accounting: "none", employee: "own" },
  leaveTypes: { label: "Maintenance › Leave types", system_admin: "none", super_admin: "full", hr: "full", approver: "none", accounting: "none", employee: "none" },
  leaveBalances: { label: "Leave balances and adjustments", system_admin: "none", super_admin: "full", hr: "full", approver: "view:team", accounting: "none", employee: "own" },
  leave: { label: "Leave applications", system_admin: "none", super_admin: "full", hr: "approve", approver: "view:team", accounting: "none", employee: "own" },
  attendanceSettings: { label: "Attendance settings (Shifts, Schedules)", system_admin: "none", super_admin: "full", hr: "full", approver: "none", accounting: "none", employee: "none" },
  remoteDays: { label: "Attendance › Remote work days", system_admin: "none", super_admin: "full", hr: "full", approver: "view:team", accounting: "none", employee: "view" },
  rules: { label: "Maintenance › Rules", system_admin: "none", super_admin: "full", hr: "full", approver: "none", accounting: "none", employee: "none" },
  payrollRuns: { label: "Payroll runs", system_admin: "none", super_admin: "full", hr: "none", approver: "none", accounting: "manage+final", employee: "own" },
  payrollReports: { label: "Payroll reports (Payroll report, Government reports)", system_admin: "none", super_admin: "full", hr: "view", approver: "none", accounting: "manage", employee: "none" },
  contributions: { label: "Government contributions (rate tables)", system_admin: "none", super_admin: "full", hr: "none", approver: "none", accounting: "manage", employee: "none" },
  claims: { label: "Requests › Claims / Reimbursements", system_admin: "none", super_admin: "full", hr: "none", approver: "approve:team", accounting: "final", employee: "own" },
  attendanceRecords: { label: "Reports (attendance logs, overtime, undertime, time adjustments, tardiness)", system_admin: "none", super_admin: "full", hr: "view", approver: "approve:team", accounting: "view", employee: "own" },
  analytics: { label: "Reports › HR, Attendance, Management", system_admin: "none", super_admin: "full", hr: "view", approver: "view:team", accounting: "view", employee: "none" },
  trainings: { label: "Onboarding › Trainings", system_admin: "none", super_admin: "full", hr: "full", approver: "view:team", accounting: "none", employee: "own" },
  partnerTools: { label: "Partner tools (team calendar, workforce, performance, cases)", system_admin: "none", super_admin: "full", hr: "view", approver: "manage:team", accounting: "none", employee: "none" },
  selfService: { label: "Employee self-service (certificates, HMO & benefits)", system_admin: "none", super_admin: "full", hr: "manage", approver: "none", accounting: "none", employee: "own" },
  announcements: { label: "Announcements", system_admin: "none", super_admin: "full", hr: "manage", approver: "view", accounting: "view", employee: "view" },
  roleAssignment: { label: "Role assignment (Users)", system_admin: "manage", super_admin: "full", hr: "none", approver: "none", accounting: "none", employee: "none" },
  audit: { label: "Audit trail", system_admin: "view", super_admin: "view", hr: "view", approver: "none", accounting: "view", employee: "none" },
  systemSettings: { label: "System settings (company details, sign-in rules)", system_admin: "none", super_admin: "full", hr: "none", approver: "none", accounting: "none", employee: "none" },
  personalSettings: { label: "Personal settings", system_admin: "own", super_admin: "own", hr: "own", approver: "own", accounting: "own", employee: "own" },
  subscription: { label: "Subscription plan & seat count", system_admin: "full", super_admin: "view", hr: "view", approver: "none", accounting: "none", employee: "none" },
} satisfies Record<string, Row & { label: string }>;

export type Feature = keyof typeof PERMISSIONS;
export const FEATURES = Object.keys(PERMISSIONS) as Feature[];

/** Narrower rules that sit inside a cell. */
export const LIMITS = {
  /** Roles a role may give on the Users screen. system_admin only sets up a client's Super Admin. */
  assignableRoles: {
    system_admin: ["super_admin"],
    super_admin: ["super_admin", "hr", "approver", "accounting", "employee"],
    hr: [],
    approver: [],
    accounting: [],
    employee: [],
  } as Record<RoleKey, RoleKey[]>,
  /** Audit trail areas each role sees ("all" = everything). */
  auditAreas: {
    system_admin: ["Sign-in", "Administration"],
    super_admin: "all",
    hr: ["People", "Timekeeping", "Leave"],
    approver: [],
    accounting: ["Payroll"],
    employee: [],
  } as Record<RoleKey, "all" | string[]>,
  /** The workspace each role signs into. */
  workspace: {
    system_admin: "admin",
    super_admin: "admin",
    hr: "admin",
    approver: "manager",
    accounting: "admin",
    employee: "employee",
  } as Record<RoleKey, "admin" | "manager" | "employee">,
};

const ACTIONS: Record<Level, Action[]> = {
  full: ["view", "create", "edit", "delete", "approve", "final"],
  manage: ["view", "create", "edit"],
  approve: ["view", "approve"],
  final: ["view", "final"],
  view: ["view"],
  own: ["view", "create"],
  none: [],
};

/** The level(s) and scope in one cell. */
export function grantOf(role: RoleKey | null | undefined, feature: Feature): { levels: Level[]; scope: Scope } {
  if (!role) return { levels: [], scope: "own" };
  const [lv = "none", sc] = (PERMISSIONS[feature] as Row)[role].split(":");
  const levels = lv.split("+") as Level[];
  const scope: Scope = levels.includes("own") ? "own" : sc === "team" ? "team" : "all";
  return { levels: levels.filter((l) => l !== "none"), scope };
}

// ---- Who is asking ----

/** The signed-in person as permission checks see them (built by lib/session.ts). */
export interface Who {
  role: RoleKey | null;
  /** Their own employee record, for "own" scopes. */
  employeeId?: string;
  /** Their direct reports, for "team" scopes. */
  team: string[];
}

/** Can they do this action on this feature at all (somewhere in their scope)? */
export function can(who: Who | null | undefined, action: Action, feature: Feature): boolean {
  const { levels } = grantOf(who?.role, feature);
  return levels.some((l) => ACTIONS[l].includes(action));
}

/** The records they may act on: everyone, their team, or only themselves. null = no access. */
export function scopeFor(who: Who | null | undefined, action: Action, feature: Feature): Scope | null {
  if (!can(who, action, feature)) return null;
  return grantOf(who?.role, feature).scope;
}

/** May they do this to the record of this employee? */
export function canFor(who: Who | null | undefined, action: Action, feature: Feature, employeeId: string | undefined): boolean {
  const scope = scopeFor(who, action, feature);
  if (!scope) return false;
  if (scope === "all") return true;
  if (!employeeId) return false;
  if (scope === "own") return employeeId === who?.employeeId;
  return !!who?.team.includes(employeeId);
}

/** Rows they may see, by the employee each row belongs to. */
export function visible<T>(who: Who | null | undefined, feature: Feature, rows: T[], employeeOf: (r: T) => string | undefined): T[] {
  const scope = scopeFor(who, "view", feature);
  if (!scope) return [];
  if (scope === "all") return rows;
  const allowed = new Set(scope === "own" ? [who?.employeeId] : (who?.team ?? []));
  return rows.filter((r) => allowed.has(employeeOf(r)));
}

/** A refused request, like an HTTP 403. */
export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "You don't have access to do this.") {
    super(message);
    this.name = "ForbiddenError";
  }
}
