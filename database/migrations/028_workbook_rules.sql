-- 028: the rest of MSMA's payroll workbook.
--   * employee_pay_profiles.client_share, client: the share of someone's salary charged to Sphinx or
--     a client (FT_MSMA "% Sphinx"); the journal books it to 14002 Advances - Sphinx.
--   * employee_pay_profiles.skip_sss, skip_philhealth, skip_pagibig: leave a contribution out of
--     someone's deductions, as a 0 typed in sheet C.
-- New columns only; nothing is changed or removed. Needs 027 first.
-- Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/028_workbook_rules.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('028_workbook_rules');

ALTER TABLE employee_pay_profiles
  ADD COLUMN client_share numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN client text NOT NULL DEFAULT '',
  ADD COLUMN skip_sss boolean NOT NULL DEFAULT false,
  ADD COLUMN skip_philhealth boolean NOT NULL DEFAULT false,
  ADD COLUMN skip_pagibig boolean NOT NULL DEFAULT false;

ALTER TABLE employee_pay_profiles ADD CONSTRAINT employee_pay_profiles_client_share CHECK (client_share >= 0 AND client_share <= 100);

COMMENT ON COLUMN employee_pay_profiles.client_share IS 'Percent of the salary charged to Sphinx or a client (FT_MSMA % Sphinx), 0-100; booked to 14002 Advances - Sphinx.';
COMMENT ON COLUMN employee_pay_profiles.client IS 'Who the share is charged to (FT_MSMA client column); empty when nothing is charged.';
COMMENT ON COLUMN employee_pay_profiles.skip_sss IS 'True: no SSS taken from this person (sheet C typed 0).';
COMMENT ON COLUMN employee_pay_profiles.skip_philhealth IS 'True: no PhilHealth taken from this person (sheet C typed 0).';
COMMENT ON COLUMN employee_pay_profiles.skip_pagibig IS 'True: no Pag-IBIG taken from this person (sheet C typed 0).';

COMMIT;
