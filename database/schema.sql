-- HeyHR (MSMA HRIS) database schema — PostgreSQL 15+
-- Generated from the frontend's data model (src/lib/**/types.ts).
-- Data dictionary: database/DATA_DICTIONARY.md

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() on PG < 13
CREATE SEQUENCE employee_id_seq; -- EMPLOYEE_ID auto-numbering
-- Which files in database/migrations have been applied (this schema includes them all).
CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- ======================================================================
-- Company & organization
-- ======================================================================

-- Single row of company-wide settings: identity, sign-in security and tardiness flags.
CREATE TABLE company_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id IN (1)),
  company_name text NOT NULL,
  tin text,
  address text,
  contact_email text,
  min_password_length smallint NOT NULL DEFAULT 8,
  lock_after_failed smallint NOT NULL DEFAULT 5,
  lock_minutes smallint NOT NULL DEFAULT 15,
  idle_minutes smallint NOT NULL DEFAULT 30,
  tardy_consecutive_days smallint NOT NULL DEFAULT 3,
  tardy_per_month smallint NOT NULL DEFAULT 5,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- The organization tree: one company, its branches, their departments and teams (clusters).
CREATE TABLE org_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_type text NOT NULL CHECK (unit_type IN ('company', 'branch', 'department', 'team')),
  name text NOT NULL,
  code text NOT NULL,
  parent_id uuid,
  head_employee_id varchar(20),
  address text,
  is_active boolean NOT NULL DEFAULT true
);

-- Budgeted job positions within a department.
CREATE TABLE positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  code text NOT NULL,
  department_id uuid NOT NULL,
  job_level text NOT NULL CHECK (job_level IN ('Rank and file', 'Supervisor', 'Manager', 'Executive')),
  default_employment_type varchar(12) NOT NULL DEFAULT 'PROBATIONARY' CHECK (default_employment_type IN ('PROBATIONARY', 'REGULAR', 'FIXED_TERM')),
  budgeted_slots smallint NOT NULL DEFAULT 1,
  reports_to_position_id uuid,
  description text,
  is_active boolean NOT NULL DEFAULT true
);

-- Philippine regular and special non-working days, by proclamation.
CREATE TABLE holidays (
  holiday_date date PRIMARY KEY,
  name text NOT NULL,
  holiday_type text NOT NULL CHECK (holiday_type IN ('regular', 'special')),
  source text NOT NULL
);

-- ======================================================================
-- People & 201 File
-- ======================================================================

-- The employee master record (201 File core). Fields marked BRD follow the New Employees Template (BRD v1.1, 11.2.1). Government numbers and BASIC_RATE are HR- and Payroll-only.
CREATE TABLE employees (
  employee_id varchar(20) PRIMARY KEY DEFAULT 'MSMA-' || lpad(nextval('employee_id_seq')::text, 5, '0'),
  last_name varchar(50) NOT NULL,
  first_name varchar(50) NOT NULL,
  middle_name varchar(50),
  suffix varchar(10),
  birth_date date NOT NULL,
  sex char(1) NOT NULL CHECK (sex IN ('M', 'F')),
  civil_status varchar(10) NOT NULL CHECK (civil_status IN ('SINGLE', 'MARRIED', 'WIDOWED', 'SEPARATED')),
  mobile_no varchar(11) NOT NULL UNIQUE,
  email varchar(100) NOT NULL UNIQUE,
  date_hired date NOT NULL,
  employment_status varchar(12) NOT NULL DEFAULT 'PROBATIONARY' CHECK (employment_status IN ('PROBATIONARY', 'REGULAR', 'FIXED_TERM')),
  tin varchar(17) UNIQUE,
  sss_no varchar(12) UNIQUE,
  philhealth_no varchar(14) UNIQUE,
  pagibig_no varchar(14) UNIQUE,
  basic_rate numeric(12,2) NOT NULL,
  nationality varchar(50) NOT NULL DEFAULT 'Filipino',
  photo_file_id uuid,
  personal_email varchar(100),
  address_line text,
  city varchar(100),
  province varchar(100),
  emergency_name varchar(100),
  emergency_relationship varchar(50),
  emergency_phone varchar(20),
  position_id uuid,
  org_unit_id uuid,
  supervisor_id varchar(20),
  record_status varchar(10) NOT NULL DEFAULT 'ACTIVE' CHECK (record_status IN ('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'SEPARATED')),
  regularization_date date,
  separation_date date,
  work_schedule text,
  default_shift_id varchar(20),
  face_enrolled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Spouse and children, for HMO enrollment and leave eligibility.
CREATE TABLE dependents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  full_name text NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('Spouse', 'Child')),
  birth_date date,
  hmo_enrolled boolean NOT NULL DEFAULT false
);

-- Uploaded files: documents, receipts, photos. Kept in `content` for now; object storage later.
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text,
  content bytea,
  uploaded_by uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- Pre-employment and identity documents in the 201 File checklist.
CREATE TABLE employee_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('Application Form / Resume', 'Birth Certificate (PSA)', 'Marriage Certificate (PSA)', 'Child''s Birth Certificate', 'Valid Government ID', 'Diploma / Transcript of Records', 'Professional License', 'Certificate of Employment (Previous)', 'NBI Clearance', 'Police/Barangay Clearance', 'Pre-Employment Medical Result')),
  status text NOT NULL DEFAULT 'Missing' CHECK (status IN ('Missing', 'Submitted', 'Verified', 'Not applicable')),
  file_id uuid,
  file_name text,
  submitted_at timestamptz,
  verified_by uuid,
  verified_by_name text,
  verified_at timestamptz,
  id_type text,
  reference_no text,
  expires_on date,
  note text
);

-- Employment history: hires, promotions, transfers, salary changes, separations.
CREATE TABLE job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('Hired', 'Promotion', 'Transfer', 'Salary adjustment', 'Regularization', 'Supervisor change', 'Status change', 'Separation')),
  effective_date date NOT NULL,
  changes jsonb NOT NULL DEFAULT '[]',
  remarks text,
  recorded_by uuid,
  recorded_by_name text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- PRC licenses (CPA, lawyer) and CPD unit progress.
CREATE TABLE professional_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  license_type text NOT NULL,
  license_number text NOT NULL,
  expires_on date,
  cpd_units_earned numeric(5,1) NOT NULL DEFAULT 0,
  cpd_units_required numeric(5,1) NOT NULL DEFAULT 60,
  cycle_end_date date
);

-- HMO and government benefit memberships.
CREATE TABLE employee_benefits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  benefit_name text NOT NULL,
  provider text NOT NULL,
  member_no text,
  status text NOT NULL CHECK (status IN ('Active', 'Pending', 'Not enrolled'))
);

-- Appraisals, annual and mid-year.
CREATE TABLE performance_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  review_period text NOT NULL,
  reviewer_id varchar(20),
  rating numeric(3,1),
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Submitted', 'Completed')),
  completed_at timestamptz
);

-- Assigned trainings and their progress.
CREATE TABLE training_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  course text NOT NULL,
  due_date date,
  status text NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'In progress', 'Completed')),
  completed_on date
);

-- Employee relations cases a partner or HR files.
CREATE TABLE employee_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  case_type text NOT NULL CHECK (case_type IN ('Attendance', 'Conduct', 'Performance', 'Grievance')),
  status text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Under review', 'Resolved')),
  summary text NOT NULL,
  filed_by uuid NOT NULL,
  filed_on date NOT NULL DEFAULT current_date
);

-- Laptops, IDs, access cards and phones issued to employees.
CREATE TABLE company_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_tag text NOT NULL UNIQUE,
  asset_type text NOT NULL,
  assigned_employee_id varchar(20),
  issued_on date,
  returned_on date,
  status text NOT NULL DEFAULT 'Issued' CHECK (status IN ('Issued', 'Returned', 'Under repair'))
);

-- Resignations and separations with clearance progress.
CREATE TABLE offboarding_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  separation_type text NOT NULL,
  reason text,
  notice_filed_on date,
  last_day date NOT NULL,
  stage text NOT NULL DEFAULT 'Resignation filed' CHECK (stage IN ('Resignation filed', 'Clearance in progress', 'Final pay released')),
  clearance jsonb NOT NULL DEFAULT '[]'
);

-- COE and other certificates employees request.
CREATE TABLE certificate_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  certificate_type text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Ready for pickup', 'Released')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

-- ======================================================================
-- Timekeeping & attendance
-- ======================================================================

-- Work shifts: Busy season, Peak season, Mid shift, Flexible time.
CREATE TABLE shift_templates (
  id varchar(20) PRIMARY KEY,
  name text NOT NULL UNIQUE,
  start_time time NOT NULL,
  end_time time NOT NULL,
  break_minutes smallint NOT NULL DEFAULT 60,
  break_start time NOT NULL,
  grace_minutes smallint NOT NULL DEFAULT 5,
  rest_days smallint[] NOT NULL DEFAULT '{0,6}',
  is_flexible boolean NOT NULL DEFAULT false,
  required_hours numeric(4,2),
  is_active boolean NOT NULL DEFAULT true
);

-- A different shift, or a rest day, for one person on one date.
CREATE TABLE schedule_overrides (
  employee_id varchar(20) NOT NULL,
  work_date date NOT NULL,
  shift_id varchar(20),
  set_by uuid,
  PRIMARY KEY (employee_id, work_date)
);

-- Registered biometric scanners and face kiosks.
CREATE TABLE attendance_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  device_type text NOT NULL CHECK (device_type IN ('biometric', 'face')),
  branch_id uuid NOT NULL,
  serial_no text UNIQUE,
  is_registered boolean NOT NULL DEFAULT true
);

-- Every time-in and time-out. Never deleted; HR sets bad ones aside.
CREATE TABLE punches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  work_date date NOT NULL,
  punched_at timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  source text NOT NULL CHECK (source IN ('biometric', 'face', 'manual', 'remote')),
  device_id uuid,
  device_label text,
  device_branch text,
  face_match smallint,
  reason text,
  recorded_by uuid,
  recorded_by_name text,
  voided_reason text,
  voided_by uuid,
  voided_by_name text,
  voided_at timestamptz,
  confirmed_by uuid,
  confirmed_by_name text,
  confirmed_at timestamptz
);

