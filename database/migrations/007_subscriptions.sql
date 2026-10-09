-- 007: Subscriptions, for running the HRIS as a service (SaaS): the company's plan, seat limit and
-- billing period (Administration > Subscription & seats). New table only; nothing else changes.
-- Can only run once (schema_migrations). Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/007_subscriptions.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('007_subscriptions');

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'past_due', 'cancelled', 'expired')),
  seat_limit integer,
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
  price_per_seat numeric(10,2),
  currency text NOT NULL DEFAULT 'PHP',
  starts_on date NOT NULL DEFAULT current_date,
  current_period_end date,
  trial_ends_on date,
  cancelled_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE subscriptions ADD CHECK (seat_limit IS NULL OR seat_limit > 0);
ALTER TABLE subscriptions ADD CHECK (price_per_seat IS NULL OR price_per_seat >= 0);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
CREATE INDEX ON subscriptions (created_by);
CREATE INDEX ON subscriptions (updated_by);

-- The app's database login (heyhr_app, made by server/setup-db.ps1) can read and write it.
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions TO heyhr_app;

COMMENT ON TABLE subscriptions IS 'The company''s HRIS plan (SaaS): plan, seat limit and billing period. One row per period; the newest one not cancelled or expired is current.';
COMMENT ON COLUMN subscriptions.id IS 'Primary key.';
COMMENT ON COLUMN subscriptions.plan_name IS 'Plan the company is on, e.g. Starter, Business.';
COMMENT ON COLUMN subscriptions.status IS 'Trial, active, past due (payment late), cancelled or expired.';
COMMENT ON COLUMN subscriptions.seat_limit IS 'Most sign-in accounts the plan covers (System Admin accounts don''t count); empty = no limit.';
COMMENT ON COLUMN subscriptions.billing_cycle IS 'How often it''s billed.';
COMMENT ON COLUMN subscriptions.price_per_seat IS 'Price per seat per billing cycle.';
COMMENT ON COLUMN subscriptions.currency IS 'Currency of the price.';
COMMENT ON COLUMN subscriptions.starts_on IS 'First day of this subscription.';
COMMENT ON COLUMN subscriptions.current_period_end IS 'When the current billing period ends (renewal date).';
COMMENT ON COLUMN subscriptions.trial_ends_on IS 'Last day of the trial, while on trial.';
COMMENT ON COLUMN subscriptions.cancelled_at IS 'When it was cancelled.';
COMMENT ON COLUMN subscriptions.notes IS 'Notes from our team, e.g. the contract or invoice reference.';
COMMENT ON COLUMN subscriptions.created_at IS 'When the row was created.';
COMMENT ON COLUMN subscriptions.created_by IS 'Account that set it up.';
COMMENT ON COLUMN subscriptions.updated_at IS 'Last change.';
COMMENT ON COLUMN subscriptions.updated_by IS 'Account that made the last change.';

COMMIT;
