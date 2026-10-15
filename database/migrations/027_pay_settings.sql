-- 027: payroll settings that only lived in each browser now go to the database, so every computer
-- works out the same pay.
--   * company_settings.payday_first, payday_second: the two paydays each cut-off closes on
--     (Payroll > Pay details > Paydays; 10 and 25 unless changed, 31 = month end).
--   * employee_pay_profiles: each employee's pay settings (work week, transport allowance, OT meal
--     rate, de minimis, other non-taxable pay). No row = 5-day week, no allowances.
--   * shift_templates.saturday_end: the shorter Saturday on a six-day-week shift.
-- New table and columns only; nothing is changed or removed. Existing rows get the defaults.
-- Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/027_pay_settings.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('027_pay_settings');

-- ---- Paydays ----

ALTER TABLE company_settings
  ADD COLUMN payday_first smallint NOT NULL DEFAULT 10,
  ADD COLUMN payday_second smallint NOT NULL DEFAULT 25;

ALTER TABLE company_settings ADD CONSTRAINT company_settings_paydays CHECK (payday_first BETWEEN 1 AND 31 AND payday_second BETWEEN 1 AND 31 AND payday_second - payday_first >= 7);

COMMENT ON COLUMN company_settings.payday_first IS 'First payday of the month: the first cut-off closes and is paid on this day (Payroll > Pay details > Paydays).';
COMMENT ON COLUMN company_settings.payday_second IS 'Second payday of the month, at least a week after the first; 31 means the last day of the month.';

-- ---- Six-day week: Saturday's end ----

ALTER TABLE shift_templates ADD COLUMN saturday_end time;

COMMENT ON COLUMN shift_templates.saturday_end IS 'When Saturday ends on a six-day week (a shorter day, no break); empty = Saturday ends at end_time.';

-- ---- Each employee's pay settings ----

CREATE TABLE employee_pay_profiles (
  employee_id varchar(20) PRIMARY KEY,
  work_week text NOT NULL DEFAULT '5-day' CHECK (work_week IN ('5-day', '6-day')),
  transport_allowance numeric(12,2) NOT NULL DEFAULT 0,
  ot_meal_rate numeric(10,2) NOT NULL DEFAULT 0,
  de_minimis numeric(12,2) NOT NULL DEFAULT 0,
  other_non_taxable numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_by_name text
);

ALTER TABLE employee_pay_profiles ADD CONSTRAINT employee_pay_profiles_amounts CHECK (transport_allowance >= 0 AND ot_meal_rate >= 0 AND de_minimis >= 0 AND other_non_taxable >= 0);
ALTER TABLE employee_pay_profiles ADD CONSTRAINT employee_pay_profiles_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE employee_pay_profiles ADD CONSTRAINT employee_pay_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
CREATE INDEX ON employee_pay_profiles (updated_by);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_pay_profiles TO heyhr_app;

COMMENT ON TABLE employee_pay_profiles IS 'Each employee''s pay settings (Payroll > Pay details): work week, allowances and tax-free pay the payroll engine uses. No row = 5-day week and no allowances.';
COMMENT ON COLUMN employee_pay_profiles.employee_id IS 'Whose pay settings.';
COMMENT ON COLUMN employee_pay_profiles.work_week IS '5-day: Monday to Friday, 8 hours. 6-day: Monday to Friday 7 hours, Saturday 5.';
COMMENT ON COLUMN employee_pay_profiles.transport_allowance IS 'Transport allowance for a full cut-off, PHP; prorated by days attended, not taxed.';
COMMENT ON COLUMN employee_pay_profiles.ot_meal_rate IS 'Paid for each day with approved overtime, PHP.';
COMMENT ON COLUMN employee_pay_profiles.de_minimis IS 'De minimis benefits inside the basic pay each cut-off, PHP; not taxed.';
COMMENT ON COLUMN employee_pay_profiles.other_non_taxable IS 'Other non-taxable pay inside the basic pay each cut-off, PHP.';
COMMENT ON COLUMN employee_pay_profiles.updated_at IS 'Last change.';
COMMENT ON COLUMN employee_pay_profiles.updated_by IS 'Account that made the last change.';
COMMENT ON COLUMN employee_pay_profiles.updated_by_name IS 'Name of who made the last change, kept if the account goes.';

COMMIT;
