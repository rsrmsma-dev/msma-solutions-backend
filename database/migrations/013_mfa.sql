-- 013: Two-factor sign-in (MFA) with an authenticator app (Google / Microsoft Authenticator, TOTP).
--   * user_accounts: the account's secret (encrypted by the app), when MFA was turned on, and the last
--     code step used (a code works once).
--   * user_sessions.mfa_pending: after a right password, the session can only enter the code.
--   * mfa_backup_codes: one-time backup codes, stored hashed.
-- Nothing changes for anyone until they turn MFA on. Can only run once (schema_migrations).
-- Run as the database owner (postgres):
--   psql -U postgres -d heyhr -v ON_ERROR_STOP=1 -f database/migrations/013_mfa.sql

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('013_mfa');

ALTER TABLE user_accounts
  ADD COLUMN mfa_secret text,
  ADD COLUMN mfa_pending_secret text,
  ADD COLUMN mfa_enabled_at timestamptz,
  ADD COLUMN mfa_last_step bigint;
ALTER TABLE user_sessions ADD COLUMN mfa_pending boolean NOT NULL DEFAULT false;

CREATE TABLE mfa_backup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mfa_backup_codes ADD CONSTRAINT mfa_backup_codes_account_id_fkey FOREIGN KEY (account_id) REFERENCES user_accounts (id) ON DELETE CASCADE;
CREATE INDEX ON mfa_backup_codes (account_id);

-- The app's database login (heyhr_app, made by server/setup-db.ps1) can use the new table.
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_backup_codes TO heyhr_app;

COMMENT ON COLUMN user_accounts.mfa_secret IS 'Authenticator-app (TOTP) secret once two-factor sign-in is on, encrypted by the app (AES-256-GCM).';
COMMENT ON COLUMN user_accounts.mfa_pending_secret IS 'Secret being set up, until the first code confirms it; encrypted by the app.';
COMMENT ON COLUMN user_accounts.mfa_enabled_at IS 'When two-factor sign-in was turned on; empty = off.';
COMMENT ON COLUMN user_accounts.mfa_last_step IS 'Last 30-second code step used, so a code can''t be used twice.';
COMMENT ON COLUMN user_sessions.mfa_pending IS 'Password was right but the two-factor code isn''t entered yet: this session can only enter the code.';
COMMENT ON TABLE mfa_backup_codes IS 'One-time backup codes for two-factor sign-in, for when the phone is lost. Only hashes are stored.';
COMMENT ON COLUMN mfa_backup_codes.id IS 'Primary key.';
COMMENT ON COLUMN mfa_backup_codes.account_id IS 'Whose code.';
COMMENT ON COLUMN mfa_backup_codes.code_hash IS 'Argon2 hash of the code; never the code.';
COMMENT ON COLUMN mfa_backup_codes.used_at IS 'When it was used; each code works once.';
COMMENT ON COLUMN mfa_backup_codes.created_at IS 'When the row was created.';

COMMIT;
