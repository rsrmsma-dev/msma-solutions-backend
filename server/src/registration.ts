// Self-registration from the website's Register form.
//
//   1. HR adds the employee first (Add employee).
//   2. The person registers with their name, mobile and email. When all three match that employee,
//      their Employee sign-in is created right away: the username is the part of their email before
//      the @, and the password is a long random one that nobody knows, so they can't sign in yet.
//   3. HR gives them a temporary password: Reset password on that person in Users.
//   4. They sign in and change it (Settings › Security).

import { randomBytes } from "node:crypto";
import { audit, hashPassword } from "./auth.js";
import { assertSeatFree } from "./admin.js";
import { tx, UserError, type Db } from "./db.js";

/** Slows down guessing: per address, at most this many tries in the window. */
const TRIES = 8;
const WINDOW_MS = 15 * 60_000;
const tries = new Map<string, number[]>();

/** One message for every kind of mismatch, so the form can't be used to find out who works here. */
const NO_MATCH = "We couldn't match those details to an employee record. Check your full name, email and mobile number, or ask HR.";

/** "Ma. Cristina Dela-Cruz Jr." -> ["ma", "cristina", "dela", "cruz", "jr"] */
const words = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]+/g, " ").trim().split(" ").filter(Boolean);

/**
 * The typed full name matches the record when it has the first given name and the whole last name,
 * and nothing that isn't part of the name. Other given names and the middle name may be left out or
 * written as an initial ("Ana Santos" or "Ana M. Santos" for Ana Maria Santos); so may a suffix.
 * Order and capitals don't matter. Email and mobile, which must match exactly, are the real proof.
 */
function nameMatches(typed: string, e: { first_name: string; middle_name: string | null; last_name: string; suffix: string | null }) {
  const t = words(typed);
  const [given, ...otherGiven] = words(e.first_name);
  const required = [given, ...words(e.last_name)].filter((w): w is string => !!w);
  const optional = [...otherGiven, ...words(e.middle_name)];
  const allowed = new Set([...required, ...optional, ...optional.map((w) => w[0]!), ...words(e.suffix)]);
  return required.length > 1 && required.every((w) => t.includes(w)) && t.every((w) => allowed.has(w));
}

/** 9171234567, 09171234567, +63 917 123 4567 -> 09171234567 */
function mobileOf(s: string) {
  const d = s.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("63")) return `0${d.slice(2)}`;
  if (d.length === 10 && d.startsWith("9")) return `0${d}`;
  return d;
}

/** The part of the email before the @ (jjm.msma), made a valid username; a number is added if it's taken. */
async function usernameFor(c: Db, email: string, employeeId: string) {
  let base = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 27);
  if (base.length < 3) base = employeeId.toLowerCase();
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}${n}`;
    if (!(await c.query(`select 1 from user_accounts where lower(username) = $1`, [candidate])).rowCount) return candidate;
  }
}

/** The Register form (no session). Returns what the form shows: their employee ID as the reference, and their name. */
export async function register(ip: string, body: any) {
  const now = Date.now();
  const recent = (tries.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= TRIES) throw new UserError("Too many tries. Wait 15 minutes, or ask HR to create your sign-in.", 429);
  tries.set(ip, [...recent, now]);

  const str = (k: string) => String(body?.[k] ?? "").trim();
  const name = str("name").replace(/\s+/g, " "), email = str("email").toLowerCase(), mobile = mobileOf(str("phone"));
  if (!name) throw new UserError("Enter your full name");
  // The form marks these optional, but they're how we know it's really you.
  if (!email || !mobile) throw new UserError("Enter the email and mobile number HR has on file for you, so we can find your record.");

  return tx(async (c) => {
    const e = (await c.query(
      `select employee_id, first_name, middle_name, last_name, suffix, record_status from employees where lower(email) = $1 and mobile_no = $2 for update`,
      [email, mobile],
    )).rows[0];
    if (!e || e.record_status === "SEPARATED" || !nameMatches(name, e)) throw new UserError(NO_MATCH);
    // Only reached with all three right, so this doesn't reveal anything to a guesser.
    const existing = (await c.query(`select username from user_accounts where employee_id = $1`, [e.employee_id])).rows[0];
    if (existing) throw new UserError(`You're already registered (username ${existing.username}). Ask HR for your temporary password, or to reset it.`);
    await assertSeatFree(c);
    const username = await usernameFor(c, email, e.employee_id);
    const displayName = `${e.first_name} ${e.last_name}`;
    // A random password nobody knows: they sign in only after HR gives them a temporary one.
    await c.query(
      `insert into user_accounts (username, display_name, password_hash, employee_id, role_id, must_change_password) values ($1, $2, $3, $4, 'employee', true)`,
      [username, displayName, await hashPassword(randomBytes(32).toString("base64url")), e.employee_id],
    );
    await audit(c, { actorName: displayName, module: "Sign-in", action: "Registered", target: username, employeeNo: e.employee_id, detail: "Details matched the employee record; sign-in created, waiting for HR's temporary password" });
    tries.delete(ip);
    // The form shows `id` as the reference, and `name`.
    return { id: e.employee_id, name: displayName };
  });
}
