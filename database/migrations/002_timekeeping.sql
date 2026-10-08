-- 002: Timekeeping on the database.
-- Shifts get short text ids (sh-day, sh-mid…); punches, requests, remote days and notices keep who did it by name.
-- The timekeeping tables were never used, so the two shift tables are rebuilt and the rest gain columns.
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/002_timekeeping.sql

BEGIN;

-- Safety: only while no timekeeping records exist and no one has a usual shift set.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM shift_templates) OR EXISTS (SELECT 1 FROM schedule_overrides) OR EXISTS (SELECT 1 FROM punches) OR EXISTS (SELECT 1 FROM time_requests) OR EXISTS (SELECT 1 FROM punch_fix_requests) OR EXISTS (SELECT 1 FROM remote_work_days) OR EXISTS (SELECT 1 FROM remote_work_day_branches) OR EXISTS (SELECT 1 FROM attendance_notices) OR EXISTS (SELECT 1 FROM employees WHERE default_shift_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Timekeeping tables already hold records; this migration would delete some. Stopped, nothing changed.';
  END IF;
END $$;

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_default_shift_id_fkey;
DROP TABLE schedule_overrides, shift_templates CASCADE;
ALTER TABLE employees ALTER COLUMN default_shift_id TYPE varchar(20) USING NULL;

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

ALTER TABLE schedule_overrides ADD CONSTRAINT schedule_overrides_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE schedule_overrides ADD CONSTRAINT schedule_overrides_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES shift_templates (id) ON DELETE SET NULL;
ALTER TABLE schedule_overrides ADD CONSTRAINT schedule_overrides_set_by_fkey FOREIGN KEY (set_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE employees ADD CONSTRAINT employees_default_shift_id_fkey FOREIGN KEY (default_shift_id) REFERENCES shift_templates (id) ON DELETE SET NULL;
CREATE INDEX ON schedule_overrides (set_by);
CREATE INDEX ON schedule_overrides (shift_id);

ALTER TABLE punches ADD COLUMN device_label text;
ALTER TABLE punches ADD COLUMN device_branch text;
ALTER TABLE punches ADD COLUMN recorded_by_name text;
ALTER TABLE punches ADD COLUMN voided_by_name text;
ALTER TABLE punches ADD COLUMN confirmed_by_name text;
ALTER TABLE time_requests ADD COLUMN filed_by_name text NOT NULL;
ALTER TABLE punch_fix_requests ADD COLUMN filed_by_name text NOT NULL;
ALTER TABLE remote_work_days ADD COLUMN declared_by_name text NOT NULL;
ALTER TABLE attendance_notices ADD COLUMN sent_by_name text NOT NULL;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heyhr_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON shift_templates, schedule_overrides TO heyhr_app;
END IF; END $$;

INSERT INTO schema_migrations (version) VALUES ('002_timekeeping');

COMMIT;
