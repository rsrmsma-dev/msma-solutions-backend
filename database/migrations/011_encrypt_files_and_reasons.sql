-- 011: Uploaded files (ID scans, clearances, medical results, receipts), leave reasons, and case and
-- separation reasons are now encrypted by the app (server/src/crypto.ts). The columns don't change
-- type, so only their descriptions change here; what's already saved is encrypted by the one-time
-- script: npm --prefix server run encrypt-ids
-- Can only run once (schema_migrations). Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/011_encrypt_files_and_reasons.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('011_encrypt_files_and_reasons');

COMMENT ON COLUMN files.content IS 'The file itself, encrypted by the app (AES-256-GCM), while files are kept in the database (null once moved to object storage).';
COMMENT ON COLUMN employee_cases.summary IS 'What happened and what was done, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN offboarding_cases.reason IS 'Stated reason, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN leave_requests.reason IS 'Reason, encrypted by the app (AES-256-GCM): it can describe an illness.';

COMMIT;
