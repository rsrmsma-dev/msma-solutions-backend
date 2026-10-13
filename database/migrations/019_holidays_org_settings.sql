-- 019: For the website's update of Oct 9 (bef6a17), the parts that were kept only in the browser:
--   * holiday_rules, holiday_rule_branches, holiday_changes: the Holiday calendar. Holidays HR adds
--     (proclaimed, local to some offices, every year or one year only, and company holidays from
--     Settings > Time off & leave), and one-year moves and cancellations from proclamations. The
--     national and movable holidays stay built into the app; the server now counts the same holidays
--     the website shows when it counts leave days.
--   * Leave policy (half days, negative balance, default carry-over, accrual) and scheduling rules
--     (overtime threshold, default break, publish lead days) as company_settings columns.
--   * user_preferences: each person's own settings (date format, timezone, notifications, density,
--     reduce motion, landing page), kept with their account. The theme stays on each device.
-- Departments and locations already have their table (org_units); they only needed endpoints.
-- New tables and columns only; nothing is changed or removed. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/019_holidays_org_settings.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('019_holidays_org_settings');

-- ---- Leave policy and scheduling rules (Settings > Time off & leave, Settings > Scheduling) ----

ALTER TABLE company_settings
  ADD COLUMN leave_half_days boolean NOT NULL DEFAULT true,
  ADD COLUMN leave_negative_balance boolean NOT NULL DEFAULT false,
  ADD COLUMN leave_default_carry_over smallint NOT NULL DEFAULT 0,
  ADD COLUMN leave_accrual text NOT NULL DEFAULT 'yearly' CHECK (leave_accrual IN ('yearly', 'monthly', 'per-payroll')),
  ADD COLUMN overtime_threshold_minutes smallint NOT NULL DEFAULT 0,
  ADD COLUMN default_break_minutes smallint NOT NULL DEFAULT 60,
  ADD COLUMN schedule_publish_lead_days smallint NOT NULL DEFAULT 7;

-- ---- Holiday calendar ----

-- Holidays HR added on the Holiday calendar, or as company holidays in Settings.
CREATE TABLE holiday_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  holiday_type text NOT NULL CHECK (holiday_type IN ('regular', 'special')),
  repeat_kind text NOT NULL CHECK (repeat_kind IN ('fixed', 'once')),
  repeat_month smallint,
  repeat_day smallint,
  once_date date,
  source text NOT NULL,
  created_by uuid,
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Offices a local holiday applies to. No rows means every office.
CREATE TABLE holiday_rule_branches (
  holiday_rule_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  PRIMARY KEY (holiday_rule_id, branch_id)
);

-- One-year changes from a proclamation: a holiday moved to another date, or cancelled, that year.
CREATE TABLE holiday_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builtin_rule_id text,
  holiday_rule_id uuid,
  year smallint NOT NULL,
  change_kind text NOT NULL CHECK (change_kind IN ('move', 'cancel')),
  new_date date,
  source text NOT NULL,
  changed_by uuid,
  changed_by_name text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Personal settings ----

