-- 020: For the website's update of Oct 9 (bef6a17), the last parts that were kept only in the browser:
--   * company_policies, policy_acknowledgements: Company policies (Maintenance > Rules) HR publishes,
--     their versions, and who confirmed reading which version and when. Attached documents go in
--     files (encrypted, like every other upload).
--   * outbox_messages: the email and text messages the system queues (Administration > Outbox).
--     Addresses, subjects and text are encrypted. Nothing sends them yet.
--   * punches.location: where a clock-in from home was made (the phone's GPS), encrypted.
-- Team notices ("working from home today") need no table: they come from work_from_home_days and the
-- clock-ins from home already on the database.
-- New tables and columns only; nothing is changed or removed. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/020_policies_outbox_wfh_location.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('020_policies_outbox_wfh_location');

-- ---- Where a clock-in from home was made ----

ALTER TABLE punches ADD COLUMN location text;

-- ---- Company policies and the outbox ----

-- Company rules and policies HR publishes (Maintenance > Rules) for employees to read and acknowledge. Changing a published policy's title, text or document makes a new version that everyone acknowledges again.
CREATE TABLE company_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text NOT NULL CHECK (category IN ('Employee handbook', 'Code of conduct', 'Attendance & time', 'Leave', 'Pay & benefits', 'Data privacy', 'Health & safety', 'Other')),
  version integer NOT NULL DEFAULT 1,
  effective_date date NOT NULL,
  summary text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  file_id uuid,
  require_ack boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  updated_by uuid,
  updated_by_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Who confirmed reading which version of a company policy, and when.
CREATE TABLE policy_acknowledgements (
  policy_id uuid NOT NULL,
  version integer NOT NULL,
  employee_id varchar(20) NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, version, employee_id)
);

-- Email and text messages the system queues for people (Administration > Outbox), respecting their notification settings. Nothing sends them yet.
CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar(20) NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient_name text NOT NULL,
  address text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  event text NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sent', 'failed', 'cancelled')),
  queued_by uuid,
  queued_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- ---- Rules, keys and indexes (same as schema.sql) ----

ALTER TABLE company_policies ADD CHECK (version >= 1);
CREATE UNIQUE INDEX company_policies_title_ci ON company_policies (lower(title)) WHERE status <> 'archived';

ALTER TABLE company_policies ADD CONSTRAINT company_policies_file_id_fkey FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE SET NULL;
ALTER TABLE company_policies ADD CONSTRAINT company_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE policy_acknowledgements ADD CONSTRAINT policy_acknowledgements_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES company_policies (id) ON DELETE RESTRICT;
ALTER TABLE policy_acknowledgements ADD CONSTRAINT policy_acknowledgements_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_messages_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (employee_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_messages_queued_by_fkey FOREIGN KEY (queued_by) REFERENCES user_accounts (id) ON DELETE SET NULL;

CREATE INDEX ON company_policies (file_id);
CREATE INDEX ON company_policies (updated_by);
CREATE INDEX ON outbox_messages (employee_id);
CREATE INDEX ON outbox_messages (queued_by);
CREATE INDEX ON policy_acknowledgements (employee_id);

-- The app's database login (heyhr_app, made by server/setup-db.ps1) can use the new tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON company_policies, policy_acknowledgements, outbox_messages TO heyhr_app;

-- ---- Descriptions (same as the data dictionary) ----

COMMENT ON COLUMN punches.location IS 'Where a clock-in from home was made (the phone''s GPS: latitude, longitude, accuracy in metres) or why it couldn''t be had, as JSON encrypted by the app (AES-256-GCM). Only HR, the person''s approver and the person may read it.';
COMMENT ON TABLE company_policies IS 'Company rules and policies HR publishes (Maintenance > Rules) for employees to read and acknowledge. Changing a published policy''s title, text or document makes a new version that everyone acknowledges again.';
COMMENT ON COLUMN company_policies.id IS 'Primary key.';
COMMENT ON COLUMN company_policies.title IS 'e.g. Code of conduct. Unique among policies that aren''t archived.';
COMMENT ON COLUMN company_policies.category IS 'Kind of policy.';
COMMENT ON COLUMN company_policies.version IS 'Starts at 1; goes up when a published policy''s title, text or document changes.';
COMMENT ON COLUMN company_policies.effective_date IS 'When it takes effect.';
COMMENT ON COLUMN company_policies.summary IS 'Short summary shown in the list.';
COMMENT ON COLUMN company_policies.body IS 'The policy text.';
COMMENT ON COLUMN company_policies.file_id IS 'Attached document (e.g. the signed PDF); the file and its name are encrypted in files.';
COMMENT ON COLUMN company_policies.require_ack IS 'Employees must confirm they''ve read it.';
COMMENT ON COLUMN company_policies.status IS 'Draft (only HR sees it), published, or archived.';
COMMENT ON COLUMN company_policies.updated_by IS 'Who last changed it.';
COMMENT ON COLUMN company_policies.updated_by_name IS 'Name of who last changed it, kept if the account goes.';
COMMENT ON COLUMN company_policies.updated_at IS 'Last change.';
COMMENT ON COLUMN company_policies.created_at IS 'When the row was created.';
COMMENT ON TABLE policy_acknowledgements IS 'Who confirmed reading which version of a company policy, and when.';
COMMENT ON COLUMN policy_acknowledgements.policy_id IS 'The policy.';
COMMENT ON COLUMN policy_acknowledgements.version IS 'The version they read.';
COMMENT ON COLUMN policy_acknowledgements.employee_id IS 'Who confirmed it.';
COMMENT ON COLUMN policy_acknowledgements.acknowledged_at IS 'When they confirmed it.';
COMMENT ON TABLE outbox_messages IS 'Email and text messages the system queues for people (Administration > Outbox), respecting their notification settings. Nothing sends them yet.';
COMMENT ON COLUMN outbox_messages.id IS 'Primary key.';
COMMENT ON COLUMN outbox_messages.employee_id IS 'Who it goes to.';
COMMENT ON COLUMN outbox_messages.channel IS 'Email or text message.';
COMMENT ON COLUMN outbox_messages.recipient_name IS 'Name of who it goes to, as shown in the outbox.';
COMMENT ON COLUMN outbox_messages.address IS 'Email address or mobile number it goes to, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN outbox_messages.subject IS 'Subject line, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN outbox_messages.body IS 'Message text, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN outbox_messages.event IS 'What it''s about, e.g. leaveSubmitted, payslip, policy, wfh.';
COMMENT ON COLUMN outbox_messages.status IS 'Waiting to go out, sent, failed, or cleared from the outbox by an administrator.';
COMMENT ON COLUMN outbox_messages.queued_by IS 'Account whose action queued it.';
COMMENT ON COLUMN outbox_messages.queued_by_name IS 'Name of who queued it, kept if the account goes.';
COMMENT ON COLUMN outbox_messages.created_at IS 'When the row was created.';
COMMENT ON COLUMN outbox_messages.sent_at IS 'When it went out; empty until a sender is connected.';

COMMIT;
