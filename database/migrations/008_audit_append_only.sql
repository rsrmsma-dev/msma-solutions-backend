-- 008: The audit trail is append-only for the app. Its database login (heyhr_app) can add entries and
-- read them, but can no longer change or delete them, so someone who takes over the app can't erase
-- what they did. Permissions only; no data changes. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/008_audit_append_only.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('008_audit_append_only');

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM heyhr_app;

COMMIT;
