-- 016: Registering now creates the sign-in directly (HR then gives the temporary password), so the
-- review step and its table go: registration_requests and its REG-00001 numbering are dropped.
-- Who registered stays in the audit trail ("Registered"). Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/016_registration_creates_sign_in.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('016_registration_creates_sign_in');

DROP TABLE registration_requests;
DROP SEQUENCE registration_no_seq;

COMMIT;
