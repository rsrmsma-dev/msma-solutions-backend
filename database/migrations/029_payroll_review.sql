-- 029: "Reviewed by" on a payroll run, as on the workbook's Summary sheet (Prepared by / Reviewed by /
-- Approved by). Whoever reviews a draft run is recorded with the time.
-- New columns only; nothing is changed or removed. Needs 028 first.
-- Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/029_payroll_review.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('029_payroll_review');

ALTER TABLE payroll_runs
  ADD COLUMN reviewed_by uuid,
  ADD COLUMN reviewed_by_name text,
  ADD COLUMN reviewed_at timestamptz;

ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
CREATE INDEX ON payroll_runs (reviewed_by);

COMMENT ON COLUMN payroll_runs.reviewed_by IS 'Account that reviewed the run (Summary sheet "Reviewed by").';
COMMENT ON COLUMN payroll_runs.reviewed_by_name IS 'Name of who reviewed it, kept if the account goes.';
COMMENT ON COLUMN payroll_runs.reviewed_at IS 'When it was reviewed.';

COMMIT;