-- Overtime and undertime requests.
CREATE TABLE time_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  work_date date NOT NULL,
  request_type text NOT NULL CHECK (request_type IN ('overtime', 'undertime')),
  minutes smallint NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  filed_by_name text NOT NULL,
  filed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text
);

-- Employee asks HR to add or correct a time-in/out the device missed.
CREATE TABLE punch_fix_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  work_date date NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  requested_time time NOT NULL,
  next_day boolean NOT NULL DEFAULT false,
  cause text NOT NULL DEFAULT 'not-recorded' CHECK (cause IN ('not-recorded', 'wrong-time', 'system-error', 'other')),
  recorded_time time,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  filed_by_name text NOT NULL,
  filed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text
);

-- Work-from-home days HR declares for typhoons and emergencies.
CREATE TABLE remote_work_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date_from date NOT NULL,
  date_to date NOT NULL,
  reason text NOT NULL,
  declared_by uuid NOT NULL,
  declared_by_name text NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now()
);

-- Branches a remote work day covers. No rows means every branch.
CREATE TABLE remote_work_day_branches (
  remote_work_day_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  PRIMARY KEY (remote_work_day_id, branch_id)
);

-- Memos HR sends about repeated lateness or AWOL. Never change pay.
CREATE TABLE attendance_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  notice_kind text NOT NULL CHECK (notice_kind IN ('tardiness', 'awol')),
  subject text NOT NULL,
  message text NOT NULL,
  dates date[] NOT NULL,
  sent_by uuid NOT NULL,
  sent_by_name text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

-- Statutory premium multipliers by kind of day, versioned by effective date.
CREATE TABLE premium_rates (
  day_type text NOT NULL CHECK (day_type IN ('ordinary', 'rest', 'special', 'regular', 'special-rest', 'regular-rest')),
  effective_from date NOT NULL,
  first_eight_hours numeric(4,2) NOT NULL,
  overtime numeric(4,2) NOT NULL,
  source text NOT NULL,
  last_verified date NOT NULL,
  PRIMARY KEY (day_type, effective_from)
);

-- ======================================================================
-- Leave
-- ======================================================================

-- Company and statutory leave types (VL, SL, maternity, solo parent…).
CREATE TABLE leave_types (
  id varchar(20) PRIMARY KEY,
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  days_per_year numeric(5,2) NOT NULL,
  earning_kind text NOT NULL CHECK (earning_kind IN ('monthly', 'yearly', 'per-event', 'unlimited')),
  earning_per_month numeric(4,2),
  is_paid boolean NOT NULL DEFAULT true,
  carry_over_max numeric(5,2) NOT NULL DEFAULT 0,
  count_by text NOT NULL DEFAULT 'workdays' CHECK (count_by IN ('workdays', 'calendar')),
  eligibility text NOT NULL DEFAULT 'everyone' CHECK (eligibility IN ('everyone', 'female', 'male-married', 'solo-parent', 'after-1-year', 'after-6-months')),
  attachment_over_days numeric(5,2),
  is_confidential boolean NOT NULL DEFAULT false,
  legal_basis text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

-- Leave filed by or for an employee.
CREATE TABLE leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  leave_type_id varchar(20) NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  half_day text CHECK (half_day IN ('am', 'pm')),
  days numeric(5,2) NOT NULL,
  reason text NOT NULL,
  attachment_file_id uuid,
  attachment_name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  filed_by uuid NOT NULL,
  filed_by_name text NOT NULL,
  filed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text
);

-- Manual changes HR makes to a balance or to the yearly leave credits.
CREATE TABLE leave_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  leave_type_id varchar(20),
  days numeric(5,2) NOT NULL,
  reason text NOT NULL,
  adjusted_by uuid NOT NULL,
  adjusted_by_name text NOT NULL,
  adjusted_at timestamptz NOT NULL DEFAULT now()
);

-- Unused days brought into a year.
CREATE TABLE leave_carry_overs (
  employee_id varchar(20) NOT NULL,
  leave_type_id varchar(20) NOT NULL,
  leave_year smallint NOT NULL,
  days numeric(5,2) NOT NULL,
  PRIMARY KEY (employee_id, leave_type_id, leave_year)
);

-- ======================================================================
-- Payroll & reimbursements
-- ======================================================================

-- SSS, PhilHealth, Pag-IBIG and BIR tables. A new circular is a new row, so past pay can still be recomputed.
CREATE TABLE contribution_rate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency text NOT NULL CHECK (agency IN ('sss', 'philhealth', 'pagibig', 'bir')),
  effective_from date NOT NULL,
  source text NOT NULL,
  rates jsonb NOT NULL,
  saved_by uuid,
  saved_by_name text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now()
);

-- One payroll per cutoff. Draft runs recompute from attendance; approved runs are locked.
CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  branch_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_by uuid NOT NULL,
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  computed_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_by_name text,
  approved_at timestamptz,
  payslips_released_at timestamptz
);

-- One employee's pay in a run: the payslip.
CREATE TABLE payroll_run_lines (
  payroll_run_id uuid NOT NULL,
  employee_id varchar(20) NOT NULL,
  basic_pay numeric(12,2) NOT NULL,
  absence_deductions numeric(12,2) NOT NULL DEFAULT 0,
  overtime_pay numeric(12,2) NOT NULL DEFAULT 0,
  premium_pay numeric(12,2) NOT NULL DEFAULT 0,
  gross_pay numeric(12,2) NOT NULL,
  sss_ee numeric(10,2) NOT NULL DEFAULT 0,
  sss_er numeric(10,2) NOT NULL DEFAULT 0,
  sss_ec numeric(10,2) NOT NULL DEFAULT 0,
  philhealth_ee numeric(10,2) NOT NULL DEFAULT 0,
  philhealth_er numeric(10,2) NOT NULL DEFAULT 0,
  pagibig_ee numeric(10,2) NOT NULL DEFAULT 0,
  pagibig_er numeric(10,2) NOT NULL DEFAULT 0,
  taxable_income numeric(12,2) NOT NULL,
  withholding_tax numeric(12,2) NOT NULL DEFAULT 0,
  net_pay numeric(12,2) NOT NULL,
  computation jsonb NOT NULL,
  PRIMARY KEY (payroll_run_id, employee_id)
);

-- Additions or deductions to one employee's pay in a run.
CREATE TABLE payroll_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id uuid NOT NULL,
  employee_id varchar(20) NOT NULL,
  label text NOT NULL,
  amount numeric(12,2) NOT NULL,
  is_taxable boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  reimbursement_claim_id uuid
);

-- Expense claims with a receipt photo.
CREATE TABLE reimbursement_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  category text NOT NULL CHECK (category IN ('Transportation', 'Meals & client meetings', 'Office supplies', 'Communication', 'Training & seminars', 'Medical', 'Other')),
  other_type text,
  merchant text NOT NULL,
  purchase_date date NOT NULL,
  amount numeric(10,2) NOT NULL,
  description text NOT NULL,
  receipt_file_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  filed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text
);

-- ======================================================================
-- Access, workflows & audit
-- ======================================================================

-- Roles that set a user's workspace and module access.
CREATE TABLE roles (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text NOT NULL,
  workspace text NOT NULL CHECK (workspace IN ('employee', 'manager', 'admin')),
  is_built_in boolean NOT NULL DEFAULT false,
  is_super_admin boolean NOT NULL DEFAULT false
);

-- Access a role has to each HR-workspace module.
CREATE TABLE role_module_access (
  role_id text NOT NULL,
  module text NOT NULL CHECK (module IN ('people', 'company', 'documents', 'timekeeping', 'leave', 'reimbursements', 'reports', 'payroll', 'administration')),
  access text NOT NULL DEFAULT 'none' CHECK (access IN ('none', 'view', 'edit', 'approve')),
  PRIMARY KEY (role_id, module)
);

-- Sign-in accounts. Linked to an employee when the user is one.
CREATE TABLE user_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  builtin_key text UNIQUE CHECK (builtin_key IN ('superadmin', 'admin', 'hr', 'employee')),
  display_name text NOT NULL,
  password_hash text NOT NULL,
  employee_id varchar(20) UNIQUE,
  role_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  must_change_password boolean NOT NULL DEFAULT false,
  last_sign_in_at timestamptz,
  failed_attempts smallint NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Signed-in sessions. The browser holds the token in an HttpOnly cookie; only its hash is stored.
CREATE TABLE user_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
);

-- How each kind of request gets approved.
CREATE TABLE approval_workflows (
  request_kind text PRIMARY KEY CHECK (request_kind IN ('leave', 'overtime', 'undertime', 'correction', 'profile')),
  remind_after_days smallint NOT NULL DEFAULT 2,
  is_active boolean NOT NULL DEFAULT true
);

-- Ordered approval steps in a workflow.
CREATE TABLE approval_workflow_steps (
  request_kind text NOT NULL,
  step_no smallint NOT NULL,
  approver_kind text NOT NULL CHECK (approver_kind IN ('supervisor', 'department-head', 'role')),
  role_id text,
  over_days numeric(5,2),
  PRIMARY KEY (request_kind, step_no)
);

-- Append-only trail: sign-ins, admin changes, 201 File views and edits, timekeeping changes, payroll approvals.
CREATE TABLE audit_log (
  id bigint PRIMARY KEY generated always as identity,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_account_id uuid,
  actor_name text NOT NULL,
  module text NOT NULL CHECK (module IN ('Sign-in', 'Administration', 'People', 'Documents', 'Timekeeping', 'Leave', 'Reimbursements', 'Payroll')),
  action text NOT NULL,
  employee_id varchar(20),
  target text NOT NULL,
  detail text,
  data jsonb
);

-- ======================================================================
-- Announcements & compliance
-- ======================================================================

-- Company news shown on employee dashboards.
CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text,
  branch_id uuid,
  posted_by uuid NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

