-- 021: Add user (Administration > Users) also makes the person's employee record, so they show on
-- Maintenance > People right away. Add user only knows the name, so the details below stay blank
-- until HR (or the employee) fills them in on the profile:
--   * employees.birth_date, sex, civil_status, mobile_no, email, date_hired, basic_rate: may be blank.
--     Their UNIQUE and CHECK rules still apply to every value that is filled in.
-- Nothing is added or removed and no data changes; only the NOT NULL rules on these seven columns
-- are lifted. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/021_employee_details_later.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('021_employee_details_later');

ALTER TABLE employees
  ALTER COLUMN birth_date DROP NOT NULL,
  ALTER COLUMN sex DROP NOT NULL,
  ALTER COLUMN civil_status DROP NOT NULL,
  ALTER COLUMN mobile_no DROP NOT NULL,
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN date_hired DROP NOT NULL,
  ALTER COLUMN basic_rate DROP NOT NULL;

COMMENT ON COLUMN employees.birth_date IS 'BRD. Date of birth. Age must be 18 or older (checked by trigger). Blank until filled in for a record made by Add user.';
COMMENT ON COLUMN employees.sex IS 'BRD. Gender. From the allowed values only. Blank until filled in for a record made by Add user.';
COMMENT ON COLUMN employees.civil_status IS 'BRD. Marital status. From the allowed values only. Blank until filled in for a record made by Add user.';
COMMENT ON COLUMN employees.mobile_no IS 'BRD. Mobile number, 11 digits: 09XXXXXXXXX. Unique. Blank until filled in for a record made by Add user.';
COMMENT ON COLUMN employees.email IS 'BRD. Email address (work). Valid email format. Unique. Blank until filled in for a record made by Add user.';
COMMENT ON COLUMN employees.date_hired IS 'BRD. First day of employment. Not more than 30 days in the future (checked by trigger). Blank until filled in for a record made by Add user (leave earned by the month and service-based leave wait for it).';
COMMENT ON COLUMN employees.basic_rate IS 'BRD. Basic monthly salary in PHP; must be > 0. Restricted to HR and Payroll. Blank until filled in for a record made by Add user; payroll runs and final pay leave the person out until then.';

COMMIT;
