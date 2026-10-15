// Bell notifications (the bell in the top bar). Ported from src/lib/notifications.ts and
// src/lib/requestNotices.ts: every request, decision and HR change tells whoever has to act or is
// affected, with each role sent to its own page (LINKS in src/lib/noticeLinks.ts, shared with the
// website). The server writes them inside the same transaction as the change that causes them, one row
// per person told (their sign-in), and never tells the person who acted about their own action.
// Before migration 026 nothing is sent and the bell is empty.

import { EVERYONE, LINKS, rolesThatCan, type NotificationKind, type Topic } from "../../src/lib/noticeLinks";
import type { Action, Feature, RoleKey } from "../../src/lib/permissions";
import type { Session } from "./auth";
import { nameOf } from "./corehr";
import { open, seal } from "./crypto";
import { pool, schema026, tx, UserError, type Db } from "./db";

export { EVERYONE };
export type { Topic };

/** Who is told: everyone holding these roles, and/or whoever signs in with these employee records. */
export interface Notice {
  kind: NotificationKind;
  topic: Topic;
  title: string;
  body: string;
  roles?: RoleKey[];
  employees?: (string | null | undefined)[];
  /** Also these sign-ins (e.g. an account with no employee record). */
  accounts?: string[];
  /** Each role's page; defaults to the topic's. */
  links?: Partial<Record<RoleKey, string>>;
}

/** Admin (our own role) has Super Admin's access, so it gets Super Admin's notifications and pages. */
const asMatrix = (key: string): RoleKey => (key === "admin" ? "super_admin" : (key as RoleKey));

