// Support tickets (Administration > Support), ported from src/lib/support/store.ts. The client's Super
// Admin, HR and Accounting file tickets and follow the ones they filed; our System Admins see every
// ticket, answer, and set status, priority and who's on it. Message text is encrypted.

import { CATEGORIES, PRIORITIES, STATUS_LABEL, STATUSES, type TicketStatus } from "../../src/lib/support/store";
import { audit, demand, scopeOf, type Session } from "./auth";
import { open, seal } from "./crypto";
import { need024, pool, schema024, tx, UserError, type Db } from "./db";
import { notify } from "./notify";

/** Our support team (every System Admin), or the person who filed the ticket. */
const toSupport = (c: Db, s: Session, kind: "request" | "update", title: string, body: string) => notify(c, s, { kind, topic: "support", roles: ["system_admin"], title, body });
const toFiler = (c: Db, s: Session, t: any, kind: "update" | "approved", title: string, body: string) =>
  t.filed_by ? notify(c, s, { kind, topic: "support", accounts: [t.filed_by], title, body }) : undefined;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
const log = (db: Db, s: Session, action: string, target: string, detail = "") => audit(db, { actorId: s.accountId, actorName: s.name, module: "Administration", action, target, detail });

/** Every ticket (support), or only the ones they filed (the client's people). */
const everyone = (s: Session) => scopeOf(s, "view", "support") === "all";

async function ticketsJson(db: Db, rows: any[]) {
  if (!rows.length) return [];
  const msgs = (await db.query(`select * from support_ticket_messages where ticket_id = any($1::uuid[]) order by created_at, id`, [rows.map((t) => t.id)])).rows;
  return rows.map((t) => ({
    id: t.id, number: t.ticket_no, subject: t.subject, category: t.category, priority: t.priority, status: t.status,
    filedBy: t.filed_by_name, filedById: t.filed_by ?? "", ...(t.page ? { page: t.page } : {}), ...(t.assignee ? { assignee: t.assignee } : {}),
    createdAt: iso(t.created_at), updatedAt: iso(t.updated_at),
    messages: msgs.filter((m) => m.ticket_id === t.id).map((m) => ({ id: m.id, by: m.author_name, side: m.side, text: open(m.body), at: iso(m.created_at) })),
  }));
}

export async function listTickets(s: Session) {
  demand(s, "view", "support");
  if (!(await schema024())) return [];
  const all = everyone(s);
  const { rows } = await pool.query(`select * from support_tickets ${all ? "" : "where filed_by = $1"} order by updated_at desc`, all ? [] : [s.accountId]);
  return ticketsJson(pool, rows);
}

/** The ticket, locked, if they may see it (a ticket someone else filed is "gone" for the client's people). */
async function ticketFor(c: Db, s: Session, id: string) {
  const t = (await c.query(`select * from support_tickets where id::text = $1 for update`, [id])).rows[0];
  if (!t || (!everyone(s) && t.filed_by !== s.accountId)) throw new UserError("That ticket is gone.", 404);
  return t;
}

const one = async (c: Db, id: string) => (await ticketsJson(c, (await c.query(`select * from support_tickets where id = $1`, [id])).rows))[0];
const isSupport = (s: Session) => scopeOf(s, "edit", "support") === "all";

