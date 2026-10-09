-- 006: The team's latest UI (191adb9): six fixed roles, two-step claims, and the new Settings pages.
--   * Roles: System Admin, Super Admin, HR, Approver, Accounting, Employee. What each may do is the
--     access matrix in src/lib/permissions.ts, so the per-module access table goes. Accounts on the old
--     Admin role move to HR (as the website does); any other old role moves to Employee (Approver if it
--     signed into the manager workspace). Each move is written to the audit log.
--   * Claims: the employee's approver endorses first, then Accounting gives the final approval.
--   * Company settings (Settings > Organization): logo, timezone, currency, work week and hours,
--     fiscal year, retention.
-- No employee, leave, attendance or payroll data changes. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/006_roles_settings.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('006_roles_settings');

-- ---- Roles ----

INSERT INTO roles (id, name, description, workspace, is_built_in, is_super_admin) VALUES
  ('system-admin', 'System Admin', '-', 'admin', true, false),
  ('approver', 'Approver', '-', 'manager', true, false),
  ('accounting', 'Accounting', '-', 'admin', true, false)
ON CONFLICT (id) DO NOTHING;

-- Moves onto the six roles, recorded like the website records them.
INSERT INTO audit_log (actor_name, module, action, target, detail)
SELECT 'System', 'Administration', 'Changed role', a.username,
       r.name || ' → ' || CASE WHEN r.id = 'admin' THEN 'HR' WHEN r.workspace = 'manager' THEN 'Approver' ELSE 'Employee' END || ' (move to the six fixed roles)'
  FROM user_accounts a JOIN roles r ON r.id = a.role_id
 WHERE r.id NOT IN ('system-admin', 'super-admin', 'hr', 'approver', 'accounting', 'employee');

UPDATE user_accounts a
   SET role_id = CASE WHEN r.id = 'admin' THEN 'hr' WHEN r.workspace = 'manager' THEN 'approver' ELSE 'employee' END
  FROM roles r
 WHERE r.id = a.role_id AND r.id NOT IN ('system-admin', 'super-admin', 'hr', 'approver', 'accounting', 'employee');

-- Approval steps that named the old Admin role now name HR; steps naming other removed roles go.
UPDATE approval_workflow_steps SET role_id = 'hr' WHERE role_id = 'admin';
DELETE FROM approval_workflow_steps WHERE role_id IS NOT NULL AND role_id NOT IN ('system-admin', 'super-admin', 'hr', 'approver', 'accounting', 'employee');

DROP TABLE role_module_access;
DELETE FROM roles WHERE id NOT IN ('system-admin', 'super-admin', 'hr', 'approver', 'accounting', 'employee');

ALTER TABLE roles ADD COLUMN role_key text;
-- Names and descriptions as the website shows them (ROLE_LABEL / ROLE_DESCRIPTION in src/lib/permissions.ts).
UPDATE roles SET role_key = v.k, name = v.n, description = v.d, workspace = v.w, is_built_in = true, is_super_admin = (v.k = 'super_admin')
  FROM (VALUES
    ('system-admin', 'system_admin', 'System Admin', 'admin', 'Our development team. Plan and seats, and setting up a client''s first Super Admin. No access to client data.'),
    ('super-admin', 'super_admin', 'Super Admin', 'admin', 'The client, usually their IT. Full access within the company; handles the initial setup.'),
    ('hr', 'hr', 'HR', 'admin', 'HR staff. Employee records, leave, attendance setup and rules. Views payroll reports; never sees claims.'),
    ('approver', 'approver', 'Approver', 'manager', 'Managers and supervisors. Approve their own team''s claims, overtime, undertime and time adjustments.'),
    ('accounting', 'accounting', 'Accounting', 'admin', 'Accountants. Prepare and give final approval on payroll; final approval and payout of claims.'),
    ('employee', 'employee', 'Employee', 'employee', 'Regular employees. File leave and claims and see their own records.')
  ) AS v(id, k, n, w, d)
 WHERE roles.id = v.id;
ALTER TABLE roles ALTER COLUMN role_key SET NOT NULL;
ALTER TABLE roles ADD CONSTRAINT roles_role_key_key UNIQUE (role_key);
ALTER TABLE roles ADD CONSTRAINT roles_role_key_check CHECK (role_key IN ('system_admin', 'super_admin', 'hr', 'approver', 'accounting', 'employee'));

