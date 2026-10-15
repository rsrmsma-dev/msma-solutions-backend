// What bell notifications are about and where they lead, shared by the website (requestNotices.ts,
// notifications.ts) and the API server (server/src/notify.ts), so both send every role to the same
// page and pick the same people. No storage or browser APIs here.

import { scopeFor, type Action, type Feature, type RoleKey } from "./permissions";

/** What a notification is about; picks its icon in the bell. */
export type NotificationKind = "request" | "approved" | "rejected" | "update" | "seat" | "alert";

export type Topic =
  | "leave"
  | "overtime"
  | "undertime"
  | "adjustment"
  | "claim"
  | "payslip"
  | "attendance"
  | "documents"
  | "loan"
  | "policy"
  | "schedule"
  | "separation"
  | "account"
  | "orgchart"
  | "subscription"
  | "certificate"
  | "support";

const ADMIN = (path: string): Partial<Record<RoleKey, string>> => ({ super_admin: path, hr: path, accounting: path, system_admin: path });

/** Each topic's page, per role (each role's page lives at its own address). */
export const LINKS: Record<Topic, Partial<Record<RoleKey, string>>> = {
  leave: { ...ADMIN("/admin/maintenance/leave/requests"), approver: "/manager/approvals?tab=leave", employee: "/employee/leave" },
  overtime: { ...ADMIN("/admin/reports/overtime"), approver: "/manager/approvals?tab=overtime", employee: "/employee/attendance" },
  undertime: { ...ADMIN("/admin/reports/undertime"), approver: "/manager/approvals?tab=undertime", employee: "/employee/attendance" },
  adjustment: { ...ADMIN("/admin/reports/time-adjustments"), approver: "/manager/approvals?tab=adjustments", employee: "/employee/attendance" },
  claim: { ...ADMIN("/admin/requests/reimbursement"), approver: "/manager/approvals?tab=claims", employee: "/employee/reimbursements" },
  payslip: { ...ADMIN("/admin/payroll/runs"), employee: "/employee/payslips" },
  attendance: { ...ADMIN("/admin/reports/attendance-logs"), approver: "/manager/attendance", employee: "/employee/attendance" },
  documents: { ...ADMIN("/admin/maintenance/documents"), employee: "/employee/201-file" },
  loan: { ...ADMIN("/admin/payroll/loans"), employee: "/employee/payslips" },
  policy: { ...ADMIN("/admin/maintenance/rules"), employee: "/employee/policies" },
  schedule: { ...ADMIN("/admin/timekeeping/schedules"), approver: "/manager/attendance", employee: "/employee/attendance" },
  separation: { ...ADMIN("/admin/maintenance/people"), accounting: "/admin/payroll/final-pay" },
  account: ADMIN("/admin/administration/users"),
  orgchart: { ...ADMIN("/admin/maintenance/org-chart"), approver: "/manager/workforce" },
  certificate: { ...ADMIN("/admin/requests/certificates"), employee: "/employee/certificates" },
  subscription: { super_admin: "/admin/settings/subscription", hr: "/admin/settings/subscription", system_admin: "/admin/administration/subscription" },
  support: ADMIN("/admin/administration/support"),
};

/** Everyone in the company. */
export const EVERYONE: RoleKey[] = ["super_admin", "hr", "approver", "accounting", "employee"];

/**
 * The roles assigned an action company-wide in the access matrix (lib/permissions.ts), e.g. final
 * approval of claims → Accounting. Super Admins hold everything, so they're only included when no
 * other role is assigned it.
 */
export function rolesThatCan(action: Action, feature: Feature): RoleKey[] {
  const assigned = EVERYONE.filter((role) => scopeFor({ role, team: [] }, action, feature) === "all");
  const others = assigned.filter((r) => r !== "super_admin");
  return others.length ? others : assigned;
}