-- Statutory remittances and returns: SSS, PhilHealth, Pag-IBIG, BIR.
CREATE TABLE compliance_filings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency text NOT NULL CHECK (agency IN ('SSS', 'PhilHealth', 'Pag-IBIG', 'BIR')),
  filing text NOT NULL,
  period text NOT NULL,
  due_date date NOT NULL,
  filed_on date,
  reference_no text,
  filed_by uuid,
  note text
);

-- Open positions being recruited for.
CREATE TABLE job_requisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid NOT NULL,
  openings smallint NOT NULL DEFAULT 1,
  stage text NOT NULL DEFAULT 'Sourcing' CHECK (stage IN ('Sourcing', 'Interviewing', 'Offer extended', 'Filled', 'Cancelled')),
  opened_on date NOT NULL DEFAULT current_date,
  opened_by uuid
);

-- What each table and column is for (shown by \dt+ and \d+ in psql)
COMMENT ON TABLE company_settings IS 'Single row of company-wide settings: identity, sign-in security and tardiness flags.';
COMMENT ON COLUMN company_settings.id IS 'Always 1; the table holds one row.';
COMMENT ON COLUMN company_settings.company_name IS 'Legal or trade name shown on payslips and certificates.';
COMMENT ON COLUMN company_settings.tin IS 'Company TIN, 000-000-000-00000.';
COMMENT ON COLUMN company_settings.address IS 'Registered business address.';
COMMENT ON COLUMN company_settings.contact_email IS 'HR contact address shown to employees.';
COMMENT ON COLUMN company_settings.min_password_length IS 'Minimum password length for user accounts.';
COMMENT ON COLUMN company_settings.lock_after_failed IS 'Failed sign-ins before an account locks.';
COMMENT ON COLUMN company_settings.lock_minutes IS 'How long a locked account stays locked.';
COMMENT ON COLUMN company_settings.idle_minutes IS 'Idle time before a session signs out.';
COMMENT ON COLUMN company_settings.tardy_consecutive_days IS 'Flag someone late this many work days in a row (0 = off).';
COMMENT ON COLUMN company_settings.tardy_per_month IS 'Flag someone late this many times in a month (0 = off).';
COMMENT ON COLUMN company_settings.updated_at IS 'Last change.';
COMMENT ON COLUMN company_settings.updated_by IS 'Account that made the last change.';
COMMENT ON TABLE org_units IS 'The organization tree: one company, its branches, their departments and teams (clusters).';
COMMENT ON COLUMN org_units.id IS 'Primary key.';
COMMENT ON COLUMN org_units.unit_type IS 'Level in the tree.';
COMMENT ON COLUMN org_units.name IS 'Display name, e.g. Cebu HQ, Tax Advisory, RPM.';
COMMENT ON COLUMN org_units.code IS 'Short code used in tables and IDs, e.g. CEB, TAX.';
COMMENT ON COLUMN org_units.parent_id IS 'Parent unit; null only for the company.';
COMMENT ON COLUMN org_units.head_employee_id IS 'Head of the unit (department head, partner).';
COMMENT ON COLUMN org_units.address IS 'Street address; branches only.';
COMMENT ON COLUMN org_units.is_active IS 'Inactive units stay for history but can''t take new people.';
COMMENT ON TABLE positions IS 'Budgeted job positions within a department.';
COMMENT ON COLUMN positions.id IS 'Primary key.';
COMMENT ON COLUMN positions.title IS 'Job title, e.g. Experienced Associate.';
COMMENT ON COLUMN positions.code IS 'Short code, e.g. EA.';
COMMENT ON COLUMN positions.department_id IS 'Department the position belongs to.';
COMMENT ON COLUMN positions.job_level IS 'Seniority band.';
COMMENT ON COLUMN positions.default_employment_type IS 'Type new hires into this position usually start on.';
COMMENT ON COLUMN positions.budgeted_slots IS 'Approved headcount for the position.';
COMMENT ON COLUMN positions.reports_to_position_id IS 'Position this one reports to.';
COMMENT ON COLUMN positions.description IS 'Duties summary.';
COMMENT ON COLUMN positions.is_active IS 'Inactive positions can''t take new hires.';
COMMENT ON TABLE holidays IS 'Philippine regular and special non-working days, by proclamation.';
COMMENT ON COLUMN holidays.holiday_date IS 'The day.';
COMMENT ON COLUMN holidays.name IS 'e.g. Araw ng Kagitingan.';
COMMENT ON COLUMN holidays.holiday_type IS 'Regular holidays pay 200%; special days 130%.';
COMMENT ON COLUMN holidays.source IS 'Proclamation number or reference.';
COMMENT ON TABLE employees IS 'The employee master record (201 File core). Fields marked BRD follow the New Employees Template (BRD v1.1, 11.2.1). Government numbers and BASIC_RATE are HR- and Payroll-only.';
COMMENT ON COLUMN employees.employee_id IS 'BRD. Unique employee identifier. Auto-generated if blank (MSMA-00001).';
COMMENT ON COLUMN employees.last_name IS 'BRD. Surname. Letters only (spaces, hyphens, apostrophes, periods allowed).';
COMMENT ON COLUMN employees.first_name IS 'BRD. Given name. Letters only.';
COMMENT ON COLUMN employees.middle_name IS 'BRD. Middle name. Letters only.';
COMMENT ON COLUMN employees.suffix IS 'Jr., Sr., III.';
COMMENT ON COLUMN employees.birth_date IS 'BRD. Date of birth. Age must be 18 or older (checked by trigger).';
COMMENT ON COLUMN employees.sex IS 'BRD. Gender. From the allowed values only.';
COMMENT ON COLUMN employees.civil_status IS 'BRD. Marital status. From the allowed values only.';
COMMENT ON COLUMN employees.mobile_no IS 'BRD. Mobile number, 11 digits: 09XXXXXXXXX. Unique.';
COMMENT ON COLUMN employees.email IS 'BRD. Email address (work). Valid email format. Unique.';
COMMENT ON COLUMN employees.date_hired IS 'BRD. First day of employment. Not more than 30 days in the future (checked by trigger).';
COMMENT ON COLUMN employees.employment_status IS 'BRD. Employment type.';
COMMENT ON COLUMN employees.tin IS 'BRD. Tax Identification Number. Required before first payroll. Unique.';
COMMENT ON COLUMN employees.sss_no IS 'BRD. SSS number. Required before first payroll. Unique.';
COMMENT ON COLUMN employees.philhealth_no IS 'BRD. PhilHealth number. Required before first payroll. Unique.';
COMMENT ON COLUMN employees.pagibig_no IS 'BRD. Pag-IBIG MID number. Required before first payroll. Unique.';
COMMENT ON COLUMN employees.basic_rate IS 'BRD. Basic monthly salary in PHP; must be > 0. Restricted to HR and Payroll.';
COMMENT ON COLUMN employees.nationality IS 'Nationality.';
COMMENT ON COLUMN employees.photo_file_id IS 'ID photo.';
COMMENT ON COLUMN employees.personal_email IS 'Personal email.';
COMMENT ON COLUMN employees.address_line IS 'House no., street, barangay.';
COMMENT ON COLUMN employees.city IS 'City or municipality.';
COMMENT ON COLUMN employees.province IS 'Province.';
COMMENT ON COLUMN employees.emergency_name IS 'Emergency contact person.';
COMMENT ON COLUMN employees.emergency_relationship IS 'Their relationship to the employee.';
COMMENT ON COLUMN employees.emergency_phone IS 'Their phone number.';
COMMENT ON COLUMN employees.position_id IS 'Current position.';
COMMENT ON COLUMN employees.org_unit_id IS 'Team, or the department when not in a team.';
COMMENT ON COLUMN employees.supervisor_id IS 'Immediate supervisor.';
COMMENT ON COLUMN employees.record_status IS 'Whether the person is currently working here.';
COMMENT ON COLUMN employees.regularization_date IS 'When the employee became REGULAR.';
COMMENT ON COLUMN employees.separation_date IS 'Last day, once separated.';
COMMENT ON COLUMN employees.work_schedule IS 'Schedule as shown on the 201 File, e.g. Mon-Fri, 8:30 AM - 5:00 PM.';
COMMENT ON COLUMN employees.default_shift_id IS 'Usual shift; overridden per day in schedule_overrides.';
COMMENT ON COLUMN employees.face_enrolled IS 'Face template enrolled for face-scan clock-in.';
COMMENT ON COLUMN employees.created_at IS 'When the row was created.';
COMMENT ON COLUMN employees.updated_at IS 'Last change.';
COMMENT ON TABLE dependents IS 'Spouse and children, for HMO enrollment and leave eligibility.';
COMMENT ON COLUMN dependents.id IS 'Primary key.';
COMMENT ON COLUMN dependents.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN dependents.full_name IS 'Dependent''s name.';
COMMENT ON COLUMN dependents.relationship IS 'Relationship.';
COMMENT ON COLUMN dependents.birth_date IS 'Birth date (children).';
COMMENT ON COLUMN dependents.hmo_enrolled IS 'Enrolled as an HMO dependent.';
COMMENT ON TABLE files IS 'Uploaded files: documents, receipts, photos. Kept in `content` for now; object storage later.';
COMMENT ON COLUMN files.id IS 'Primary key.';
COMMENT ON COLUMN files.storage_key IS 'Object-storage key.';
COMMENT ON COLUMN files.file_name IS 'Original file name.';
COMMENT ON COLUMN files.content_type IS 'MIME type.';
COMMENT ON COLUMN files.size_bytes IS 'File size.';
COMMENT ON COLUMN files.sha256 IS 'Checksum, to catch duplicates.';
COMMENT ON COLUMN files.content IS 'The file itself, while files are kept in the database (null once moved to object storage).';
COMMENT ON COLUMN files.uploaded_by IS 'Account that uploaded it.';
COMMENT ON COLUMN files.uploaded_at IS 'Upload time.';
COMMENT ON TABLE employee_documents IS 'Pre-employment and identity documents in the 201 File checklist.';
COMMENT ON COLUMN employee_documents.id IS 'Primary key.';
COMMENT ON COLUMN employee_documents.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN employee_documents.document_type IS 'Checklist item.';
COMMENT ON COLUMN employee_documents.status IS 'Where it stands.';
COMMENT ON COLUMN employee_documents.file_id IS 'The uploaded scan.';
COMMENT ON COLUMN employee_documents.file_name IS 'Name of the submitted file.';
COMMENT ON COLUMN employee_documents.submitted_at IS 'When it was uploaded.';
COMMENT ON COLUMN employee_documents.verified_by IS 'HR account that verified it.';
COMMENT ON COLUMN employee_documents.verified_by_name IS 'Name of who verified it, kept if the account goes.';
COMMENT ON COLUMN employee_documents.verified_at IS 'When it was verified.';
COMMENT ON COLUMN employee_documents.id_type IS 'For government IDs: UMID, Passport, Driver''s License…';
COMMENT ON COLUMN employee_documents.reference_no IS 'ID or license number. Sensitive.';
COMMENT ON COLUMN employee_documents.expires_on IS 'Expiry of the ID, license or clearance; drives renewal alerts.';
COMMENT ON COLUMN employee_documents.note IS 'HR note.';
COMMENT ON TABLE job_events IS 'Employment history: hires, promotions, transfers, salary changes, separations.';
COMMENT ON COLUMN job_events.id IS 'Primary key.';
COMMENT ON COLUMN job_events.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN job_events.event_kind IS 'What happened.';
COMMENT ON COLUMN job_events.effective_date IS 'When it takes effect.';
COMMENT ON COLUMN job_events.changes IS 'List of {label, from, to} field changes.';
COMMENT ON COLUMN job_events.remarks IS 'Personnel action notice number or remarks.';
COMMENT ON COLUMN job_events.recorded_by IS 'Account that recorded it.';
COMMENT ON COLUMN job_events.recorded_by_name IS 'Name of who recorded it, kept if the account goes.';
COMMENT ON COLUMN job_events.recorded_at IS 'When it was recorded.';
COMMENT ON TABLE professional_licenses IS 'PRC licenses (CPA, lawyer) and CPD unit progress.';
COMMENT ON COLUMN professional_licenses.id IS 'Primary key.';
COMMENT ON COLUMN professional_licenses.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN professional_licenses.license_type IS 'e.g. CPA.';
COMMENT ON COLUMN professional_licenses.license_number IS 'PRC license number.';
COMMENT ON COLUMN professional_licenses.expires_on IS 'License validity.';
COMMENT ON COLUMN professional_licenses.cpd_units_earned IS 'CPD units earned this cycle.';
COMMENT ON COLUMN professional_licenses.cpd_units_required IS 'CPD units required for renewal.';
COMMENT ON COLUMN professional_licenses.cycle_end_date IS 'End of the current CPD compliance cycle.';
COMMENT ON TABLE employee_benefits IS 'HMO and government benefit memberships.';
COMMENT ON COLUMN employee_benefits.id IS 'Primary key.';
COMMENT ON COLUMN employee_benefits.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN employee_benefits.benefit_name IS 'e.g. HMO, HMO — Dependent.';
COMMENT ON COLUMN employee_benefits.provider IS 'e.g. Maxicare.';
COMMENT ON COLUMN employee_benefits.member_no IS 'Membership or card number.';
COMMENT ON COLUMN employee_benefits.status IS 'Enrollment status.';
COMMENT ON TABLE performance_reviews IS 'Appraisals, annual and mid-year.';
COMMENT ON COLUMN performance_reviews.id IS 'Primary key.';
COMMENT ON COLUMN performance_reviews.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN performance_reviews.review_period IS 'e.g. 2026 Mid-year review.';
COMMENT ON COLUMN performance_reviews.reviewer_id IS 'Who reviewed.';
COMMENT ON COLUMN performance_reviews.rating IS 'Score out of 5.';
COMMENT ON COLUMN performance_reviews.status IS 'Review status.';
COMMENT ON COLUMN performance_reviews.completed_at IS 'When it was completed.';
COMMENT ON TABLE training_records IS 'Assigned trainings and their progress.';
COMMENT ON COLUMN training_records.id IS 'Primary key.';
COMMENT ON COLUMN training_records.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN training_records.course IS 'Course name.';
COMMENT ON COLUMN training_records.due_date IS 'Deadline.';
COMMENT ON COLUMN training_records.status IS 'Progress.';
COMMENT ON COLUMN training_records.completed_on IS 'Completion date.';
COMMENT ON TABLE employee_cases IS 'Employee relations cases a partner or HR files.';
COMMENT ON COLUMN employee_cases.id IS 'Primary key.';
COMMENT ON COLUMN employee_cases.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN employee_cases.case_type IS 'Kind of case.';
COMMENT ON COLUMN employee_cases.status IS 'Case status.';
COMMENT ON COLUMN employee_cases.summary IS 'What happened and what was done.';
COMMENT ON COLUMN employee_cases.filed_by IS 'Account that filed it.';
COMMENT ON COLUMN employee_cases.filed_on IS 'Filing date.';
COMMENT ON TABLE company_assets IS 'Laptops, IDs, access cards and phones issued to employees.';
COMMENT ON COLUMN company_assets.id IS 'Primary key.';
COMMENT ON COLUMN company_assets.asset_tag IS 'Inventory tag, e.g. LT-0231.';
COMMENT ON COLUMN company_assets.asset_type IS 'e.g. Laptop, Company ID, Access Card.';
COMMENT ON COLUMN company_assets.assigned_employee_id IS 'Who has it now.';
COMMENT ON COLUMN company_assets.issued_on IS 'Issue date.';
COMMENT ON COLUMN company_assets.returned_on IS 'Return date.';
COMMENT ON COLUMN company_assets.status IS 'Condition.';
COMMENT ON TABLE offboarding_cases IS 'Resignations and separations with clearance progress.';
COMMENT ON COLUMN offboarding_cases.id IS 'Primary key.';
COMMENT ON COLUMN offboarding_cases.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN offboarding_cases.separation_type IS 'e.g. Voluntary resignation.';
COMMENT ON COLUMN offboarding_cases.reason IS 'Stated reason.';
COMMENT ON COLUMN offboarding_cases.notice_filed_on IS 'When notice was given (30-day rule).';
COMMENT ON COLUMN offboarding_cases.last_day IS 'Last working day.';
COMMENT ON COLUMN offboarding_cases.stage IS 'Where it stands.';
COMMENT ON COLUMN offboarding_cases.clearance IS 'List of {department, status} clearance sign-offs.';
COMMENT ON TABLE certificate_requests IS 'COE and other certificates employees request.';
COMMENT ON COLUMN certificate_requests.id IS 'Primary key.';
COMMENT ON COLUMN certificate_requests.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN certificate_requests.certificate_type IS 'e.g. Certificate of Employment.';
COMMENT ON COLUMN certificate_requests.purpose IS 'e.g. Bank loan application.';
COMMENT ON COLUMN certificate_requests.status IS 'Status.';
COMMENT ON COLUMN certificate_requests.requested_at IS 'Request time.';
COMMENT ON COLUMN certificate_requests.released_at IS 'Release time.';
COMMENT ON TABLE shift_templates IS 'Work shifts: Busy season, Peak season, Mid shift, Flexible time.';
COMMENT ON COLUMN shift_templates.id IS 'Short key, e.g. sh-day; new shifts get sh-…';
COMMENT ON COLUMN shift_templates.name IS 'Shift name.';
COMMENT ON COLUMN shift_templates.start_time IS 'Start, local time.';
COMMENT ON COLUMN shift_templates.end_time IS 'End; earlier than start means it ends next day.';
COMMENT ON COLUMN shift_templates.break_minutes IS 'Unpaid break length.';
COMMENT ON COLUMN shift_templates.break_start IS 'When lunch starts; lunch out/in are recorded from it.';
COMMENT ON COLUMN shift_templates.grace_minutes IS 'Minutes after start before someone is late.';
COMMENT ON COLUMN shift_templates.rest_days IS 'Days off, 0 = Sunday.';
COMMENT ON COLUMN shift_templates.is_flexible IS 'Clock in any time in the window; only hours worked count.';
COMMENT ON COLUMN shift_templates.required_hours IS 'Hours a flexible day needs.';
COMMENT ON COLUMN shift_templates.is_active IS 'Retired shifts stay for history.';
COMMENT ON TABLE schedule_overrides IS 'A different shift, or a rest day, for one person on one date.';
COMMENT ON COLUMN schedule_overrides.employee_id IS 'The employee.';
COMMENT ON COLUMN schedule_overrides.work_date IS 'The date.';
COMMENT ON COLUMN schedule_overrides.shift_id IS 'Shift that day; null means a rest day.';
COMMENT ON COLUMN schedule_overrides.set_by IS 'Account that set it.';
COMMENT ON TABLE attendance_devices IS 'Registered biometric scanners and face kiosks.';
COMMENT ON COLUMN attendance_devices.id IS 'Primary key.';
COMMENT ON COLUMN attendance_devices.name IS 'e.g. Cebu HQ lobby, 8F.';
COMMENT ON COLUMN attendance_devices.device_type IS 'Kind of device.';
COMMENT ON COLUMN attendance_devices.branch_id IS 'Branch it''s installed in.';
COMMENT ON COLUMN attendance_devices.serial_no IS 'Hardware serial.';
COMMENT ON COLUMN attendance_devices.is_registered IS 'Punches from unregistered devices get flagged.';
COMMENT ON TABLE punches IS 'Every time-in and time-out. Never deleted; HR sets bad ones aside.';
COMMENT ON COLUMN punches.id IS 'Primary key.';
COMMENT ON COLUMN punches.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN punches.work_date IS 'Schedule day it belongs to (an overnight shift''s 6 AM out counts for the day before).';
COMMENT ON COLUMN punches.punched_at IS 'The moment of the punch.';
COMMENT ON COLUMN punches.direction IS 'Time-in or time-out.';
COMMENT ON COLUMN punches.source IS 'Where it came from.';
COMMENT ON COLUMN punches.device_id IS 'Device that recorded it.';
COMMENT ON COLUMN punches.device_label IS 'Where it came from as shown on the record, e.g. Added by HR, Remote · face scan.';
COMMENT ON COLUMN punches.device_branch IS 'Branch of the device (or of the person, for manual punches).';
COMMENT ON COLUMN punches.face_match IS 'Face recognition match, 0–100.';
COMMENT ON COLUMN punches.reason IS 'Why HR added it (manual punches), or the remote work day''s reason.';
COMMENT ON COLUMN punches.recorded_by IS 'Account that added a manual or remote punch.';
COMMENT ON COLUMN punches.recorded_by_name IS 'Name of who recorded it.';
COMMENT ON COLUMN punches.voided_reason IS 'Why HR set it aside.';
COMMENT ON COLUMN punches.voided_by IS 'Who set it aside.';
COMMENT ON COLUMN punches.voided_by_name IS 'Name of who set it aside.';
COMMENT ON COLUMN punches.voided_at IS 'When.';
COMMENT ON COLUMN punches.confirmed_by IS 'HR looked at a flagged punch and kept it.';
COMMENT ON COLUMN punches.confirmed_by_name IS 'Name of who kept it.';
COMMENT ON COLUMN punches.confirmed_at IS 'When.';
COMMENT ON TABLE time_requests IS 'Overtime and undertime requests.';
COMMENT ON COLUMN time_requests.id IS 'Primary key.';
COMMENT ON COLUMN time_requests.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN time_requests.work_date IS 'The day.';
COMMENT ON COLUMN time_requests.request_type IS 'Kind.';
COMMENT ON COLUMN time_requests.minutes IS 'Minutes requested.';
COMMENT ON COLUMN time_requests.reason IS 'Why.';
COMMENT ON COLUMN time_requests.status IS 'Status.';
COMMENT ON COLUMN time_requests.filed_by_name IS 'Name of who filed it.';
COMMENT ON COLUMN time_requests.filed_at IS 'When filed.';
COMMENT ON COLUMN time_requests.decided_by IS 'Account that approved or declined it.';
COMMENT ON COLUMN time_requests.decided_by_name IS 'Name of who decided, kept if the account goes.';
COMMENT ON COLUMN time_requests.decided_at IS 'When it was decided.';
COMMENT ON COLUMN time_requests.decision_note IS 'Note from the approver to the employee.';
COMMENT ON TABLE punch_fix_requests IS 'Employee asks HR to add or correct a time-in/out the device missed.';
COMMENT ON COLUMN punch_fix_requests.id IS 'Primary key.';
COMMENT ON COLUMN punch_fix_requests.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN punch_fix_requests.work_date IS 'The day.';
COMMENT ON COLUMN punch_fix_requests.direction IS 'Which punch.';
COMMENT ON COLUMN punch_fix_requests.requested_time IS 'Correct time.';
COMMENT ON COLUMN punch_fix_requests.next_day IS 'Time falls on the next calendar day.';
COMMENT ON COLUMN punch_fix_requests.cause IS 'What went wrong.';
COMMENT ON COLUMN punch_fix_requests.recorded_time IS 'Time on record when the request was sent.';
COMMENT ON COLUMN punch_fix_requests.reason IS 'Explanation.';
COMMENT ON COLUMN punch_fix_requests.status IS 'Status.';
COMMENT ON COLUMN punch_fix_requests.filed_by_name IS 'Name of who filed it.';
COMMENT ON COLUMN punch_fix_requests.filed_at IS 'When filed.';
COMMENT ON COLUMN punch_fix_requests.decided_by IS 'Account that approved or declined it.';
COMMENT ON COLUMN punch_fix_requests.decided_by_name IS 'Name of who decided, kept if the account goes.';
COMMENT ON COLUMN punch_fix_requests.decided_at IS 'When it was decided.';
COMMENT ON COLUMN punch_fix_requests.decision_note IS 'Note from the approver to the employee.';
COMMENT ON TABLE remote_work_days IS 'Work-from-home days HR declares for typhoons and emergencies.';
COMMENT ON COLUMN remote_work_days.id IS 'Primary key.';
COMMENT ON COLUMN remote_work_days.date_from IS 'First day.';
COMMENT ON COLUMN remote_work_days.date_to IS 'Last day.';
COMMENT ON COLUMN remote_work_days.reason IS 'e.g. Typhoon signal no. 3.';
COMMENT ON COLUMN remote_work_days.declared_by IS 'Who declared it.';
COMMENT ON COLUMN remote_work_days.declared_by_name IS 'Name of who declared it.';
COMMENT ON COLUMN remote_work_days.declared_at IS 'When.';
COMMENT ON TABLE remote_work_day_branches IS 'Branches a remote work day covers. No rows means every branch.';
COMMENT ON COLUMN remote_work_day_branches.remote_work_day_id IS 'The remote work day.';
COMMENT ON COLUMN remote_work_day_branches.branch_id IS 'Branch covered.';
COMMENT ON TABLE attendance_notices IS 'Memos HR sends about repeated lateness or AWOL. Never change pay.';
COMMENT ON COLUMN attendance_notices.id IS 'Primary key.';
COMMENT ON COLUMN attendance_notices.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN attendance_notices.notice_kind IS 'Kind.';
COMMENT ON COLUMN attendance_notices.subject IS 'Subject line.';
COMMENT ON COLUMN attendance_notices.message IS 'Body.';
COMMENT ON COLUMN attendance_notices.dates IS 'The days it''s about.';
COMMENT ON COLUMN attendance_notices.sent_by IS 'Sender.';
COMMENT ON COLUMN attendance_notices.sent_by_name IS 'Name of the sender.';
COMMENT ON COLUMN attendance_notices.sent_at IS 'When sent.';
COMMENT ON COLUMN attendance_notices.acknowledged_at IS 'When the employee acknowledged it.';
COMMENT ON TABLE premium_rates IS 'Statutory premium multipliers by kind of day, versioned by effective date.';
COMMENT ON COLUMN premium_rates.day_type IS 'Kind of day.';
COMMENT ON COLUMN premium_rates.effective_from IS 'First day these rates apply.';
COMMENT ON COLUMN premium_rates.first_eight_hours IS 'Multiplier for the first 8 hours, e.g. 1.30.';
COMMENT ON COLUMN premium_rates.overtime IS 'Multiplier for overtime hours, e.g. 1.69.';
COMMENT ON COLUMN premium_rates.source IS 'Labor Code article or DOLE advisory.';
COMMENT ON COLUMN premium_rates.last_verified IS 'When someone last checked it against the source.';
COMMENT ON TABLE leave_types IS 'Company and statutory leave types (VL, SL, maternity, solo parent…).';
COMMENT ON COLUMN leave_types.id IS 'Short key, e.g. vl, ml; new types get lt-…';
COMMENT ON COLUMN leave_types.name IS 'e.g. Vacation leave.';
COMMENT ON COLUMN leave_types.code IS 'e.g. VL.';
COMMENT ON COLUMN leave_types.days_per_year IS 'Days a year, or per event for statutory leave; 0 = unlimited.';
COMMENT ON COLUMN leave_types.earning_kind IS 'How days are earned.';
COMMENT ON COLUMN leave_types.earning_per_month IS 'Days earned each month, for monthly accrual.';
COMMENT ON COLUMN leave_types.is_paid IS 'Unpaid leave is deducted in payroll.';
COMMENT ON COLUMN leave_types.carry_over_max IS 'Unused days that roll into next year.';
COMMENT ON COLUMN leave_types.count_by IS 'Skip rest days and holidays, or count every day.';
COMMENT ON COLUMN leave_types.eligibility IS 'Who can use it.';
COMMENT ON COLUMN leave_types.attachment_over_days IS 'Attachment required past this many days; null = never.';
COMMENT ON COLUMN leave_types.is_confidential IS 'Reason hidden from all but HR (VAWC).';
COMMENT ON COLUMN leave_types.legal_basis IS 'Law or policy it comes from.';
COMMENT ON COLUMN leave_types.is_active IS 'Active.';
COMMENT ON TABLE leave_requests IS 'Leave filed by or for an employee.';
COMMENT ON COLUMN leave_requests.id IS 'Primary key.';
COMMENT ON COLUMN leave_requests.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN leave_requests.leave_type_id IS 'Type of leave.';
COMMENT ON COLUMN leave_requests.date_from IS 'First day.';
COMMENT ON COLUMN leave_requests.date_to IS 'Last day.';
COMMENT ON COLUMN leave_requests.half_day IS 'Half day, only when the dates are equal.';
COMMENT ON COLUMN leave_requests.days IS 'Days charged, after skipping rest days and holidays.';
COMMENT ON COLUMN leave_requests.reason IS 'Reason.';
COMMENT ON COLUMN leave_requests.attachment_file_id IS 'Medical certificate or other proof.';
COMMENT ON COLUMN leave_requests.attachment_name IS 'Name of the attached file.';
COMMENT ON COLUMN leave_requests.status IS 'Status.';
COMMENT ON COLUMN leave_requests.filed_by IS 'Account that filed it (the employee or HR).';
COMMENT ON COLUMN leave_requests.filed_by_name IS 'Name of who filed it.';
COMMENT ON COLUMN leave_requests.filed_at IS 'When filed.';
COMMENT ON COLUMN leave_requests.decided_by IS 'Account that approved or declined it.';
COMMENT ON COLUMN leave_requests.decided_by_name IS 'Name of who decided, kept if the account goes.';
COMMENT ON COLUMN leave_requests.decided_at IS 'When it was decided.';
COMMENT ON COLUMN leave_requests.decision_note IS 'Note from the approver to the employee.';
COMMENT ON TABLE leave_adjustments IS 'Manual changes HR makes to a balance or to the yearly leave credits.';
COMMENT ON COLUMN leave_adjustments.id IS 'Primary key.';
COMMENT ON COLUMN leave_adjustments.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN leave_adjustments.leave_type_id IS 'Type of leave; null means the yearly credit pool (6 leaves a year).';
COMMENT ON COLUMN leave_adjustments.days IS 'Positive adds, negative removes (days, or whole leaves for the credit pool).';
COMMENT ON COLUMN leave_adjustments.reason IS 'Why.';
COMMENT ON COLUMN leave_adjustments.adjusted_by IS 'Who made it.';
COMMENT ON COLUMN leave_adjustments.adjusted_by_name IS 'Name of who made it.';
COMMENT ON COLUMN leave_adjustments.adjusted_at IS 'When.';
COMMENT ON TABLE leave_carry_overs IS 'Unused days brought into a year.';
COMMENT ON COLUMN leave_carry_overs.employee_id IS 'The employee.';
COMMENT ON COLUMN leave_carry_overs.leave_type_id IS 'Type of leave.';
COMMENT ON COLUMN leave_carry_overs.leave_year IS 'Year the days are carried into.';
COMMENT ON COLUMN leave_carry_overs.days IS 'Days carried over.';
COMMENT ON TABLE contribution_rate_versions IS 'SSS, PhilHealth, Pag-IBIG and BIR tables. A new circular is a new row, so past pay can still be recomputed.';
COMMENT ON COLUMN contribution_rate_versions.id IS 'Primary key.';
COMMENT ON COLUMN contribution_rate_versions.agency IS 'Agency.';
COMMENT ON COLUMN contribution_rate_versions.effective_from IS 'First pay date the rates apply to.';
COMMENT ON COLUMN contribution_rate_versions.source IS 'Circular or schedule it comes from.';
COMMENT ON COLUMN contribution_rate_versions.rates IS 'Rates in the agency''s shape (EE/ER rates, MSC range, tax brackets).';
COMMENT ON COLUMN contribution_rate_versions.saved_by IS 'Who saved this version.';
COMMENT ON COLUMN contribution_rate_versions.saved_by_name IS 'Name of who saved it (Built in for the starting tables).';
COMMENT ON COLUMN contribution_rate_versions.saved_at IS 'When.';
COMMENT ON TABLE payroll_runs IS 'One payroll per cutoff. Draft runs recompute from attendance; approved runs are locked.';
COMMENT ON COLUMN payroll_runs.id IS 'Primary key.';
COMMENT ON COLUMN payroll_runs.label IS 'e.g. Oct 1–15, 2026.';
COMMENT ON COLUMN payroll_runs.period_from IS 'Cutoff start.';
COMMENT ON COLUMN payroll_runs.period_to IS 'Cutoff end.';
COMMENT ON COLUMN payroll_runs.branch_id IS 'Branch, when run per office; null = all.';
COMMENT ON COLUMN payroll_runs.status IS 'Status.';
COMMENT ON COLUMN payroll_runs.created_by IS 'Who started it.';
COMMENT ON COLUMN payroll_runs.created_by_name IS 'Name of who started it.';
COMMENT ON COLUMN payroll_runs.created_at IS 'When.';
COMMENT ON COLUMN payroll_runs.computed_at IS 'Last recompute from attendance.';
COMMENT ON COLUMN payroll_runs.approved_by IS 'Who approved it (the CEO).';
COMMENT ON COLUMN payroll_runs.approved_by_name IS 'Name of who approved it.';
COMMENT ON COLUMN payroll_runs.approved_at IS 'When approved.';
COMMENT ON COLUMN payroll_runs.payslips_released_at IS 'When employees could see their payslips.';
COMMENT ON TABLE payroll_run_lines IS 'One employee''s pay in a run: the payslip.';
COMMENT ON COLUMN payroll_run_lines.payroll_run_id IS 'The run.';
COMMENT ON COLUMN payroll_run_lines.employee_id IS 'The employee.';
COMMENT ON COLUMN payroll_run_lines.basic_pay IS 'Half the monthly pay, or days employed if mid-cutoff.';
COMMENT ON COLUMN payroll_run_lines.absence_deductions IS 'Absences, AWOL, unpaid leave, undertime.';
COMMENT ON COLUMN payroll_run_lines.overtime_pay IS 'Approved overtime.';
COMMENT ON COLUMN payroll_run_lines.premium_pay IS 'Holiday, rest-day and night premiums.';
COMMENT ON COLUMN payroll_run_lines.gross_pay IS 'Gross.';
COMMENT ON COLUMN payroll_run_lines.sss_ee IS 'SSS employee share.';
COMMENT ON COLUMN payroll_run_lines.sss_er IS 'SSS employer share.';
COMMENT ON COLUMN payroll_run_lines.sss_ec IS 'Employees'' Compensation.';
COMMENT ON COLUMN payroll_run_lines.philhealth_ee IS 'PhilHealth employee share.';
COMMENT ON COLUMN payroll_run_lines.philhealth_er IS 'PhilHealth employer share.';
COMMENT ON COLUMN payroll_run_lines.pagibig_ee IS 'Pag-IBIG employee share.';
COMMENT ON COLUMN payroll_run_lines.pagibig_er IS 'Pag-IBIG employer share.';
COMMENT ON COLUMN payroll_run_lines.taxable_income IS 'Gross less contributions and non-taxable items.';
COMMENT ON COLUMN payroll_run_lines.withholding_tax IS 'BIR withholding tax.';
COMMENT ON COLUMN payroll_run_lines.net_pay IS 'Take-home pay.';
COMMENT ON COLUMN payroll_run_lines.computation IS 'Full line-by-line computation and the attendance it used.';
COMMENT ON TABLE payroll_adjustments IS 'Additions or deductions to one employee''s pay in a run.';
COMMENT ON COLUMN payroll_adjustments.id IS 'Primary key.';
COMMENT ON COLUMN payroll_adjustments.payroll_run_id IS 'The run.';
COMMENT ON COLUMN payroll_adjustments.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN payroll_adjustments.label IS 'Shown on the payslip, e.g. Reimbursement.';
COMMENT ON COLUMN payroll_adjustments.amount IS 'Positive adds, negative deducts.';
COMMENT ON COLUMN payroll_adjustments.is_taxable IS 'Taxable items go into gross before tax.';
COMMENT ON COLUMN payroll_adjustments.reason IS 'Why.';
COMMENT ON COLUMN payroll_adjustments.reimbursement_claim_id IS 'Claim being paid, if any.';
COMMENT ON TABLE reimbursement_claims IS 'Expense claims with a receipt photo.';
COMMENT ON COLUMN reimbursement_claims.id IS 'Primary key.';
COMMENT ON COLUMN reimbursement_claims.employee_id IS 'The employee this belongs to.';
COMMENT ON COLUMN reimbursement_claims.category IS 'Expense category.';
COMMENT ON COLUMN reimbursement_claims.other_type IS 'What they typed when the category is Other.';
COMMENT ON COLUMN reimbursement_claims.merchant IS 'Store or provider on the receipt.';
COMMENT ON COLUMN reimbursement_claims.purchase_date IS 'Date on the receipt (within 60 days).';
COMMENT ON COLUMN reimbursement_claims.amount IS 'Amount claimed (max 50,000).';
COMMENT ON COLUMN reimbursement_claims.description IS 'What it was for.';
COMMENT ON COLUMN reimbursement_claims.receipt_file_id IS 'Receipt photo.';
COMMENT ON COLUMN reimbursement_claims.status IS 'Status.';
COMMENT ON COLUMN reimbursement_claims.filed_at IS 'When filed.';
COMMENT ON COLUMN reimbursement_claims.decided_by IS 'Account that approved or declined it.';
COMMENT ON COLUMN reimbursement_claims.decided_by_name IS 'Name of who decided, kept if the account goes.';
COMMENT ON COLUMN reimbursement_claims.decided_at IS 'When it was decided.';
COMMENT ON COLUMN reimbursement_claims.decision_note IS 'Note from the approver to the employee.';
COMMENT ON TABLE roles IS 'Roles that set a user''s workspace and module access.';
COMMENT ON COLUMN roles.id IS 'Role key, e.g. super-admin, hr.';
COMMENT ON COLUMN roles.name IS 'Display name.';
COMMENT ON COLUMN roles.description IS 'What the role is for.';
COMMENT ON COLUMN roles.workspace IS 'Workspace it signs into.';
COMMENT ON COLUMN roles.is_built_in IS 'Built-in roles can''t be deleted.';
COMMENT ON COLUMN roles.is_super_admin IS 'Manages roles, settings and other super admins.';
COMMENT ON TABLE role_module_access IS 'Access a role has to each HR-workspace module.';
COMMENT ON COLUMN role_module_access.role_id IS 'The role.';
COMMENT ON COLUMN role_module_access.module IS 'Module.';
COMMENT ON COLUMN role_module_access.access IS 'Level.';
COMMENT ON TABLE user_accounts IS 'Sign-in accounts. Linked to an employee when the user is one.';
COMMENT ON COLUMN user_accounts.id IS 'Primary key.';
COMMENT ON COLUMN user_accounts.username IS 'Sign-in name.';
COMMENT ON COLUMN user_accounts.builtin_key IS 'Marks the four built-in accounts.';
COMMENT ON COLUMN user_accounts.display_name IS 'Name shown in the app.';
COMMENT ON COLUMN user_accounts.password_hash IS 'Argon2id or bcrypt hash; never the password.';
COMMENT ON COLUMN user_accounts.employee_id IS 'Employee record, if any.';
COMMENT ON COLUMN user_accounts.role_id IS 'Role.';
COMMENT ON COLUMN user_accounts.status IS 'Status.';
COMMENT ON COLUMN user_accounts.must_change_password IS 'Force a change at next sign-in.';
COMMENT ON COLUMN user_accounts.last_sign_in_at IS 'Last successful sign-in.';
COMMENT ON COLUMN user_accounts.failed_attempts IS 'Failed sign-ins since the last success.';
COMMENT ON COLUMN user_accounts.locked_until IS 'Locked until this time.';
COMMENT ON COLUMN user_accounts.created_at IS 'When the row was created.';
COMMENT ON TABLE user_sessions IS 'Signed-in sessions. The browser holds the token in an HttpOnly cookie; only its hash is stored.';
COMMENT ON COLUMN user_sessions.token_hash IS 'SHA-256 of the session token.';
COMMENT ON COLUMN user_sessions.account_id IS 'Who is signed in.';
COMMENT ON COLUMN user_sessions.created_at IS 'Sign-in time.';
COMMENT ON COLUMN user_sessions.last_seen_at IS 'Last request; idle sessions expire.';
COMMENT ON COLUMN user_sessions.expires_at IS 'Hard expiry.';
COMMENT ON COLUMN user_sessions.user_agent IS 'Browser, for the sign-in log.';
COMMENT ON TABLE approval_workflows IS 'How each kind of request gets approved.';
COMMENT ON COLUMN approval_workflows.request_kind IS 'Kind of request.';
COMMENT ON COLUMN approval_workflows.remind_after_days IS 'Remind the approver after this many days (0 = never).';
COMMENT ON COLUMN approval_workflows.is_active IS 'Active.';
COMMENT ON TABLE approval_workflow_steps IS 'Ordered approval steps in a workflow.';
COMMENT ON COLUMN approval_workflow_steps.request_kind IS 'The workflow.';
COMMENT ON COLUMN approval_workflow_steps.step_no IS 'Order, starting at 1.';
COMMENT ON COLUMN approval_workflow_steps.approver_kind IS 'Who approves.';
COMMENT ON COLUMN approval_workflow_steps.role_id IS 'Role that approves, when approver_kind = role.';
COMMENT ON COLUMN approval_workflow_steps.over_days IS 'Only for leave longer than this many days.';
COMMENT ON TABLE audit_log IS 'Append-only trail: sign-ins, admin changes, 201 File views and edits, timekeeping changes, payroll approvals.';
COMMENT ON COLUMN audit_log.id IS 'Sequence.';
COMMENT ON COLUMN audit_log.occurred_at IS 'When.';
COMMENT ON COLUMN audit_log.actor_account_id IS 'Who did it.';
COMMENT ON COLUMN audit_log.actor_name IS 'Name at the time, kept if the account is deleted.';
COMMENT ON COLUMN audit_log.module IS 'Area.';
COMMENT ON COLUMN audit_log.action IS 'e.g. Viewed, Edited, Verified, Approved.';
COMMENT ON COLUMN audit_log.employee_id IS 'Whose record it touched, if any.';
COMMENT ON COLUMN audit_log.target IS 'What it touched, e.g. Valid Government ID.';
COMMENT ON COLUMN audit_log.detail IS 'Human-readable detail.';
COMMENT ON COLUMN audit_log.data IS 'Before/after values for edits.';
COMMENT ON TABLE announcements IS 'Company news shown on employee dashboards.';
COMMENT ON COLUMN announcements.id IS 'Primary key.';
COMMENT ON COLUMN announcements.title IS 'Headline.';
COMMENT ON COLUMN announcements.body IS 'Full text.';
COMMENT ON COLUMN announcements.branch_id IS 'Branch it''s for; null = everyone.';
COMMENT ON COLUMN announcements.posted_by IS 'Who posted it.';
COMMENT ON COLUMN announcements.posted_at IS 'When.';
COMMENT ON COLUMN announcements.expires_at IS 'Hide after this time.';
COMMENT ON TABLE compliance_filings IS 'Statutory remittances and returns: SSS, PhilHealth, Pag-IBIG, BIR.';
COMMENT ON COLUMN compliance_filings.id IS 'Primary key.';
COMMENT ON COLUMN compliance_filings.agency IS 'Agency.';
COMMENT ON COLUMN compliance_filings.filing IS 'e.g. Withholding tax remittance (1601-C).';
COMMENT ON COLUMN compliance_filings.period IS 'Period covered, e.g. 2026-09.';
COMMENT ON COLUMN compliance_filings.due_date IS 'Deadline.';
COMMENT ON COLUMN compliance_filings.filed_on IS 'When filed; status is computed from this and due_date.';
COMMENT ON COLUMN compliance_filings.reference_no IS 'Receipt or confirmation number.';
COMMENT ON COLUMN compliance_filings.filed_by IS 'Who filed it.';
COMMENT ON COLUMN compliance_filings.note IS 'Note.';
COMMENT ON TABLE job_requisitions IS 'Open positions being recruited for.';
COMMENT ON COLUMN job_requisitions.id IS 'Primary key.';
COMMENT ON COLUMN job_requisitions.position_id IS 'Position being filled.';
COMMENT ON COLUMN job_requisitions.openings IS 'How many to hire.';
COMMENT ON COLUMN job_requisitions.stage IS 'Stage.';
COMMENT ON COLUMN job_requisitions.opened_on IS 'When opened.';
COMMENT ON COLUMN job_requisitions.opened_by IS 'Who opened it.';

