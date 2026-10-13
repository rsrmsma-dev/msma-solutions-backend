# Not on the database yet

From the website's update of Oct 9 (`bef6a17`). These screens work, but with the API server their
data is kept **only in the browser**: it isn't shared between people or computers and is gone after a
reload or on another device. Each needs tables and endpoints.

| Feature | Where it's kept now | What it needs |
|---|---|---|
| Sending the outbox's emails and texts | `outbox_messages` (stored, listed) | a real sender (mail/SMS service) and sent-status updates |

**On the database already:** bank account on the employee record (number encrypted), Accounting's
pay view (name, job, salary, government numbers, bank; not the 201 file), approvers approving their
team's leave, and employees switching to work from home (`work_from_home_days`) so their face-scan
clock-in is accepted.

Also on the database (migration `018_final_pay_loans_payouts`): **separations** (last day, reason and
note on the 201 file's history, reason and note encrypted; the employee becomes separated and their
sign-in is turned off once the last day has passed), **final pay** (`final_pay_cases`; reason and
release reference encrypted; releasing settles loans and pays out approved claims), **loans and
deductions** (`loans`; loan number and note encrypted; payroll runs deduct the installments and the
server refuses a run worked out with outdated loans or claims), and **claim payouts** (with payroll,
by bank transfer or in final pay; reference encrypted).

Also on the database (migration `019_holidays_org_settings`): the **holiday calendar**
(`holiday_rules`, `holiday_rule_branches`, `holiday_changes`: holidays HR adds, local holidays for
some offices, company holidays from Settings, and one-year moves and cancellations; the national and
movable holidays stay built into `src/lib/holidays.ts`, and the server counts the same holidays when it
counts leave days), **editable departments and locations** (endpoints on the existing `org_units`),
the **leave policy** and **scheduling rules** (`company_settings` columns; the server applies the half
day and negative balance rules when leave is filed), and **personal settings** (`user_preferences`,
one row per account: date format, timezone, week start, notifications, density, reduce motion, landing
page; the theme stays on each device).

Also on the database (migration `020_policies_outbox_wfh_location`): **company policies and
acknowledgements** (`company_policies`, `policy_acknowledgements`; documents in `files`, encrypted;
publishing queues an email to everyone currently employed; a new version needs acknowledging again),
the **email / text outbox** (`outbox_messages`: address, subject and text encrypted; the server looks
up each person's address and notification settings; stored and listed only, nothing is sent yet), the
**work-from-home location** (`punches.location`, encrypted; only HR, the person's approver and the
person see it), and **team notices** (no table needed: they come from `work_from_home_days` and the
clock-ins from home, already limited to the approver's team).

Also on the database (migration `021_employee_details_later`): **Add user makes the employee record**.
Adding a Super Admin, HR, Approver, Accounting or Employee sign-in without linking an existing
employee gives it a new record (name only), so the person shows on People right away (our own System
Admin / Admin accounts get none). Birth date, sex, civil status, mobile, email, date hired and basic
pay stay blank until filled in; payroll
runs and final pay leave the person out until their basic pay is filled in, and leave earned by the
month or after months of service waits for the date hired. Before 021, Add user makes the sign-in only.

## For the frontend team

- **Bank account number check has a typo.** `bankSchema` in `src/lib/corehr/schemas.ts` uses
  `/^[d -]{6,20}$/` (the letter d) instead of `/^[\d -]{6,20}$/`, so every real account number is
  refused in the form. The server checks it correctly.
