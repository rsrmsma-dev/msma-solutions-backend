// Email and text messages the system queues (Administration › Outbox). Ported from src/lib/outbox.ts.
// The server looks up each person's work email, mobile number and notification settings itself, so the
// browser never needs other people's contact details. Nothing sends the messages yet: they're stored
// (address, subject and text encrypted) and listed. Sent-status updates come with a real sender.

import { audit, can, demand, type Session } from "./auth";
import { nameOf } from "./corehr";
import { open, seal } from "./crypto";
import { need020, pool, schema019, schema020, tx, UserError, type Db } from "./db";

/** Settings > Notifications events plus the system's own (src/lib/outbox.ts MessageEvent). */
const EVENTS = new Set(["leaveSubmitted", "leaveDecided", "shiftChanged", "schedulePublished", "documentUploaded", "announcement", "wfh", "payslip", "policy", "separation"]);
const KEEP = 300;
const MAX_BATCH = 1000;

export interface Message {
  employeeId: string;
  event: string;
  subject: string;
  body: string;
  sms?: string;
}

/**
 * Does this person want email for this event? As on the website: people without a sign-in, and events
 * Settings doesn't list, get it; announcements are off unless they turned them on.
 */
async function wantsEmail(db: Db, employeeId: string, event: string) {
  const prefs = (await schema019(db))
    ? `select a.id, p.notification_matrix as m from user_accounts a left join user_preferences p on p.account_id = a.id where a.employee_id = $1 limit 1`
    : `select a.id, null::jsonb as m from user_accounts a where a.employee_id = $1 limit 1`;
  const r = (await db.query(prefs, [employeeId])).rows[0];
  if (!r) return true;
  const row = r.m?.[event];
  return typeof row?.email === "boolean" ? row.email : event !== "announcement";
}

const text = (v: unknown, what: string, max: number) => {
  const t = String(v ?? "").trim();
  if (!t) throw new UserError(`The message has no ${what}`);
  return t.slice(0, max);
};

function parse(m: any): Message {
  const event = String(m?.event ?? "");
  if (!EVENTS.has(event)) throw new UserError("Unknown kind of message");
  const sms = m?.sms === undefined || m?.sms === null || m?.sms === "" ? undefined : text(m.sms, "text message", 320);
  return { employeeId: String(m?.employeeId ?? ""), event, subject: text(m?.subject, "subject", 200), body: text(m?.body, "text", 4000), sms };
}

/** Queues an email (and a text, when given) to each person. Missing addresses are skipped, as on the website. */
export async function queue(c: Db, s: Session, messages: Message[]) {
  let queued = 0;
  for (const m of messages) {
    const e = (await c.query(`select employee_id, first_name, middle_name, last_name, suffix, email, mobile_no from employees where employee_id = $1`, [m.employeeId])).rows[0];
    if (!e) continue;
    const add = (channel: "email" | "sms", address: string, subject: string, body: string) =>
      c.query(
        `insert into outbox_messages (employee_id, channel, recipient_name, address, subject, body, event, queued_by, queued_by_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [e.employee_id, channel, nameOf(e), seal(address), seal(subject), seal(body), m.event, s.accountId, s.name],
      );
    if (e.email && (await wantsEmail(c, e.employee_id, m.event))) {
      await add("email", e.email, m.subject, m.body);
      queued++;
    }
    if (m.sms && e.mobile_no) {
      await add("sms", e.mobile_no, "Text message", m.sms);
      queued++;
    }
  }
  return queued;
}

/** Messages the website queues as a side effect of what someone did (filing leave, a payslip, working from home). */
export async function queueFromBrowser(s: Session, body: any) {
  const list = Array.isArray(body?.messages) ? body.messages : [];
  if (!list.length) throw new UserError("No messages to queue");
  if (list.length > MAX_BATCH) throw new UserError(`At most ${MAX_BATCH} messages at a time`);
  const messages: Message[] = list.map(parse);
  await need020();
  const mySupervisor = s.employeeNo ? (await pool.query(`select supervisor_id from employees where employee_id = $1`, [s.employeeNo])).rows[0]?.supervisor_id : undefined;
  // Only the messages the website sends, to the person it sends them to (src/lib/**: notifyEmployee callers).
  const allowed = (m: Message) => {
    switch (m.event) {
      case "leaveSubmitted":
      case "wfh":
        return m.employeeId === mySupervisor || can(s, "edit", "people");
      case "leaveDecided":
        return can(s, "approve", "leave", m.employeeId);
      case "payslip":
        return can(s, "final", "payrollRuns");
      case "separation":
        return can(s, "edit", "people");
      default:
        return false; // policy messages are queued by the server when a policy is published
    }
  };
  if (!messages.every(allowed)) throw new UserError("You can't send that message.", 403);
  await tx((c) => queue(c, s, messages));
  return { ok: true }; // no count: it would reveal who has an email or mobile on file
}

/** The outbox: everything for whoever may see system settings (Super Admin), otherwise only your own. */
export async function listOutbox(s: Session) {
  if (!(await schema020())) return [];
  const all = can(s, "view", "systemSettings");
  if (!all && !s.employeeNo) return [];
  const { rows } = await pool.query(
    `select * from outbox_messages where status = 'waiting' ${all ? "" : "and employee_id = $2"} order by created_at desc, id limit $1`,
    all ? [KEEP] : [KEEP, s.employeeNo],
  );
  return rows.map((r) => ({
    id: r.id, channel: r.channel, to: r.recipient_name, address: open(r.address), subject: open(r.subject), body: open(r.body),
    event: r.event, at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, status: r.status,
  }));
}

/** "Clear every waiting message": they're kept on record as cleared, not deleted. */
export async function clearOutbox(s: Session) {
  demand(s, "delete", "systemSettings");
  await need020();
  await tx(async (c) => {
    const { rowCount } = await c.query(`update outbox_messages set status = 'cancelled' where status = 'waiting'`);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Administration", action: "Cleared the outbox", target: "Outbox", detail: `${rowCount ?? 0} waiting messages` });
  });
}
