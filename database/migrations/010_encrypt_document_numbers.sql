-- 010: ID numbers on 201 documents (employee_documents.reference_no) and PRC license numbers
-- (professional_licenses.license_number) are now encrypted by the app, like the government numbers
-- in 009. The columns are already text, so only their descriptions change here; saved numbers are
-- encrypted by the one-time script: npm --prefix server run encrypt-ids
-- Can only run once (schema_migrations). Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/010_encrypt_document_numbers.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('010_encrypt_document_numbers');

COMMENT ON COLUMN employee_documents.reference_no IS 'ID or license number, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN professional_licenses.license_number IS 'PRC license number, encrypted by the app (AES-256-GCM).';

COMMIT;
