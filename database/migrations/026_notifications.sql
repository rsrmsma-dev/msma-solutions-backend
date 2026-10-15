-- 026: Bell notifications on the database (the bell in the top bar). The server creates them with the
-- request, decision or change that causes them, so the person who has to act, or who is affected,
-- sees them on any device.
--   * notifications: one row per person told (their sign-in), with what it's about, the title and
--     detail (encrypted: they can name people and amounts), the page it opens for their role, who
--     caused it, and when it was read.
-- New table only; nothing is changed or removed. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/026_notifications.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('026_notifications');

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  topic text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('request', 'approved', 'rejected', 'update', 'seat', 'alert')),
  title text NOT NULL,
  body text NOT NULL,
  link text,
  by_account uuid,
  by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

ALTER TABLE notifications ADD CONSTRAINT notifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES user_accounts (id) ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_by_account_fkey FOREIGN KEY (by_account) REFERENCES user_accounts (id) ON DELETE SET NULL;
CREATE INDEX ON notifications (account_id);
CREATE INDEX ON notifications (by_account);
CREATE INDEX ON notifications (account_id, created_at DESC);

-- The app's database login (heyhr_app, made by server/setup-db.ps1) can read and write them.
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO heyhr_app;

COMMENT ON TABLE notifications IS 'Bell notifications: one row per person told about a request, a decision or a change (the bell in the top bar). Created by the server with the change that causes them.';
COMMENT ON COLUMN notifications.id IS 'Primary key.';
COMMENT ON COLUMN notifications.account_id IS 'Who it''s for (the sign-in that sees it in their bell).';
COMMENT ON COLUMN notifications.topic IS 'What it''s about, e.g. leave, claim, certificate, subscription (src/lib/noticeLinks.ts).';
COMMENT ON COLUMN notifications.kind IS 'Which icon the bell shows.';
COMMENT ON COLUMN notifications.title IS 'Headline, encrypted by the app (AES-256-GCM): it can name people and amounts.';
COMMENT ON COLUMN notifications.body IS 'Detail, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN notifications.link IS 'The page it opens for this person''s role; empty = nowhere.';
COMMENT ON COLUMN notifications.by_account IS 'Account whose action caused it; empty for automatic alerts.';
COMMENT ON COLUMN notifications.by_name IS 'Name of who caused it, kept if the account goes.';
COMMENT ON COLUMN notifications.created_at IS 'When the row was created.';
COMMENT ON COLUMN notifications.read_at IS 'When the person read it; empty = unread.';

COMMIT;
