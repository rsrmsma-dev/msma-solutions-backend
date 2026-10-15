-- 025: Subscription & seat limits on the database (Settings > Subscription; Administration > Clients &
-- Subscriptions). Seats are employee records that aren't Separated, admin accounts are active HR /
-- Approver / Accounting logins; both are counted by the server, never stored.
--   * subscription_plans: the plans our team offers (seats, admin accounts, grace), with the three
--     the website shows: Starter, Growth, Business. Nobody is put on a plan here.
--   * subscriptions: the plan in force (plan_id), our team's seat override, a temporary extension,
--     and which seat alerts were already sent (once per crossing).
--   * subscription_events: seat alerts, refused adds, upgrade requests and plan changes.
-- Until a System Admin chooses a plan for the company, nothing is limited.
-- New tables and columns only; nothing is changed or removed. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/025_subscription_seats.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('025_subscription_seats');

CREATE TABLE subscription_plans (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  employee_seat_limit integer NOT NULL,
  admin_account_limit integer NOT NULL,
  grace_percent smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscriptions
  ADD COLUMN plan_id text,
  ADD COLUMN seat_limit_override integer,
  ADD COLUMN extension_seats integer,
  ADD COLUMN extension_until date,
  ADD COLUMN last_seat_level smallint NOT NULL DEFAULT 0 CHECK (last_seat_level IN (0, 80, 90, 100)),
  ADD COLUMN last_seat_alert smallint CHECK (last_seat_alert IN (0, 80, 90, 100));

CREATE TABLE subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('threshold', 'blocked', 'upgrade-request', 'plan-changed', 'seat-override', 'extension')),
  message text NOT NULL,
  by_account uuid,
  by_name text,
  seats text NOT NULL,
  admins text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscriptions ADD CHECK (seat_limit_override IS NULL OR seat_limit_override > 0);
ALTER TABLE subscriptions ADD CHECK ((extension_seats IS NULL) = (extension_until IS NULL) AND (extension_seats IS NULL OR extension_seats > 0));
ALTER TABLE subscription_plans ADD CHECK (employee_seat_limit > 0 AND admin_account_limit >= 0 AND grace_percent BETWEEN 0 AND 100);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES subscription_plans (id) ON DELETE SET NULL;
ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_by_account_fkey FOREIGN KEY (by_account) REFERENCES user_accounts (id) ON DELETE SET NULL;
CREATE INDEX ON subscriptions (plan_id);
CREATE INDEX ON subscription_events (by_account);

-- The plans the website offers (src/lib/subscription/store.ts). Choosing one is up to our System Admins.
INSERT INTO subscription_plans (id, name, employee_seat_limit, admin_account_limit, grace_percent, sort_order) VALUES
  ('plan-starter', 'Starter', 20, 8, 5, 1),
  ('plan-growth', 'Growth', 50, 15, 5, 2),
  ('plan-business', 'Business', 150, 30, 5, 3);

-- The app's database login (heyhr_app, made by server/setup-db.ps1) can read and write them.
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_plans, subscription_events TO heyhr_app;

COMMENT ON TABLE subscription_plans IS 'The plans a client can be on (Administration > Clients & Subscriptions): employee seats, admin accounts and grace. Set up by our team.';
COMMENT ON COLUMN subscription_plans.id IS 'Plan id, e.g. plan-starter.';
COMMENT ON COLUMN subscription_plans.name IS 'Plan name, e.g. Starter.';
COMMENT ON COLUMN subscription_plans.employee_seat_limit IS 'Employees the plan covers: records that aren''t Separated.';
COMMENT ON COLUMN subscription_plans.admin_account_limit IS 'Active HR, Approver and Accounting logins the plan covers.';
COMMENT ON COLUMN subscription_plans.grace_percent IS 'How far past either limit adds are still allowed, in percent, rounded down to whole seats.';
COMMENT ON COLUMN subscription_plans.is_active IS 'Offered when choosing a plan.';
COMMENT ON COLUMN subscription_plans.sort_order IS 'Order in the plan list.';
COMMENT ON COLUMN subscription_plans.created_at IS 'When the row was created.';
COMMENT ON COLUMN subscriptions.plan_id IS 'The plan in force (its seat, admin-account and grace limits); empty = no plan set, so nothing is limited.';
COMMENT ON COLUMN subscriptions.seat_limit_override IS 'Employee seat limit our team set for this client in place of the plan''s; empty = the plan''s.';
COMMENT ON COLUMN subscriptions.extension_seats IS 'Temporary extra employee seats, until extension_until.';
COMMENT ON COLUMN subscriptions.extension_until IS 'Last day the temporary extra seats apply.';
COMMENT ON COLUMN subscriptions.last_seat_level IS 'Highest seat threshold (percent of the limit) already logged and told to System Admins; falls back when usage drops, so each crossing is told once.';
COMMENT ON COLUMN subscriptions.last_seat_alert IS 'Highest seat threshold Super Admins and HR were already told about; empty = none yet.';
COMMENT ON TABLE subscription_events IS 'Log of seat alerts, refused adds, upgrade requests and plan changes (Administration > Clients & Subscriptions).';
COMMENT ON COLUMN subscription_events.id IS 'Primary key.';
COMMENT ON COLUMN subscription_events.kind IS 'What happened.';
COMMENT ON COLUMN subscription_events.message IS 'What happened, in words (an upgrade request includes its note).';
COMMENT ON COLUMN subscription_events.by_account IS 'Account that did it; empty for automatic alerts and refusals.';
COMMENT ON COLUMN subscription_events.by_name IS 'Name of who did it, kept if the account goes.';
COMMENT ON COLUMN subscription_events.seats IS 'Employee seats used / limit at that moment, e.g. 17 / 20.';
COMMENT ON COLUMN subscription_events.admins IS 'Admin accounts used / limit at that moment, e.g. 6 / 8.';
COMMENT ON COLUMN subscription_events.occurred_at IS 'When.';

COMMIT;
