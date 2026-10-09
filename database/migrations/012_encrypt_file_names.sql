-- 012: File names are encrypted by the app too (a name like "medical-result.pdf" can give something away):
-- files.file_name, employee_documents.file_name and leave_requests.attachment_name. Only descriptions
-- change here; saved names are encrypted by the one-time script: npm --prefix server run encrypt-ids
-- Can only run once (schema_migrations). Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/012_encrypt_file_names.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('012_encrypt_file_names');

COMMENT ON COLUMN files.file_name IS 'Original file name, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN employee_documents.file_name IS 'Name of the submitted file, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN leave_requests.attachment_name IS 'Name of the attached file, encrypted by the app (AES-256-GCM).';

COMMIT;