-- Extra integrity rules
ALTER TABLE leave_requests ADD CHECK (date_to >= date_from);
ALTER TABLE leave_requests ADD CHECK (half_day IS NULL OR date_from = date_to);
ALTER TABLE remote_work_days ADD CHECK (date_to >= date_from);
ALTER TABLE payroll_runs ADD CHECK (period_to >= period_from);
ALTER TABLE punches ADD CHECK (face_match IS NULL OR face_match BETWEEN 0 AND 100);
ALTER TABLE reimbursement_claims ADD CHECK (amount > 0 AND amount <= 50000);
ALTER TABLE reimbursement_claims ADD CHECK (category <> 'Other' OR other_type IS NOT NULL);
ALTER TABLE approval_workflow_steps ADD CHECK (approver_kind <> 'role' OR role_id IS NOT NULL);
ALTER TABLE contribution_rate_versions ADD UNIQUE (agency, effective_from);

-- New Employees Template rules (BRD v1.1, 11.2.1)
ALTER TABLE employees ADD CONSTRAINT employees_names_letters CHECK (last_name ~ $re$^[[:alpha:] .'-]+$$re$ AND first_name ~ $re$^[[:alpha:] .'-]+$$re$ AND (middle_name IS NULL OR middle_name ~ $re$^[[:alpha:] .'-]+$$re$));
ALTER TABLE employees ADD CONSTRAINT employees_mobile_format CHECK (mobile_no ~ '^09[0-9]{9}$');
ALTER TABLE employees ADD CONSTRAINT employees_email_format CHECK (email ~* $re$^[^@\s]+@[^@\s]+\.[^@\s]+$$re$);
ALTER TABLE employees ADD CONSTRAINT employees_basic_rate_positive CHECK (basic_rate > 0);
CREATE UNIQUE INDEX employees_email_ci ON employees (lower(email));
-- Rules that depend on today's date can't be CHECK constraints, so a trigger enforces them.
CREATE FUNCTION employees_date_rules() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.birth_date > current_date - interval '18 years' THEN
    RAISE EXCEPTION 'Employee must be at least 18 years old' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.date_hired > current_date + 30 THEN
    RAISE EXCEPTION 'Date hired can''t be more than 30 days in the future' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER employees_date_rules BEFORE INSERT OR UPDATE OF birth_date, date_hired ON employees FOR EACH ROW EXECUTE FUNCTION employees_date_rules();
ALTER TABLE payroll_adjustments ADD FOREIGN KEY (payroll_run_id, employee_id) REFERENCES payroll_run_lines (payroll_run_id, employee_id) ON DELETE CASCADE;

-- Foreign keys (added after every table exists, since some point both ways)
ALTER TABLE company_settings ADD CONSTRAINT company_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE org_units ADD CONSTRAINT org_units_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES org_units (id) ON DELETE SET NULL;
ALTER TABLE org_units ADD CONSTRAINT org_units_head_employee_id_fkey FOREIGN KEY (head_employee_id) REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE positions ADD CONSTRAINT positions_department_id_fkey FOREIGN KEY (department_id) REFERENCES org_units (id) ON DELETE RESTRICT;
ALTER TABLE positions ADD CONSTRAINT positions_reports_to_position_id_fkey FOREIGN KEY (reports_to_position_id) REFERENCES positions (id) ON DELETE SET NULL;
ALTER TABLE employees ADD CONSTRAINT employees_photo_file_id_fkey FOREIGN KEY (photo_file_id) REFERENCES files (id) ON DELETE SET NULL;
ALTER TABLE employees ADD CONSTRAINT employees_position_id_fkey FOREIGN KEY (position_id) REFERENCES positions (id) ON DELETE SET NULL;
ALTER TABLE employees ADD CONSTRAINT employees_org_unit_id_fkey FOREIGN KEY (org_unit_id) REFERENCES org_units (id) ON DELETE SET NULL;
ALTER TABLE employees ADD CONSTRAINT employees_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE employees ADD CONSTRAINT employees_default_shift_id_fkey FOREIGN KEY (default_shift_id) REFERENCES shift_templates (id) ON DELETE SET NULL;
ALTER TABLE dependents ADD CONSTRAINT dependents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE files ADD CONSTRAINT files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE employee_documents ADD CONSTRAINT employee_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE employee_documents ADD CONSTRAINT employee_documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE SET NULL;
ALTER TABLE employee_documents ADD CONSTRAINT employee_documents_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE job_events ADD CONSTRAINT job_events_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE job_events ADD CONSTRAINT job_events_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE professional_licenses ADD CONSTRAINT professional_licenses_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE employee_benefits ADD CONSTRAINT employee_benefits_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE performance_reviews ADD CONSTRAINT performance_reviews_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE performance_reviews ADD CONSTRAINT performance_reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE training_records ADD CONSTRAINT training_records_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE employee_cases ADD CONSTRAINT employee_cases_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE employee_cases ADD CONSTRAINT employee_cases_filed_by_fkey FOREIGN KEY (filed_by) REFERENCES user_accounts (id) ON DELETE RESTRICT;
ALTER TABLE company_assets ADD CONSTRAINT company_assets_assigned_employee_id_fkey FOREIGN KEY (assigned_employee_id) REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE offboarding_cases ADD CONSTRAINT offboarding_cases_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE certificate_requests ADD CONSTRAINT certificate_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE schedule_overrides ADD CONSTRAINT schedule_overrides_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE schedule_overrides ADD CONSTRAINT schedule_overrides_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES shift_templates (id) ON DELETE SET NULL;
ALTER TABLE schedule_overrides ADD CONSTRAINT schedule_overrides_set_by_fkey FOREIGN KEY (set_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE attendance_devices ADD CONSTRAINT attendance_devices_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES org_units (id) ON DELETE RESTRICT;
ALTER TABLE punches ADD CONSTRAINT punches_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE punches ADD CONSTRAINT punches_device_id_fkey FOREIGN KEY (device_id) REFERENCES attendance_devices (id) ON DELETE SET NULL;
ALTER TABLE punches ADD CONSTRAINT punches_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE punches ADD CONSTRAINT punches_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE punches ADD CONSTRAINT punches_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE time_requests ADD CONSTRAINT time_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE time_requests ADD CONSTRAINT time_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE punch_fix_requests ADD CONSTRAINT punch_fix_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE punch_fix_requests ADD CONSTRAINT punch_fix_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE remote_work_days ADD CONSTRAINT remote_work_days_declared_by_fkey FOREIGN KEY (declared_by) REFERENCES user_accounts (id) ON DELETE RESTRICT;
ALTER TABLE remote_work_day_branches ADD CONSTRAINT remote_work_day_branches_remote_work_day_id_fkey FOREIGN KEY (remote_work_day_id) REFERENCES remote_work_days (id) ON DELETE CASCADE;
ALTER TABLE remote_work_day_branches ADD CONSTRAINT remote_work_day_branches_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES org_units (id) ON DELETE CASCADE;
ALTER TABLE attendance_notices ADD CONSTRAINT attendance_notices_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE attendance_notices ADD CONSTRAINT attendance_notices_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES user_accounts (id) ON DELETE RESTRICT;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE RESTRICT;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_attachment_file_id_fkey FOREIGN KEY (attachment_file_id) REFERENCES files (id) ON DELETE SET NULL;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_filed_by_fkey FOREIGN KEY (filed_by) REFERENCES user_accounts (id) ON DELETE RESTRICT;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE leave_adjustments ADD CONSTRAINT leave_adjustments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE leave_adjustments ADD CONSTRAINT leave_adjustments_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE SET NULL;
ALTER TABLE leave_adjustments ADD CONSTRAINT leave_adjustments_adjusted_by_fkey FOREIGN KEY (adjusted_by) REFERENCES user_accounts (id) ON DELETE RESTRICT;
ALTER TABLE leave_carry_overs ADD CONSTRAINT leave_carry_overs_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE leave_carry_overs ADD CONSTRAINT leave_carry_overs_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE RESTRICT;
ALTER TABLE contribution_rate_versions ADD CONSTRAINT contribution_rate_versions_saved_by_fkey FOREIGN KEY (saved_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES org_units (id) ON DELETE SET NULL;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES user_accounts (id) ON DELETE RESTRICT;
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE payroll_run_lines ADD CONSTRAINT payroll_run_lines_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs (id) ON DELETE CASCADE;
ALTER TABLE payroll_run_lines ADD CONSTRAINT payroll_run_lines_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE payroll_adjustments ADD CONSTRAINT payroll_adjustments_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs (id) ON DELETE RESTRICT;
ALTER TABLE payroll_adjustments ADD CONSTRAINT payroll_adjustments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE payroll_adjustments ADD CONSTRAINT payroll_adjustments_reimbursement_claim_id_fkey FOREIGN KEY (reimbursement_claim_id) REFERENCES reimbursement_claims (id) ON DELETE SET NULL;
ALTER TABLE reimbursement_claims ADD CONSTRAINT reimbursement_claims_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE reimbursement_claims ADD CONSTRAINT reimbursement_claims_receipt_file_id_fkey FOREIGN KEY (receipt_file_id) REFERENCES files (id) ON DELETE RESTRICT;
ALTER TABLE reimbursement_claims ADD CONSTRAINT reimbursement_claims_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE role_module_access ADD CONSTRAINT role_module_access_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE;
ALTER TABLE user_accounts ADD CONSTRAINT user_accounts_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE user_accounts ADD CONSTRAINT user_accounts_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT;
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES user_accounts (id) ON DELETE CASCADE;
ALTER TABLE approval_workflow_steps ADD CONSTRAINT approval_workflow_steps_request_kind_fkey FOREIGN KEY (request_kind) REFERENCES approval_workflows (request_kind) ON DELETE CASCADE;
ALTER TABLE approval_workflow_steps ADD CONSTRAINT approval_workflow_steps_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE SET NULL;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_account_id_fkey FOREIGN KEY (actor_account_id) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE announcements ADD CONSTRAINT announcements_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES org_units (id) ON DELETE SET NULL;
ALTER TABLE announcements ADD CONSTRAINT announcements_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES user_accounts (id) ON DELETE RESTRICT;
ALTER TABLE compliance_filings ADD CONSTRAINT compliance_filings_filed_by_fkey FOREIGN KEY (filed_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE job_requisitions ADD CONSTRAINT job_requisitions_position_id_fkey FOREIGN KEY (position_id) REFERENCES positions (id) ON DELETE RESTRICT;
ALTER TABLE job_requisitions ADD CONSTRAINT job_requisitions_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES user_accounts (id) ON DELETE SET NULL;

-- Indexes on foreign keys and common lookups
CREATE INDEX ON announcements (branch_id);
CREATE INDEX ON announcements (posted_by);
CREATE INDEX ON approval_workflow_steps (role_id);
CREATE INDEX ON attendance_devices (branch_id);
CREATE INDEX ON attendance_notices (employee_id);
CREATE INDEX ON attendance_notices (sent_by);
CREATE INDEX ON audit_log (actor_account_id);
CREATE INDEX ON audit_log (employee_id);
CREATE INDEX ON certificate_requests (employee_id);
CREATE INDEX ON company_assets (assigned_employee_id);
CREATE INDEX ON company_settings (updated_by);
CREATE INDEX ON compliance_filings (filed_by);
CREATE INDEX ON contribution_rate_versions (saved_by);
CREATE INDEX ON dependents (employee_id);
CREATE INDEX ON employee_benefits (employee_id);
CREATE INDEX ON employee_cases (employee_id);
CREATE INDEX ON employee_cases (filed_by);
CREATE INDEX ON employee_documents (employee_id);
CREATE INDEX ON employee_documents (file_id);
CREATE INDEX ON employee_documents (verified_by);
CREATE INDEX ON employees (default_shift_id);
CREATE INDEX ON employees (org_unit_id);
CREATE INDEX ON employees (photo_file_id);
CREATE INDEX ON employees (position_id);
CREATE INDEX ON employees (supervisor_id);
CREATE INDEX ON files (uploaded_by);
CREATE INDEX ON job_events (employee_id);
CREATE INDEX ON job_events (recorded_by);
CREATE INDEX ON job_requisitions (opened_by);
CREATE INDEX ON job_requisitions (position_id);
CREATE INDEX ON leave_adjustments (adjusted_by);
CREATE INDEX ON leave_adjustments (employee_id);
CREATE INDEX ON leave_adjustments (leave_type_id);
CREATE INDEX ON leave_carry_overs (leave_type_id);
CREATE INDEX ON leave_requests (attachment_file_id);
CREATE INDEX ON leave_requests (decided_by);
CREATE INDEX ON leave_requests (employee_id);
CREATE INDEX ON leave_requests (filed_by);
CREATE INDEX ON leave_requests (leave_type_id);
CREATE INDEX ON offboarding_cases (employee_id);
CREATE INDEX ON org_units (head_employee_id);
CREATE INDEX ON org_units (parent_id);
CREATE INDEX ON payroll_adjustments (employee_id);
CREATE INDEX ON payroll_adjustments (payroll_run_id);
CREATE INDEX ON payroll_adjustments (reimbursement_claim_id);
CREATE INDEX ON payroll_run_lines (employee_id);
CREATE INDEX ON payroll_runs (approved_by);
CREATE INDEX ON payroll_runs (branch_id);
CREATE INDEX ON payroll_runs (created_by);
CREATE INDEX ON performance_reviews (employee_id);
CREATE INDEX ON performance_reviews (reviewer_id);
CREATE INDEX ON positions (department_id);
CREATE INDEX ON positions (reports_to_position_id);
CREATE INDEX ON professional_licenses (employee_id);
CREATE INDEX ON punch_fix_requests (decided_by);
CREATE INDEX ON punch_fix_requests (employee_id);
CREATE INDEX ON punches (confirmed_by);
CREATE INDEX ON punches (device_id);
CREATE INDEX ON punches (employee_id);
CREATE INDEX ON punches (recorded_by);
CREATE INDEX ON punches (voided_by);
CREATE INDEX ON reimbursement_claims (decided_by);
CREATE INDEX ON reimbursement_claims (employee_id);
CREATE INDEX ON reimbursement_claims (receipt_file_id);
CREATE INDEX ON remote_work_day_branches (branch_id);
CREATE INDEX ON remote_work_days (declared_by);
CREATE INDEX ON schedule_overrides (set_by);
CREATE INDEX ON schedule_overrides (shift_id);
CREATE INDEX ON time_requests (decided_by);
CREATE INDEX ON time_requests (employee_id);
CREATE INDEX ON training_records (employee_id);
CREATE INDEX ON user_accounts (employee_id);
CREATE INDEX ON user_accounts (role_id);
CREATE INDEX ON user_sessions (account_id);
CREATE INDEX ON punches (employee_id, work_date);
CREATE INDEX ON leave_requests (employee_id, date_from, date_to);
CREATE INDEX ON audit_log (employee_id, occurred_at DESC);
CREATE INDEX ON employee_documents (expires_on) WHERE expires_on IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('001_leave'), ('002_timekeeping'), ('003_payroll'), ('004_files'), ('005_comments');
COMMIT;
