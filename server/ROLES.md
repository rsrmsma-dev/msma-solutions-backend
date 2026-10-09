# Who creates which accounts

The server enforces this now (`server/src/hierarchy.ts`). The website's access table
(`src/lib/permissions.ts`) still has the older rules, so some screens hide what is now allowed.

| Role | Who they are | May create and manage | Sees on the Users list |
|---|---|---|---|
| System Admin | us, the developers | everyone: System Admin, **Admin**, Super Admin, HR, Approver, Accounting, Employee | every account |
| **Admin** (new) | us, the owner company | Super Admin, HR, Approver, Accounting, Employee | everyone except System Admins |
| Super Admin | the client | Super Admin, HR, Approver, Accounting, Employee | client accounts only (ours are hidden) |
| HR | client HR staff | **Employee accounts only**: create, reset password (that is how HR gives people who registered their temporary password), unlock, turn on/off | employee accounts |
| Approver, Accounting, Employee | | nobody | none |

- **Admin** has Super Admin's access to the system. The website knows six roles, so the server sends
  Admin to the website as a Super Admin (role id `admin`, name "Admin", key `super_admin`). Only a
  System Admin can create one, and the client never sees Admin or System Admin accounts or roles.
- **System Admin** sees employees' names and IDs only (to link a sign-in to a person), no other
  employee data.
- Our System Admin and Admin accounts don't count as subscription seats.

## Changes for `src/lib/permissions.ts` (frontend)

So the screens match the server:

1. `LIMITS.assignableRoles`:
   - `system_admin: ["system_admin", "super_admin", "hr", "approver", "accounting", "employee"]`
     (the server also allows `admin`; see point 4)
   - `hr: ["employee"]`
2. `PERMISSIONS.roleAssignment.hr`: `"manage"` (instead of `"none"`), so HR gets the Users page.
   The server only lets HR touch Employee accounts.
3. `src/lib/admin/api.ts` `listAccounts`: drop the "System Admin sees only Super Admin accounts"
   filter. The server already returns the right accounts for each role.
4. Optional: add an `admin` role key ("Admin") if the screens should show it as its own role.
   Until then it appears as a Super Admin named "Admin".
