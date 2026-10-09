// Encryption for the most sensitive things kept in the database: government and ID numbers, uploaded
// files (ID scans, clearances, medical results, receipts) and their names, leave reasons, and case and
// separation reasons. They're encrypted here, before they reach the database, so a copied database or backup
// shows only scrambled data. AES-256-GCM, a fresh random IV per value.
//
// The key is HEYHR_DATA_KEY in server/.env (32 random bytes, base64). Keep a copy somewhere safe and
// separate from the backups: without it none of this can be read back.
//
// A fingerprint of each number (HMAC, a different key derived from the same one) is stored beside it
// so the database can still refuse the same number for two employees.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function keys() {
  const raw = process.env.HEYHR_DATA_KEY ?? "";
  const master = Buffer.from(raw, "base64");
  if (master.length !== 32) {
    console.error("HEYHR_DATA_KEY is missing or not 32 bytes (base64) in server/.env. Create one with:\n  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
    process.exit(1);
  }
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
  return { enc: derive("heyhr encryption v1"), mac: derive("heyhr fingerprint v1") };
}
const K = keys();

/** Encrypted text to store, or null for an empty value. */
export function seal(value: string | null | undefined): string | null {
  if (!value) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", K.enc, iv);
  const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

/** The stored value read back. Values saved before encryption came in pass through unchanged. */
export function open(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored;
  const b = Buffer.from(stored.slice(PREFIX.length), "base64");
  const d = createDecipheriv("aes-256-gcm", K.enc, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export const isSealed = (stored: string | null | undefined) => !!stored?.startsWith(PREFIX);

// Files: the same encryption on the bytes, marked by a short header so files stored before
// encryption came in still open.
const FILE_MAGIC = Buffer.from("HEYENC1\0");

export function sealBytes(bytes: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", K.enc, iv);
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([FILE_MAGIC, iv, c.getAuthTag(), body]);
}

export const isSealedBytes = (stored: Buffer | null | undefined) => !!stored && stored.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC);

export function openBytes(stored: Buffer): Buffer {
  if (!isSealedBytes(stored)) return stored;
  const b = stored.subarray(FILE_MAGIC.length);
  const d = createDecipheriv("aes-256-gcm", K.enc, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

/** Same number in, same fingerprint out (dashes and spaces ignored), for the uniqueness check. */
export function fingerprint(value: string | null | undefined): string | null {
  const v = (value ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return v ? createHmac("sha256", K.mac).update(v).digest("hex") : null;
}
