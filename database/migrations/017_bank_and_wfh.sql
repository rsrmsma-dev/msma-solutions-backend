-- 017: For the website's update of Oct 9 (bef6a17):
--   * Bank account on the employee record (take-home pay goes there); the account number is encrypted
--     by the app (AES-256-GCM).
--   * work_from_home_days: days an employee switched to working from home themselves, so their
--     face-scan clock-in is accepted.
-- New columns and a new table only. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/017_bank_and_wfh.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('017_bank_and_wfh');

ALTER TABLE employees
  ADD COLUMN bank_name text,
  ADD COLUMN bank_account_name text,
  ADD COLUMN bank_account_no text;

-- Days an employee switched to working from home themselves (their manager is told). They clock in with a face scan.
CREATE TABLE work_from_home_days (
  employee_id varchar(20) NOT NULL,
  work_date date NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, work_date)
);

ALTER TABLE work_from_home_days ADD CONSTRAINT work_from_home_days_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- The app's database login (heyhr_app, made by server/setup-db.ps1) can use the new table.
GRANT SELECT, INSERT, UPDATE, DELETE ON work_from_home_days TO heyhr_app;

COMMENT ON COLUMN employees.bank_name IS 'Bank (or e-wallet) take-home pay is sent to.';
COMMENT ON COLUMN employees.bank_account_name IS 'Name on the account.';
COMMENT ON COLUMN employees.bank_account_no IS 'Account number, encrypted by the app (AES-256-GCM).';
COMMENT ON TABLE work_from_home_days IS 'Days an employee switched to working from home themselves (their manager is told). They clock in with a face scan.';
COMMENT ON COLUMN work_from_home_days.employee_id IS 'Who works from home.';
COMMENT ON COLUMN work_from_home_days.work_date IS 'The day.';
COMMENT ON COLUMN work_from_home_days.declared_at IS 'When they switched.';

COMMIT;
