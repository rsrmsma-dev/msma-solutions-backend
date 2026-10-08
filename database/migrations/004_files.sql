-- 004: Reimbursements. Receipt photos are kept in the database (files.content) until object storage is set up.
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/004_files.sql

BEGIN;

ALTER TABLE files ADD COLUMN content bytea;

INSERT INTO schema_migrations (version) VALUES ('004_files');

COMMIT;
