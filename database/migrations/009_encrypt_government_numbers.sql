-- 009: Employees' government numbers (SSS, PhilHealth, Pag-IBIG, TIN) are stored encrypted by the app
-- (server/src/crypto.ts). The columns widen to hold the encrypted text, and the "no two employees
-- share a number" rule moves to a fingerprint column beside each one.
-- Numbers already saved stay readable (the app reads plain values too) until the one-time script
-- encrypts them: npm --prefix server run encrypt-ids
-- Can only run once (schema_migrations). Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/009_encrypt_government_numbers.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('009_encrypt_government_numbers');

ALTER TABLE employees DROP CONSTRAINT employees_tin_key;
ALTER TABLE employees DROP CONSTRAINT employees_sss_no_key;
ALTER TABLE employees DROP CONSTRAINT employees_philhealth_no_key;
ALTER TABLE employees DROP CONSTRAINT employees_pagibig_no_key;
ALTER TABLE employees
  ALTER COLUMN tin TYPE text,
  ALTER COLUMN sss_no TYPE text,
  ALTER COLUMN philhealth_no TYPE text,
  ALTER COLUMN pagibig_no TYPE text,
  ADD COLUMN tin_hash text,
  ADD COLUMN sss_no_hash text,
  ADD COLUMN philhealth_no_hash text,
  ADD COLUMN pagibig_no_hash text;
ALTER TABLE employees ADD CONSTRAINT employees_tin_hash_key UNIQUE (tin_hash);
ALTER TABLE employees ADD CONSTRAINT employees_sss_no_hash_key UNIQUE (sss_no_hash);
ALTER TABLE employees ADD CONSTRAINT employees_philhealth_no_hash_key UNIQUE (philhealth_no_hash);
ALTER TABLE employees ADD CONSTRAINT employees_pagibig_no_hash_key UNIQUE (pagibig_no_hash);

COMMENT ON COLUMN employees.tin IS 'BRD. Tax Identification Number, encrypted by the app (AES-256-GCM). Required before first payroll.';
COMMENT ON COLUMN employees.sss_no IS 'BRD. SSS number, encrypted by the app (AES-256-GCM). Required before first payroll.';
COMMENT ON COLUMN employees.philhealth_no IS 'BRD. PhilHealth number, encrypted by the app (AES-256-GCM). Required before first payroll.';
COMMENT ON COLUMN employees.pagibig_no IS 'BRD. Pag-IBIG MID number, encrypted by the app (AES-256-GCM). Required before first payroll.';
COMMENT ON COLUMN employees.tin_hash IS 'Fingerprint of the TIN (HMAC-SHA256), so no two employees share one.';
COMMENT ON COLUMN employees.sss_no_hash IS 'Fingerprint of the SSS number (HMAC-SHA256), so no two employees share one.';
COMMENT ON COLUMN employees.philhealth_no_hash IS 'Fingerprint of the PhilHealth number (HMAC-SHA256), so no two employees share one.';
COMMENT ON COLUMN employees.pagibig_no_hash IS 'Fingerprint of the Pag-IBIG MID (HMAC-SHA256), so no two employees share one.';

COMMIT;
