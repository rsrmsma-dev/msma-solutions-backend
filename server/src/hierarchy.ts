// Who may create and manage which sign-ins. Kept on the server: the website's access table
// (src/lib/permissions.ts) still has the older rules until the frontend team updates it.
//
//   System Admin  us, the developers: everyone; sees every account
//   Super Admin   the client: builds their own hierarchy (Super Admin, HR, Approver, Accounting,
//                 Employee); doesn't see our System Admin accounts
//   HR            employee sign-ins only: create, reset (the temporary password for people who
//                 registered), unlock, turn on/off
//
// (The old "Admin" role is retired: only Super Admin and System Admin remain.)

import type { RoleKey } from "../../src/lib/permissions";

export type AccountRole = RoleKey;

/** Our own accounts: never shown to the client and never counted as seats. */
export const OUR_ROLES: AccountRole[] = ["system_admin"];

const CLIENT_ROLES: AccountRole[] = ["super_admin", "hr", "approver", "accounting", "employee"];

/** Roles each role may give, and whose accounts it may manage. */
export const ASSIGNABLE: Record<AccountRole, AccountRole[]> = {
  system_admin: ["system_admin", ...CLIENT_ROLES],
  super_admin: CLIENT_ROLES,
  hr: ["employee"],
  approver: [],
  accounting: [],
  employee: [],
};

/** Accounts each role sees on the Users list. */
export const VISIBLE: Record<AccountRole, AccountRole[]> = {
  system_admin: ["system_admin", ...CLIENT_ROLES],
  super_admin: CLIENT_ROLES,
  hr: ["employee"],
  approver: [],
  accounting: [],
  employee: [],
};

/** The role the access table knows (the website's six). */
export const matrixRole = (role: AccountRole | null | undefined): RoleKey | null => role ?? null;

export const managesAccounts = (role: AccountRole | null | undefined) => !!role && ASSIGNABLE[role].length > 0;
export const mayAssign = (role: AccountRole | null | undefined, target: AccountRole | null | undefined) => !!role && !!target && ASSIGNABLE[role].includes(target);
