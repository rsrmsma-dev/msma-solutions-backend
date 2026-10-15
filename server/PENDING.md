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

Also on the database (migration `024_claims_certificates_support`): **claims released by Accounting**
(cash, bank transfer, e-wallet or check, with reference, date and who; `reimbursement_claims.release_method`,
reference encrypted; claims are no longer added to payroll runs, and runs already approved keep what
they paid), **certificate requests** (HR issues a digital copy, prepares a signed copy for pickup and
marks it released, or declines with a reason; issuing files the number, e.g. COE-2026-0001, the exact
wording and purpose on the request; wording and reason encrypted), and **support tickets**
(`support_tickets`, `support_ticket_messages`; text encrypted; the client's Super Admin, HR and
Accounting see the tickets they filed, System Admins see all and set status, priority and assignee).
Before 024, tickets are empty and their saves, certificate issue / pickup / decline, and releases other
than by bank transfer answer 503.

Also on the database (migration `025_subscription_seats`): **subscription & seat limits**
(`subscription_plans` with Starter / Growth / Business; on `subscriptions` the plan in force, our team's
seat override, a temporary extension and the seat alerts already sent; `subscription_events` for alerts,
refused adds, upgrade requests and plan changes). Seats are employee records that aren't Separated and
admin accounts are active HR / Approver / Accounting logins, both counted by the server. Add employee and
cancelling a separation answer 409 `SEAT_LIMIT_REACHED` past the limit plus grace, and new, promoted or
re-enabled HR / Approver / Accounting logins answer 409 `ADMIN_LIMIT_REACHED`, each checked inside the
add's transaction under a lock. Payroll, attendance, leave and reports never check. **Nothing is limited
until a System Admin chooses a plan** (Administration > Clients & Subscriptions); before 025 nothing is
limited and the System Admin's changes answer 503. An Employee sign-in (Register, Add user) no longer
counts as a seat.

Also on the database (migration `026_notifications`): **bell notifications** (`notifications`: one row
per person told, title and detail encrypted, the page it opens for their role, who caused it, when it
was read). The server sends them inside the change that causes them (`server/src/notify.ts`, same
recipients, wording and links as `src/lib/requestNotices.ts` / `src/lib/noticeLinks.ts`): leave, overtime
/ undertime, time adjustments, claims (filed, endorsed, approved, rejected, released), 201 documents,
certificates, separations and final pay, HR changes (credits, shifts, schedule, notices, loans, payslips,
manager, role), remote work days and published policies (everyone), support tickets, and seat alerts /
plan changes / refused adds / upgrade requests. Nobody is told about their own action. The bell reads
`GET /api/notifications` (own only) and marks them read. Before 026 nothing is sent and the bell is empty.
Not on the server yet: HR's "remind about missing 201 documents" (no endpoint; browser only).

Also on the database (migration `027_pay_settings`): **paydays** (`company_settings.payday_first`,
`payday_second`; 10 and 25 by default), **each employee's pay settings** (`employee_pay_profiles`: work
week, transport allowance, OT meal rate, de minimis, other non-taxable; read only by whoever sees
salaries, saved by whoever may edit payroll) and a six-day shift's **Saturday end**
(`shift_templates.saturday_end`). `GET /api/payroll/pay-settings`, `PUT /api/payroll/paydays`,
`PUT /api/payroll/pay-profiles/:id`; the website loads them at sign-in and before working out pay. An
employee moves their own training forward with `PUT /api/me/trainings/:id/status` (In progress /
Completed; a completed one stays completed). Before 027 the paydays are 10 and 25, everyone is on the
defaults, and saving paydays, pay settings or a Saturday end answers 503.

Also on the database: migration `028_workbook_rules` (pay settings: `client_share` / `client` charged
to 14002 Advances - Sphinx, and `skip_sss` / `skip_philhealth` / `skip_pagibig` for a 0 typed in sheet
C; saving either before 028 answers 503), `029_payroll_review` (`payroll_runs.reviewed_*`,
`POST /api/payroll/runs/:id/review`, 503 before 029) and `030_time_request_times`
(`time_requests.start_at` / `end_at`: `POST /api/timekeeping/requests` takes `start` and `end` as local
"yyyy-mm-ddThh:mm" and works out the day and minutes from them; before 030 only the minutes are kept).

## For the frontend team

- **Bank account number check has a typo.** `bankSchema` in `src/lib/corehr/schemas.ts` uses
  `/^[d -]{6,20}$/` (the letter d) instead of `/^[\d -]{6,20}$/`, so every real account number is
  refused in the form. The server checks it correctly.
