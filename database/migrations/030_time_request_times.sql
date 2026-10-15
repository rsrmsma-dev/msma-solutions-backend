-- 030: overtime and undertime requests keep their start and end times (Attendance › Request overtime /
-- Request undertime: "Start" and "End" instead of "Minutes to claim"), so approvers and HR see
-- "5:30 PM – 8:00 PM", not just a number of minutes.
--   * time_requests.start_at, end_at: when it starts and ends; minutes stays as end − start.
-- New columns only; nothing is changed or removed. Requests filed before this keep empty times.
-- Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/030_time_request_times.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('030_time_request_times');

ALTER TABLE time_requests
  ADD COLUMN start_at timestamptz,
  ADD COLUMN end_at timestamptz;

ALTER TABLE time_requests ADD CONSTRAINT time_requests_times CHECK ((start_at IS NULL AND end_at IS NULL) OR (start_at IS NOT NULL AND end_at > start_at));

COMMENT ON COLUMN time_requests.start_at IS 'When the overtime or undertime starts; minutes = end_at - start_at. Empty for requests filed before 030.';
COMMENT ON COLUMN time_requests.end_at IS 'When it ends (can be the next day).';

COMMIT;
