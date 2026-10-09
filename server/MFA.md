# Two-factor sign-in (MFA): what the screens need

The server side is done. Users turn it on with an authenticator app (Google Authenticator,
Microsoft Authenticator, Authy…): a new 6-digit code every 30 seconds. Nothing changes for anyone
until they turn it on. Two screens are needed.

## 1. Sign-in page: the code step

After the password, accounts with MFA on need a code.

- `signIn(username, password)` (`src/lib/admin/auth.ts`) then returns
  `{ ok: false, error: MFA_NEEDED }`. When `error === MFA_NEEDED`, show a code box instead of the
  error: "Enter the 6-digit code from your authenticator app", plus a "Use a backup code instead"
  link (same box; backup codes look like `k7m2-9xqp`).
- On submit: `verifyMfaCode(code)` (same file). It returns the same result shape as `signIn`:
  `{ ok: true, workspace, account }` (go on as after a normal sign-in) or `{ ok: false, error }`
  (show the message under the box).
- The waiting sign-in lasts 5 minutes. After that, or if the account locks, the message tells them to
  start again with their password.

Server: `POST /api/auth/login` → `{ mfaRequired: true }`, then `POST /api/auth/mfa { code }` →
`{ workspace, account }` or 401 `{ error }`.

## 2. Settings › Security: the Two-factor switch

| Step | Call | Returns |
|---|---|---|
| Show the switch state | `GET /api/me/mfa` | `{ enabled, enabledAt, backupCodesLeft }` |
| Switch on: show a QR code | `POST /api/me/mfa/setup` | `{ qrDataUrl, secret, otpauthUrl }`: show `qrDataUrl` as an `<img>`, and `secret` as "can't scan? type this key" |
| Box: "Enter the 6-digit code from the app" | `POST /api/me/mfa/enable { code }` | `{ enabled: true, backupCodes: string[10] }` |
| Show the 10 backup codes **once** (copy / download), "I've saved them" | (nothing) | |
| Switch off: ask for password and a code | `POST /api/me/mfa/disable { password, code }` | `{ enabled: false }` |
| "New backup codes" (optional) | `POST /api/me/mfa/backup-codes { code }` | `{ backupCodes }`; the old ones stop working |

Errors come back as `{ error }` with a message ready to show.

## Users page (optional)

Accounts carry `mfaEnabled`. For someone who lost their phone, a Super Admin (or System Admin, for
Super Admin accounts) can reset it: `POST /api/admin/accounts/:id/mfa-reset`. That turns MFA off and
signs them out everywhere; they set it up again. It's recorded in the audit trail.

## Security notes (already handled by the server)

- The secret is stored encrypted; backup codes only as hashes; each code works once.
- Wrong codes count toward the account lock, like wrong passwords, and toward the per-network limit.
- Until the code is entered, the session can't read anything.
