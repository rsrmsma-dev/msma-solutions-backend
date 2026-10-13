-- 022: Add user accepts a one-word name ("Rovic"): it's the first name, and the last name stays blank
-- until it's filled in with the other details (see 021). Names may still only hold letters, spaces,
-- dots, apostrophes and dashes; only last_name may now be empty. No data changes.
-- Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/022_last_name_later.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('022_last_name_later');

ALTER TABLE employees DROP CONSTRAINT employees_names_letters;
ALTER TABLE employees ADD CONSTRAINT employees_names_letters CHECK (last_name ~ $re$^[[:alpha:] .'-]*$$re$ AND first_name ~ $re$^[[:alpha:] .'-]+$$re$ AND (middle_name IS NULL OR middle_name ~ $re$^[[:alpha:] .'-]+$$re$));

COMMIT;
