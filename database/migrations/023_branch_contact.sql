-- 023: Maintenance > Locations asks for each office's contact person and their phone, and lets HR
-- assign the branch manager.
--   * org_units.contact_name, contact_phone: who to call at the office (branches only).
--   * The branch manager uses the existing org_units.head_employee_id (only its description changes).
-- New columns only; nothing is changed or removed. Existing offices get their contact when next edited.
-- Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/023_branch_contact.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('023_branch_contact');

ALTER TABLE org_units
  ADD COLUMN contact_name text,
  ADD COLUMN contact_phone text;

COMMENT ON COLUMN org_units.head_employee_id IS 'Head of the unit (department head, partner; a branch''s manager).';
COMMENT ON COLUMN org_units.contact_name IS 'Contact person at the office; branches only.';
COMMENT ON COLUMN org_units.contact_phone IS 'Contact person''s phone (PH mobile or landline); branches only.';

COMMIT;
