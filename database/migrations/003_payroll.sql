-- 003: Payroll on the database.
-- Payroll runs and contribution rate versions keep who started, approved or saved them by name.
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/003_payroll.sql

BEGIN;

-- Safety: only while no payroll data exists (the new columns are required).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM contribution_rate_versions) OR EXISTS (SELECT 1 FROM payroll_runs) OR EXISTS (SELECT 1 FROM payroll_run_lines) OR EXISTS (SELECT 1 FROM payroll_adjustments) THEN
    RAISE EXCEPTION 'Payroll tables already hold records. Stopped, nothing changed.';
  END IF;
END $$;

ALTER TABLE contribution_rate_versions ADD COLUMN saved_by_name text NOT NULL;
ALTER TABLE payroll_runs ADD COLUMN created_by_name text NOT NULL;
ALTER TABLE payroll_runs ADD COLUMN approved_by_name text;

INSERT INTO schema_migrations (version) VALUES ('003_payroll');

COMMIT;
