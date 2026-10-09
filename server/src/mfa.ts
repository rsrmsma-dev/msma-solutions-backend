// Two-factor sign-in (MFA) with an authenticator app: Google Authenticator, Microsoft Authenticator
// and the like (TOTP, RFC 6238: 6 digits, a new code every 30 seconds, SHA-1).
//
// Turning it on: setup (a secret and its QR code) -> enable with the first code (10 backup codes come
// back, shown once). Signing in: a right password gives a session that can only enter the code
// (user_sessions.mfa_pending); the code or a backup code completes it. Wrong codes count toward the
// account lock, like wrong passwords. The secret is stored encrypted (crypto.ts); backup codes as
// Argon2 hashes.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { verify } from "@node-rs/argon2";
import QRCode from "qrcode";
import { accountJson, audit, hashPassword, sessionHash, type Session } from "./auth.js";
import { open, seal } from "./crypto.js";
import { pool, tx, UserError, type Db } from "./db.js";

const ISSUER = "HeyHR";
const STEP_SECONDS = 30;
const BACKUP_CODES = 10;
const MAX_SESSION_HOURS = 12;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes: Buffer) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(s: string) {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The 6-digit code for one 30-second step. */
function codeAt(secret: Buffer, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(counter).digest();
  const offset = h[h.length - 1]! & 15;
  const n = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}

/**
 * The step a right code belongs to (allowing one step either way for clock drift), or null.
 * A code from a step already used (`lastStep` or earlier) is "used": each code works once.
 */
function matchCode(secretB32: string, code: string, lastStep: number | null): { step: number } | "used" | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const secret = fromBase32(secretB32);
  const now = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  let used = false;
  for (const step of [now - 1, now, now + 1]) {
    if (!timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(c))) continue;
    if (lastStep !== null && step <= lastStep) used = true;
    else return { step };
  }
  return used ? "used" : null;
}

const USED_CODE = "That code was just used. Wait for the next code in your app.";

/** Ten fresh backup codes like "k7m2-9xqp"; only their hashes are kept. */
async function newBackupCodes(c: Db, accountId: string) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = Array.from({ length: BACKUP_CODES }, () => Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + alphabet[randomInt(alphabet.length)]).join(""));
  await c.query(`delete from mfa_backup_codes where account_id = $1`, [accountId]);
  for (const code of codes) await c.query(`insert into mfa_backup_codes (account_id, code_hash) values ($1, $2)`, [accountId, await hashPassword(code)]);
  return codes;
}

const normalizeBackup = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Uses up a matching unused backup code; true if one matched. */
async function useBackupCode(c: Db, accountId: string, code: string) {
  const want = normalizeBackup(code);
  if (want.length !== 8) return false;
  const formatted = `${want.slice(0, 4)}-${want.slice(4)}`;
  const { rows } = await c.query(`select id, code_hash from mfa_backup_codes where account_id = $1 and used_at is null`, [accountId]);
  for (const r of rows) {
    if (await verify(r.code_hash, formatted)) {
      await c.query(`update mfa_backup_codes set used_at = now() where id = $1`, [r.id]);
      return true;
    }
  }
  return false;
}

const accountRow = async (c: Db, id: string) => (await c.query(`select * from user_accounts where id = $1`, [id])).rows[0];
const backupLeft = async (c: Db, id: string) => (await c.query(`select count(*)::int as n from mfa_backup_codes where account_id = $1 and used_at is null`, [id])).rows[0].n as number;

/** A right authenticator or backup code for this account; records the step so a code works once. */
async function checkCode(c: Db, a: any, code: string): Promise<"app" | "backup" | "used" | null> {
  const m = matchCode(open(a.mfa_secret), code, a.mfa_last_step === null ? null : Number(a.mfa_last_step));
  if (m === "used") return "used";
  if (m) {
    await c.query(`update user_accounts set mfa_last_step = $2 where id = $1`, [a.id, m.step]);
    return "app";
  }
  return (await useBackupCode(c, a.id, code)) ? "backup" : null;
}

// ---- Settings › Security (signed in) ----

export async function status(s: Session) {
  const a = await accountRow(pool, s.accountId);
  return { enabled: !!a?.mfa_enabled_at, enabledAt: a?.mfa_enabled_at ? new Date(a.mfa_enabled_at).toISOString() : null, backupCodesLeft: a?.mfa_enabled_at ? await backupLeft(pool, s.accountId) : 0 };
}