-- ---- Claims: approver, then Accounting ----

ALTER TABLE reimbursement_claims DROP CONSTRAINT reimbursement_claims_status_check;
ALTER TABLE reimbursement_claims ADD CONSTRAINT reimbursement_claims_status_check CHECK (status IN ('pending', 'endorsed', 'approved', 'rejected'));
ALTER TABLE reimbursement_claims
  ADD COLUMN approver_decided_by uuid,
  ADD COLUMN approver_decided_by_name text,
  ADD COLUMN approver_decided_at timestamptz,
  ADD COLUMN approver_note text;
ALTER TABLE reimbursement_claims ADD CONSTRAINT reimbursement_claims_approver_decided_by_fkey FOREIGN KEY (approver_decided_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
CREATE INDEX ON reimbursement_claims (approver_decided_by);

-- ---- Company settings ----

ALTER TABLE company_settings
  ADD COLUMN logo_file_id uuid,
  ADD COLUMN default_timezone text NOT NULL DEFAULT 'Asia/Manila',
  ADD COLUMN currency text NOT NULL DEFAULT 'PHP',
  ADD COLUMN work_week smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  ADD COLUMN work_start time NOT NULL DEFAULT '08:30',
  ADD COLUMN work_end time NOT NULL DEFAULT '17:30',
  ADD COLUMN fiscal_year_start_month smallint NOT NULL DEFAULT 1,
  ADD COLUMN retention_months smallint NOT NULL DEFAULT 0;
ALTER TABLE company_settings ADD CONSTRAINT company_settings_logo_file_id_fkey FOREIGN KEY (logo_file_id) REFERENCES files (id) ON DELETE SET NULL;
CREATE INDEX ON company_settings (logo_file_id);

-- ---- Descriptions (same as the data dictionary) ----

COMMENT ON TABLE company_settings IS 'Single row of company-wide settings: identity, sign-in security, working time and tardiness flags.';
COMMENT ON COLUMN company_settings.logo_file_id IS 'Company logo (Settings > Organization).';
COMMENT ON COLUMN company_settings.default_timezone IS 'Timezone for anyone who hasn''t picked their own.';
COMMENT ON COLUMN company_settings.currency IS 'Currency shown on amounts; payroll is computed in PHP.';
COMMENT ON COLUMN company_settings.work_week IS 'Working days, 0 = Sunday to 6 = Saturday. Leave counts only these days.';
COMMENT ON COLUMN company_settings.work_start IS 'Usual start of the working day.';
COMMENT ON COLUMN company_settings.work_end IS 'Usual end of the working day.';
COMMENT ON COLUMN company_settings.fiscal_year_start_month IS 'Month the fiscal year starts, 1 = January.';
COMMENT ON COLUMN company_settings.retention_months IS 'Keep records this many months after separation (0 = keep everything).';
COMMENT ON TABLE reimbursement_claims IS 'Expense claims with a receipt photo. The employee''s approver endorses them, then Accounting gives the final approval.';
COMMENT ON COLUMN reimbursement_claims.status IS 'Waiting for the approver, endorsed (waiting for Accounting), approved or rejected.';
COMMENT ON COLUMN reimbursement_claims.approver_decided_by IS 'Approver (the employee''s supervisor) who endorsed or rejected it.';
COMMENT ON COLUMN reimbursement_claims.approver_decided_by_name IS 'Name of that approver, kept if the account goes.';
COMMENT ON COLUMN reimbursement_claims.approver_decided_at IS 'When the approver decided.';
COMMENT ON COLUMN reimbursement_claims.approver_note IS 'The approver''s note.';
COMMENT ON TABLE roles IS 'The six fixed roles. What each may do is the access matrix in the app (src/lib/permissions.ts).';
COMMENT ON COLUMN roles.id IS 'Role id, e.g. super-admin, hr.';
COMMENT ON COLUMN roles.role_key IS 'Which of the six roles, as the access matrix names it.';
COMMENT ON COLUMN user_accounts.builtin_key IS 'Marks the accounts created at setup.';

COMMIT;
