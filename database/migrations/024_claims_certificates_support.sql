-- 024: three things that only ran in the browser now go to the database.
--   * reimbursement_claims.release_method: Accounting releases approved claims straight to the employee
--     by cash, bank transfer, e-wallet or check. payout_method stays 'transfer' for every direct release
--     (its allowed values aren't changed); this column says which way.
--   * certificate_requests: who took the last step and how it was delivered (digital copy or signed copy
--     for pickup), a decline reason (encrypted; a declined request keeps status Pending and shows as
--     Declined), and the copy filed when HR issues it: number (COE-2026-0001), exact wording
--     (encrypted), purpose, who and when.
--   * support_tickets, support_ticket_messages: problems the client's Super Admin, HR and Accounting send
--     to our support team (Administration > Support), and the replies. Message text is encrypted.
-- New tables and columns only; nothing is changed or removed. Existing rows stay as they are.
-- Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/024_claims_certificates_support.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('024_claims_certificates_support');

-- ---- Claims released by Accounting ----

ALTER TABLE reimbursement_claims
  ADD COLUMN release_method text CHECK (release_method IN ('cash', 'transfer', 'e-wallet', 'check'));

COMMENT ON COLUMN reimbursement_claims.release_method IS 'How Accounting released it straight to the employee: cash, bank transfer, e-wallet or check (payout_method is then ''transfer''). Empty for claims paid with payroll or final pay, or released before this was recorded.';

-- ---- Certificate requests: issue, pickup, decline ----

ALTER TABLE certificate_requests
  ADD COLUMN delivery text CHECK (delivery IN ('digital', 'pickup')),
  ADD COLUMN handled_by uuid,
  ADD COLUMN handled_by_name text,
  ADD COLUMN handled_at timestamptz,
  ADD COLUMN decline_reason text,
  ADD COLUMN certificate_no text UNIQUE,
  ADD COLUMN issued_statement text,
  ADD COLUMN issued_purpose text,
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN issued_by uuid,
  ADD COLUMN issued_by_name text;

ALTER TABLE certificate_requests ADD CONSTRAINT certificate_requests_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE certificate_requests ADD CONSTRAINT certificate_requests_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
CREATE INDEX ON certificate_requests (handled_by);
CREATE INDEX ON certificate_requests (issued_by);

COMMENT ON COLUMN certificate_requests.delivery IS 'How it reached the employee: a digital copy to download, or a signed copy picked up from HR.';
COMMENT ON COLUMN certificate_requests.handled_by IS 'HR account that took the last step (issued, ready for pickup, released, declined).';
COMMENT ON COLUMN certificate_requests.handled_by_name IS 'Name of who took the last step, kept if the account goes.';
COMMENT ON COLUMN certificate_requests.handled_at IS 'When the last step was taken.';
COMMENT ON COLUMN certificate_requests.decline_reason IS 'Why HR declined it, shown to the employee; encrypted by the app (AES-256-GCM). When set the request is declined (shown as Declined; status stays Pending).';
COMMENT ON COLUMN certificate_requests.certificate_no IS 'Number of the issued certificate, e.g. COE-2026-0001 (per type and year).';
COMMENT ON COLUMN certificate_requests.issued_statement IS 'The certificate''s exact wording when issued, made from the employee''s record at that time (HR''s filed copy and the employee''s download); encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN certificate_requests.issued_purpose IS 'Purpose printed on the issued certificate.';
COMMENT ON COLUMN certificate_requests.issued_at IS 'When it was issued.';
COMMENT ON COLUMN certificate_requests.issued_by IS 'HR account that issued it.';
COMMENT ON COLUMN certificate_requests.issued_by_name IS 'Name of who issued it, kept if the account goes.';

-- ---- Support tickets ----

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no integer NOT NULL UNIQUE,
  subject text NOT NULL,
  category text NOT NULL CHECK (category IN ('Bug or error', 'How do I…', 'Account or sign-in', 'Payroll', 'Data fix', 'Billing', 'Feature request')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
  filed_by uuid,
  filed_by_name text NOT NULL,
  page text,
  assignee text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL,
  side text NOT NULL CHECK (side IN ('client', 'support')),
  author_id uuid,
  author_name text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_filed_by_fkey FOREIGN KEY (filed_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE support_ticket_messages ADD CONSTRAINT support_ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE RESTRICT;
ALTER TABLE support_ticket_messages ADD CONSTRAINT support_ticket_messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES user_accounts (id) ON DELETE SET NULL;
CREATE INDEX ON support_ticket_messages (author_id);
CREATE INDEX ON support_ticket_messages (ticket_id);
CREATE INDEX ON support_tickets (filed_by);

GRANT SELECT, INSERT, UPDATE, DELETE ON support_tickets, support_ticket_messages TO heyhr_app;

COMMENT ON TABLE support_tickets IS 'Problems and questions the client''s Super Admins, HR and Accounting send to our support team (Administration > Support). Our System Admins answer them and set status and priority.';
COMMENT ON COLUMN support_tickets.id IS 'Primary key.';
COMMENT ON COLUMN support_tickets.ticket_no IS 'Ticket number shown to people, from 1001 up.';
COMMENT ON COLUMN support_tickets.subject IS 'Short title.';
COMMENT ON COLUMN support_tickets.category IS 'What it''s about.';
COMMENT ON COLUMN support_tickets.priority IS 'How urgent it is.';
COMMENT ON COLUMN support_tickets.status IS 'Open, in progress, waiting for the client, resolved or closed.';
COMMENT ON COLUMN support_tickets.filed_by IS 'Account that filed it.';
COMMENT ON COLUMN support_tickets.filed_by_name IS 'Name of who filed it, kept if the account goes.';
COMMENT ON COLUMN support_tickets.page IS 'The page they were on, to help reproduce it.';
COMMENT ON COLUMN support_tickets.assignee IS 'Who on our support team is on it.';
COMMENT ON COLUMN support_tickets.created_at IS 'When the row was created.';
COMMENT ON COLUMN support_tickets.updated_at IS 'Last reply or change.';
COMMENT ON TABLE support_ticket_messages IS 'The conversation on a support ticket, oldest first.';
COMMENT ON COLUMN support_ticket_messages.id IS 'Primary key.';
COMMENT ON COLUMN support_ticket_messages.ticket_id IS 'The ticket.';
COMMENT ON COLUMN support_ticket_messages.side IS 'Who wrote it: the client''s people, or our support team.';
COMMENT ON COLUMN support_ticket_messages.author_id IS 'Account that wrote it.';
COMMENT ON COLUMN support_ticket_messages.author_name IS 'Name shown on the message (Support team for our replies).';
COMMENT ON COLUMN support_ticket_messages.body IS 'The message, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN support_ticket_messages.created_at IS 'When the row was created.';

COMMIT;