CREATE TABLE user_preferences (
  account_id uuid PRIMARY KEY,
  display_name text,
  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en')),
  timezone text,
  date_format text NOT NULL DEFAULT 'MMM d, yyyy' CHECK (date_format IN ('MMM d, yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd')),
  week_start smallint NOT NULL DEFAULT 0 CHECK (week_start IN (0, 1, 6)),
  notifications_on boolean NOT NULL DEFAULT true,
  notification_matrix jsonb NOT NULL DEFAULT '{}',
  quiet_hours_on boolean NOT NULL DEFAULT false,
  quiet_from time NOT NULL DEFAULT '20:00',
  quiet_to time NOT NULL DEFAULT '07:00',
  digest text NOT NULL DEFAULT 'off' CHECK (digest IN ('off', 'daily', 'weekly')),
  density text NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact')),
  reduce_motion boolean NOT NULL DEFAULT false,
  landing_path text NOT NULL DEFAULT '',
  two_step_requested boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Rules, keys and indexes (same as schema.sql) ----

ALTER TABLE company_settings ADD CHECK (leave_default_carry_over BETWEEN 0 AND 365 AND overtime_threshold_minutes BETWEEN 0 AND 240 AND default_break_minutes BETWEEN 0 AND 120 AND schedule_publish_lead_days BETWEEN 0 AND 60);
ALTER TABLE holiday_rules ADD CHECK ((repeat_kind = 'fixed' AND repeat_month BETWEEN 1 AND 12 AND repeat_day BETWEEN 1 AND 31 AND once_date IS NULL) OR (repeat_kind = 'once' AND once_date IS NOT NULL AND repeat_month IS NULL AND repeat_day IS NULL));
ALTER TABLE holiday_changes ADD CHECK ((builtin_rule_id IS NULL) <> (holiday_rule_id IS NULL));
ALTER TABLE holiday_changes ADD CHECK ((change_kind = 'cancel' AND new_date IS NULL) OR (change_kind = 'move' AND new_date IS NOT NULL AND extract(year FROM new_date) = year));
ALTER TABLE holiday_changes ADD UNIQUE (builtin_rule_id, year);
ALTER TABLE holiday_changes ADD UNIQUE (holiday_rule_id, year);

ALTER TABLE holiday_rules ADD CONSTRAINT holiday_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE holiday_rule_branches ADD CONSTRAINT holiday_rule_branches_holiday_rule_id_fkey FOREIGN KEY (holiday_rule_id) REFERENCES holiday_rules (id) ON DELETE CASCADE;
ALTER TABLE holiday_rule_branches ADD CONSTRAINT holiday_rule_branches_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES org_units (id) ON DELETE CASCADE;
ALTER TABLE holiday_changes ADD CONSTRAINT holiday_changes_holiday_rule_id_fkey FOREIGN KEY (holiday_rule_id) REFERENCES holiday_rules (id) ON DELETE CASCADE;
ALTER TABLE holiday_changes ADD CONSTRAINT holiday_changes_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_account_id_fkey FOREIGN KEY (account_id) REFERENCES user_accounts (id) ON DELETE CASCADE;

CREATE INDEX ON holiday_changes (changed_by);
CREATE INDEX ON holiday_changes (holiday_rule_id);
CREATE INDEX ON holiday_rule_branches (branch_id);
CREATE INDEX ON holiday_rules (created_by);

-- The app's database login (heyhr_app, made by server/setup-db.ps1) can use the new tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON holiday_rules, holiday_rule_branches, holiday_changes, user_preferences TO heyhr_app;

-- ---- Descriptions (same as the data dictionary) ----

COMMENT ON COLUMN company_settings.leave_half_days IS 'People may file half a day of leave (Settings > Time off & leave).';
COMMENT ON COLUMN company_settings.leave_negative_balance IS 'People may file leave beyond their remaining credits.';
COMMENT ON COLUMN company_settings.leave_default_carry_over IS 'Carry-over limit (days) pre-filled for new leave types.';
COMMENT ON COLUMN company_settings.leave_accrual IS 'How leave credits are granted; only yearly is calculated today.';
COMMENT ON COLUMN company_settings.overtime_threshold_minutes IS 'Extra time after a shift shorter than this isn''t overtime (Settings > Scheduling).';
COMMENT ON COLUMN company_settings.default_break_minutes IS 'Lunch break pre-filled for new shifts.';
COMMENT ON COLUMN company_settings.schedule_publish_lead_days IS 'How many days ahead schedules are published; stored for when there is a publishing step.';
COMMENT ON TABLE holiday_rules IS 'Holidays HR added on the Holiday calendar, or as company holidays in Settings: proclaimed and local holidays, every year or one year only. The national holidays and the movable ones (Holy Week, National Heroes Day, Chinese New Year) are built into the app.';
COMMENT ON COLUMN holiday_rules.id IS 'Primary key.';
COMMENT ON COLUMN holiday_rules.name IS 'e.g. Eid''l Fitr, Cebu City Charter Day.';
COMMENT ON COLUMN holiday_rules.holiday_type IS 'Regular holidays pay 200%; special days 130%.';
COMMENT ON COLUMN holiday_rules.repeat_kind IS 'Every year on the same date, or one year only.';
COMMENT ON COLUMN holiday_rules.repeat_month IS 'Month (1-12), for a holiday every year.';
COMMENT ON COLUMN holiday_rules.repeat_day IS 'Day of the month, for a holiday every year.';
COMMENT ON COLUMN holiday_rules.once_date IS 'The date, for a one-year holiday.';
COMMENT ON COLUMN holiday_rules.source IS 'Proclamation or ordinance; Company for company holidays added in Settings.';
COMMENT ON COLUMN holiday_rules.created_by IS 'Who added it.';
COMMENT ON COLUMN holiday_rules.created_by_name IS 'Name of who added it, kept if the account goes.';
COMMENT ON COLUMN holiday_rules.created_at IS 'When the row was created.';
COMMENT ON TABLE holiday_rule_branches IS 'Offices a local holiday applies to. No rows means every office.';
COMMENT ON COLUMN holiday_rule_branches.holiday_rule_id IS 'The holiday.';
COMMENT ON COLUMN holiday_rule_branches.branch_id IS 'Office it applies to.';
COMMENT ON TABLE holiday_changes IS 'One-year changes from a proclamation: a holiday moved to another date, or cancelled, that year.';
COMMENT ON COLUMN holiday_changes.id IS 'Primary key.';
COMMENT ON COLUMN holiday_changes.builtin_rule_id IS 'Built-in holiday it changes (the app''s id, e.g. national-heroes-day).';
COMMENT ON COLUMN holiday_changes.holiday_rule_id IS 'Holiday HR added that it changes.';
COMMENT ON COLUMN holiday_changes.year IS 'The year it applies to.';
COMMENT ON COLUMN holiday_changes.change_kind IS 'Moved or cancelled that year.';
COMMENT ON COLUMN holiday_changes.new_date IS 'The new date, when moved.';
COMMENT ON COLUMN holiday_changes.source IS 'Proclamation that changes it.';
COMMENT ON COLUMN holiday_changes.changed_by IS 'Who recorded it.';
COMMENT ON COLUMN holiday_changes.changed_by_name IS 'Name of who recorded it, kept if the account goes.';
COMMENT ON COLUMN holiday_changes.changed_at IS 'When it was recorded.';
COMMENT ON TABLE user_preferences IS 'Each person''s own settings (Settings > Account, Notifications, Appearance), kept with their account so they follow them to any computer. The theme stays on each device.';
COMMENT ON COLUMN user_preferences.account_id IS 'Whose settings.';
COMMENT ON COLUMN user_preferences.display_name IS 'Name they''d like shown; empty = their account name.';
COMMENT ON COLUMN user_preferences.language IS 'Language.';
COMMENT ON COLUMN user_preferences.timezone IS 'Their timezone; empty = the company default.';
COMMENT ON COLUMN user_preferences.date_format IS 'How dates are shown.';
COMMENT ON COLUMN user_preferences.week_start IS 'First day of the week: 0 = Sunday, 1 = Monday, 6 = Saturday.';
COMMENT ON COLUMN user_preferences.notifications_on IS 'Master switch for alerts.';
COMMENT ON COLUMN user_preferences.notification_matrix IS 'Per event, in-app and email on or off, e.g. {leaveSubmitted: {inApp: true, email: false}}; events not listed use the defaults.';
COMMENT ON COLUMN user_preferences.quiet_hours_on IS 'No alerts during quiet hours.';
COMMENT ON COLUMN user_preferences.quiet_from IS 'Quiet hours start.';
COMMENT ON COLUMN user_preferences.quiet_to IS 'Quiet hours end.';
COMMENT ON COLUMN user_preferences.digest IS 'Email summary.';
COMMENT ON COLUMN user_preferences.density IS 'Spacing of lists and tables.';
COMMENT ON COLUMN user_preferences.reduce_motion IS 'Turn off animations.';
COMMENT ON COLUMN user_preferences.landing_path IS 'Page opened after signing in; empty = the workspace Home.';
COMMENT ON COLUMN user_preferences.two_step_requested IS 'The two-step switch in Settings > Security; stored only. Two-factor sign-in itself is user_accounts.mfa_enabled_at.';
COMMENT ON COLUMN user_preferences.updated_at IS 'Last change.';

COMMIT;