/** Starts turning MFA on: a new secret and its QR code to scan. Nothing changes until enable(). */
export async function setup(s: Session) {
  const a = await accountRow(pool, s.accountId);
  if (a.mfa_enabled_at) throw new UserError("Two-factor sign-in is already on. Turn it off first to move it to a new phone.");
  const secret = base32(randomBytes(20));
  await pool.query(`update user_accounts set mfa_pending_secret = $2 where id = $1`, [s.accountId, seal(secret)]);
  const otpauthUrl = `otpauth://totp/${encodeURIComponent(`${ISSUER}:${a.username}`)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
  return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }) };
}

/** Finishes turning MFA on with the first code from the app. Returns the backup codes, shown only now. */
export async function enable(s: Session, code: string) {
  return tx(async (c) => {
    const a = (await c.query(`select * from user_accounts where id = $1 for update`, [s.accountId])).rows[0];
    if (a.mfa_enabled_at) throw new UserError("Two-factor sign-in is already on.");
    if (!a.mfa_pending_secret) throw new UserError("Start the set-up first.");
    const m = matchCode(open(a.mfa_pending_secret), code, null);
    if (!m || m === "used") throw new UserError("That code isn't right. Check the time on your phone and try the newest code.");
    await c.query(`update user_accounts set mfa_secret = mfa_pending_secret, mfa_pending_secret = null, mfa_enabled_at = now(), mfa_last_step = $2 where id = $1`, [a.id, m.step]);
    const backupCodes = await newBackupCodes(c, a.id);
    await audit(c, { actorId: a.id, actorName: a.display_name, module: "Sign-in", action: "Turned on two-factor sign-in", target: a.username });
    return { enabled: true, backupCodes };
  });
}

/** Turns MFA off: needs the password and a current code (or a backup code). */
export async function disable(s: Session, password: string, code: string) {
  return tx(async (c) => {
    const a = (await c.query(`select * from user_accounts where id = $1 for update`, [s.accountId])).rows[0];
    if (!a.mfa_enabled_at) throw new UserError("Two-factor sign-in is already off.");
    if (!(await verify(a.password_hash, password))) throw new UserError("Your password is incorrect.");
    const how = await checkCode(c, a, code);
    if (how === "used") throw new UserError(USED_CODE);
    if (!how) throw new UserError("That code isn't right.");
    await turnOff(c, a.id);
    await audit(c, { actorId: a.id, actorName: a.display_name, module: "Sign-in", action: "Turned off two-factor sign-in", target: a.username });
    return { enabled: false };
  });
}

/** New backup codes (the old ones stop working); needs a current code. */
export async function regenerateBackupCodes(s: Session, code: string) {
  return tx(async (c) => {
    const a = (await c.query(`select * from user_accounts where id = $1 for update`, [s.accountId])).rows[0];
    if (!a.mfa_enabled_at) throw new UserError("Turn on two-factor sign-in first.");
    const how = await checkCode(c, a, code);
    if (how === "used") throw new UserError(USED_CODE);
    if (!how) throw new UserError("That code isn't right.");
    const backupCodes = await newBackupCodes(c, a.id);
    await audit(c, { actorId: a.id, actorName: a.display_name, module: "Sign-in", action: "Made new backup codes", target: a.username });
    return { backupCodes };
  });
}

/** Clears an account's MFA (used by disable and by an administrator's reset). */
export async function turnOff(c: Db, accountId: string) {
  await c.query(`update user_accounts set mfa_secret = null, mfa_pending_secret = null, mfa_enabled_at = null, mfa_last_step = null where id = $1`, [accountId]);
  await c.query(`delete from mfa_backup_codes where account_id = $1`, [accountId]);
}

// ---- Signing in: the second step ----

/**
 * Completes a sign-in that's waiting for the code. A wrong code counts like a wrong password and
 * can lock the account; the waiting session ends if it does.
 */
export async function verifyLogin(token: string | undefined, code: string) {
  if (!token) throw new UserError("Sign in with your password first.", 401);
  const hash = sessionHash(token);
  return tx(async (c) => {
    const sess = (await c.query(`select * from user_sessions where token_hash = $1 and mfa_pending and expires_at > now() for update`, [hash])).rows[0];
    if (!sess) throw new UserError("That sign-in has expired. Enter your username and password again.", 401);
    const a = (await c.query(`select * from user_accounts where id = $1 for update`, [sess.account_id])).rows[0];
    const settings = (await c.query(`select lock_after_failed, lock_minutes from company_settings where id = 1`)).rows[0] ?? { lock_after_failed: 5, lock_minutes: 15 };
    if (!a || a.status !== "active" || !a.mfa_enabled_at) throw new UserError("Sign in with your password first.", 401);
    if (a.locked_until && new Date(a.locked_until) > new Date()) {
      await c.query(`delete from user_sessions where token_hash = $1`, [hash]);
      throw new UserError("Too many wrong codes. Try again later, or ask an administrator to unlock your account.", 401);
    }
    const how = await checkCode(c, a, code);
    // A code that was right a moment ago isn't a guess: ask for the next one without counting it.
    if (how === "used") return { error: USED_CODE, locked: false } as const;
    if (!how) {
      const n = a.failed_attempts + 1;
      const lock = n >= settings.lock_after_failed;
      await c.query(`update user_accounts set failed_attempts = $2, locked_until = $3 where id = $1`, [a.id, lock ? 0 : n, lock ? new Date(Date.now() + settings.lock_minutes * 60000) : a.locked_until]);
      if (lock) await c.query(`delete from user_sessions where token_hash = $1`, [hash]);
      await audit(c, { actorId: a.id, actorName: a.display_name, module: "Sign-in", action: "Failed sign-in", target: a.username, detail: lock ? `Wrong two-factor code; locked after ${n} tries` : `Wrong two-factor code (${n} of ${settings.lock_after_failed})` });
      // Committed even though the request fails: the attempt has to count.
      return { error: lock ? `Too many wrong codes. Your account is locked for ${settings.lock_minutes} minutes.` : "That code isn't right. Try the newest code in your app.", locked: lock } as const;
    }
    await c.query(`update user_sessions set mfa_pending = false, expires_at = now() + make_interval(hours => $2), last_seen_at = now() where token_hash = $1`, [hash, MAX_SESSION_HOURS]);
    await c.query(`update user_accounts set failed_attempts = 0, locked_until = null, last_sign_in_at = now() where id = $1`, [a.id]);
    await audit(c, { actorId: a.id, actorName: a.display_name, module: "Sign-in", action: "Signed in", target: a.username, detail: how === "app" ? "With two-factor code" : `With a backup code (${await backupLeft(c, a.id)} left)` });
    return { ok: (await accountJson(c, a.id))! } as const;
  });
}
