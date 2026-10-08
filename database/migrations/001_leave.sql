-- 001: Leave on the database.
-- Leave types get short text ids (vl, sl, ml…); requests and adjustments keep who filed/decided by name.
-- The four leave tables were never used, so they are rebuilt. Other request tables get decided_by_name.
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/001_leave.sql

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- Safety: only rebuild the leave tables while they hold no requests or adjustments.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM leave_requests) OR EXISTS (SELECT 1 FROM leave_adjustments) THEN
    RAISE EXCEPTION 'leave_requests or leave_adjustments has rows; this migration would delete them. Stopped, nothing changed.';
  END IF;
END $$;

DROP TABLE IF EXISTS leave_carry_overs, leave_adjustments, leave_requests, leave_types CASCADE;

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

ALTER TABLE leave_requests ADD CHECK (date_to >= date_from);
ALTER TABLE leave_requests ADD CHECK (half_day IS NULL OR date_from = date_to);
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
CREATE INDEX ON leave_adjustments (adjusted_by);
CREATE INDEX ON leave_adjustments (employee_id);
CREATE INDEX ON leave_adjustments (leave_type_id);
CREATE INDEX ON leave_carry_overs (leave_type_id);
CREATE INDEX ON leave_requests (attachment_file_id);
CREATE INDEX ON leave_requests (decided_by);
CREATE INDEX ON leave_requests (employee_id);
CREATE INDEX ON leave_requests (filed_by);
CREATE INDEX ON leave_requests (leave_type_id);
CREATE INDEX ON leave_requests (employee_id, date_from, date_to);

ALTER TABLE time_requests ADD COLUMN IF NOT EXISTS decided_by_name text;
ALTER TABLE punch_fix_requests ADD COLUMN IF NOT EXISTS decided_by_name text;
ALTER TABLE reimbursement_claims ADD COLUMN IF NOT EXISTS decided_by_name text;

-- The API server's login reads and writes rows in the new tables.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heyhr_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON leave_types, leave_requests, leave_adjustments, leave_carry_overs, schema_migrations TO heyhr_app;
END IF; END $$;

INSERT INTO schema_migrations (version) VALUES ('001_leave');

COMMIT;