/** Sends one notification to each active sign-in it's for, except the one that caused it (`by`). */
export async function notify(c: Db, by: Session | null, n: Notice) {
  if (!(await schema026(c))) return;
  const roles = [...new Set(n.roles ?? [])];
  const employees = [...new Set((n.employees ?? []).filter((e): e is string => !!e))];
  const accounts = n.accounts ?? [];
  if (!roles.length && !employees.length && !accounts.length) return;
  const keys = roles.includes("super_admin") ? [...roles, "admin"] : roles;
  const { rows } = await c.query(
    `select a.id, r.role_key from user_accounts a join roles r on r.id = a.role_id
      where a.status = 'active' and (r.role_key = any($1::text[]) or a.employee_id = any($2::text[]) or a.id = any($3::uuid[]))`,
    [keys, employees, accounts],
  );
  const links = n.links ?? LINKS[n.topic];
  for (const a of rows) {
    if (by && a.id === by.accountId) continue;
    await c.query(
      `insert into notifications (account_id, topic, kind, title, body, link, by_account, by_name) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [a.id, n.topic, n.kind, seal(n.title), seal(n.body), links[asMatrix(a.role_key)] ?? null, by?.accountId ?? null, by?.name ?? null],
    );
  }
}

// ---- Who decides a request (Administration › Workflows), as src/lib/admin/approvers.ts ----

const LEVEL_RANK: Record<string, number> = { Executive: 3, Manager: 2, Supervisor: 1 };
const WORKFLOW: Partial<Record<Topic, string>> = { leave: "leave", overtime: "overtime", undertime: "undertime", adjustment: "correction" };

/** The most senior other current person in the employee's department (Executive, Manager, then Supervisor). */
async function departmentHeadOf(c: Db, employeeId: string): Promise<string | undefined> {
  const units = new Map<string, { type: string; parent: string | null }>(
    (await c.query(`select id, unit_type, parent_id from org_units`)).rows.map((u) => [u.id, { type: u.unit_type, parent: u.parent_id }]),
  );
  const deptOf = (unitId: string | null) => {
    let id = unitId;
    while (id && units.get(id) && units.get(id)!.type !== "department") id = units.get(id)!.parent;
    return id && units.get(id) ? id : undefined;
  };
  const { rows } = await c.query(
    `select e.employee_id, e.org_unit_id, e.record_status, p.job_level from employees e left join positions p on p.id = e.position_id order by e.employee_id`,
  );
  const me = rows.find((r) => r.employee_id === employeeId);
  if (!me) return undefined;
  const dept = deptOf(me.org_unit_id);
  const head = rows
    .filter((x) => x.employee_id !== employeeId && x.record_status !== "SEPARATED" && deptOf(x.org_unit_id) === dept)
    .map((x) => ({ id: x.employee_id as string, rank: LEVEL_RANK[x.job_level ?? ""] ?? 0 }))
    .sort((a, b) => b.rank - a.rank)[0];
  return head && head.rank > 0 ? head.id : undefined;
}

/**
 * Every workflow step that applies to the request (`days` for steps that only count on long leave),
 * as people (a supervisor who can decide, a department head) and roles (a step by role; Super Admins
 * when the supervisor can't decide; HR when there's no department head). Requests without a workflow
 * (claims, separations) go to the supervisor.
 */
export async function approversFor(c: Db, topic: Topic, employeeId: string, days = 0) {
  const kind = WORKFLOW[topic];
  const all = kind
    ? (await c.query(
        `select s.approver_kind, s.over_days, r.role_key from approval_workflow_steps s join approval_workflows w on w.request_kind = s.request_kind
           left join roles r on r.id = s.role_id where s.request_kind = $1 and w.is_active order by s.step_no`,
        [kind],
      )).rows
    : [];
  const steps = all.filter((s) => s.over_days === null || days > Number(s.over_days));
  const employees = new Set<string>();
  const roles = new Set<RoleKey>();
  for (const s of steps.length ? steps : [{ approver_kind: "supervisor" }]) {
    if (s.approver_kind === "supervisor") {
      const sup = (await c.query(
        `select sup.employee_id,
                exists (select 1 from user_accounts a join roles r on r.id = a.role_id where a.employee_id = sup.employee_id and r.role_key = 'approver' and a.status = 'active') as can
           from employees e join employees sup on sup.employee_id = e.supervisor_id where e.employee_id = $1`,
        [employeeId],
      )).rows[0];
      if (sup?.can) employees.add(sup.employee_id);
      else roles.add("super_admin");
    } else if (s.approver_kind === "department-head") {
      const head = await departmentHeadOf(c, employeeId);
      if (head) employees.add(head);
      else roles.add("hr");
    } else if (s.role_key) roles.add(asMatrix(s.role_key));
  }
  return { employees: [...employees], roles: [...roles] };
}

// ---- The website's helpers (src/lib/requestNotices.ts) ----

/** A request (or news about one) for whoever is assigned to decide it. */
export async function tellApprover(c: Db, by: Session | null, employeeId: string, topic: Topic, kind: NotificationKind, title: string, body: string, days = 0) {
  await notify(c, by, { kind, topic, title, body, ...(await approversFor(c, topic, employeeId, days)) });
}

/** News for the roles the access matrix assigns an action company-wide (e.g. final approval of claims → Accounting). */
export const tellAssigned = (c: Db, by: Session | null, action: Action, feature: Feature, topic: Topic, kind: NotificationKind, title: string, body: string) =>
  notify(c, by, { kind, topic, title, body, roles: rolesThatCan(action, feature) });

/** News for the people a record belongs to (a decision, a change HR made). */
export const tellEmployees = (c: Db, by: Session | null, employeeIds: string | (string | null | undefined)[], topic: Topic, kind: NotificationKind, title: string, body: string) =>
  notify(c, by, { kind, topic, title, body, employees: Array.isArray(employeeIds) ? employeeIds : [employeeIds] });

/** News for everyone holding these roles. */
export const tellRoles = (c: Db, by: Session | null, roles: RoleKey[], topic: Topic, kind: NotificationKind, title: string, body: string) =>
  notify(c, by, { kind, topic, title, body, roles });

/** "Oct 3, 2026", or "Oct 3 – Oct 6" for a span: the website's default date format. */
export function dates(start: string, end?: string | null) {
  const fmt = (iso: string, year: boolean) =>
    new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });
  return end && end !== start ? `${fmt(start, false)} – ${fmt(end, false)}` : fmt(start, true);
}

/** "₱1,250.00" */
export const peso = (n: number) => `₱${Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The employee's name for a notification ("Bea Santos"), or the id when the record is gone. */
export async function who(c: Db, employeeId: string) {
  const e = (await c.query(`select first_name, middle_name, last_name, suffix from employees where employee_id = $1`, [employeeId])).rows[0];
  return e ? nameOf(e) : employeeId;
}

// ---- The bell (signed-in person's own notifications) ----

const LIMIT = 100;

/** The signed-in person's notifications, newest first (the bell's list). */
export async function listMine(s: Session) {
  if (!(await schema026())) return [];
  const { rows } = await pool.query(`select id, kind, title, body, link, created_at, read_at from notifications where account_id = $1 order by created_at desc, id limit $2`, [s.accountId, LIMIT]);
  return rows.map((r) => ({
    id: r.id, kind: r.kind, title: open(r.title), body: open(r.body), ...(r.link ? { link: r.link } : {}),
    at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, unread: !r.read_at,
  }));
}

export async function unreadCount(s: Session) {
  if (!(await schema026())) return { count: 0 };
  const { rows } = await pool.query(`select count(*)::int as n from notifications where account_id = $1 and read_at is null`, [s.accountId]);
  return { count: rows[0].n as number };
}

/** Marks all of the signed-in person's notifications read. */
export async function markAllRead(s: Session) {
  if (!(await schema026())) return;
  await pool.query(`update notifications set read_at = now() where account_id = $1 and read_at is null`, [s.accountId]);
}

/** Marks one of the signed-in person's notifications read; someone else's answers 404. */
export async function markRead(s: Session, id: string) {
  if (!(await schema026())) return;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new UserError("That notification no longer exists", 404);
  await tx(async (c) => {
    const { rowCount } = await c.query(`update notifications set read_at = coalesce(read_at, now()) where id = $1 and account_id = $2`, [id, s.accountId]);
    if (!rowCount) throw new UserError("That notification no longer exists", 404);
  });
}