export async function fileTicket(s: Session, body: any) {
  demand(s, "create", "support");
  const subject = String(body?.subject ?? "").trim(), text = String(body?.text ?? "").trim();
  const category = CATEGORIES.find((x) => x === body?.category), priority = PRIORITIES.find((x) => x === body?.priority);
  const page = body?.page === undefined || body?.page === null ? null : String(body.page).slice(0, 300) || null;
  if (!subject) throw new UserError("Give the problem a short title.");
  if (!text) throw new UserError("Describe what happened.");
  if (!category) throw new UserError("Choose what it's about.");
  if (!priority) throw new UserError("Choose how urgent it is.");
  if (subject.length > 200) throw new UserError("Keep the title under 200 characters.");
  if (text.length > 5000) throw new UserError("Keep the description under 5,000 characters.");
  await need024();
  return tx(async (c) => {
    await c.query(`select pg_advisory_xact_lock(hashtext('support-ticket-numbers'))`);
    const n = (await c.query(`select greatest(1000, coalesce(max(ticket_no), 1000)) + 1 as n from support_tickets`)).rows[0].n as number;
    const support = isSupport(s);
    const { rows: [t] } = await c.query(
      `insert into support_tickets (ticket_no, subject, category, priority, filed_by, filed_by_name, page) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [n, subject, category, priority, s.accountId, s.name, page],
    );
    await c.query(`insert into support_ticket_messages (ticket_id, side, author_id, author_name, body) values ($1,$2,$3,$4,$5)`, [t.id, support ? "support" : "client", s.accountId, s.name, seal(text)]);
    await log(c, s, "Filed support ticket", `Ticket #${n}`, subject);
    if (!support) await toSupport(c, s, "request", `New ticket #${n}: ${subject}`, `${s.name} filed it (${category}, ${priority} priority).`);
    return one(c, t.id);
  });
}

export async function replyTicket(s: Session, id: string, body: any) {
  demand(s, "create", "support");
  const text = String(body?.text ?? "").trim();
  if (!text) throw new UserError("Write a reply first.");
  if (text.length > 5000) throw new UserError("Keep the reply under 5,000 characters.");
  await need024();
  return tx(async (c) => {
    const t = await ticketFor(c, s, id);
    const support = isSupport(s);
    // A client's reply reopens a ticket waiting on them or marked resolved; support's reply moves an open one along.
    const status: TicketStatus = support ? (t.status === "open" ? "in_progress" : t.status) : t.status === "waiting" || t.status === "resolved" ? "open" : t.status;
    await c.query(`insert into support_ticket_messages (ticket_id, side, author_id, author_name, body) values ($1,$2,$3,$4,$5)`, [t.id, support ? "support" : "client", s.accountId, support ? "Support team" : s.name, seal(text)]);
    await c.query(`update support_tickets set status = $2, updated_at = now() where id = $1`, [t.id, status]);
    await log(c, s, "Replied to support ticket", `Ticket #${t.ticket_no}`);
    if (support) await toFiler(c, s, t, "update", `Support replied to ticket #${t.ticket_no}`, `${t.subject}. Read the reply under Support.`);
    else await toSupport(c, s, "update", `New reply on ticket #${t.ticket_no}`, `${s.name}: ${t.subject}`);
    return one(c, t.id);
  });
}

/** Support only: status, priority and who's on it. */
export async function updateTicket(s: Session, id: string, body: any) {
  demand(s, "edit", "support");
  const patch: Record<string, unknown> = {};
  if (body?.status !== undefined) patch.status = STATUSES.find((x) => x === body.status) ?? fail("Choose a status.");
  if (body?.priority !== undefined) patch.priority = PRIORITIES.find((x) => x === body.priority) ?? fail("Choose a priority.");
  if (body?.assignee !== undefined) patch.assignee = String(body.assignee ?? "").trim().slice(0, 100) || null;
  await need024();
  return tx(async (c) => {
    const t = await ticketFor(c, s, id);
    const keys = Object.keys(patch); // only status, priority, assignee
    await c.query(`update support_tickets set ${[...keys.map((k, i) => `${k} = $${i + 2}`), "updated_at = now()"].join(", ")} where id = $1`, [t.id, ...Object.values(patch)]);
    await log(c, s, "Changed support ticket", `Ticket #${t.ticket_no}`, keys.map((k) => `${k}: ${patch[k] ?? "none"}`).join(" · "));
    const status = patch.status as TicketStatus | undefined;
    if (status && status !== t.status) await toFiler(c, s, t, status === "resolved" ? "approved" : "update", `Ticket #${t.ticket_no} is now ${STATUS_LABEL[status].toLowerCase()}`, t.subject);
    return one(c, t.id);
  });
}

/** The client's people close their own ticket once it's sorted. */
export async function closeTicket(s: Session, id: string) {
  demand(s, "create", "support");
  await need024();
  return tx(async (c) => {
    const t = await ticketFor(c, s, id);
    await c.query(`update support_tickets set status = 'closed', updated_at = now() where id = $1`, [t.id]);
    await log(c, s, "Closed support ticket", `Ticket #${t.ticket_no}`);
    if (t.status !== "closed") await toSupport(c, s, "update", `Ticket #${t.ticket_no} was closed`, `${s.name} closed it: ${t.subject}`);
    return one(c, t.id);
  });
}

function fail(message: string): never {
  throw new UserError(message);
}
