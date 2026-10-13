// Company policies and acknowledgements (Maintenance › Rules, and the employee's Company policies page).
// Ported from src/lib/policies.ts; responses keep its shapes. Whoever has Rules access (HR, Super Admin)
// writes, publishes and archives policies; everyone signed in reads the published ones and confirms
// reading them for themselves. Changing a published policy's title, text or document makes a new version
// that everyone acknowledges again. Attached documents are stored encrypted in files.

import { audit, demand, type Session } from "./auth";
import { nameOf, storeFile } from "./corehr";
import { open } from "./crypto";
import { clean, need020, pool, schema020, tx, UserError, type Db } from "./db";
import { queue } from "./outbox";

/** Same list as POLICY_CATEGORIES in src/lib/policies.ts (and the column's CHECK). */
const CATEGORIES = ["Employee handbook", "Code of conduct", "Attendance & time", "Leave", "Pay & benefits", "Data privacy", "Health & safety", "Other"];
const STATUSES = ["draft", "published", "archived"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOCUMENT = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));

const SELECT = `select p.*, f.file_name as attached_name from company_policies p left join files f on f.id = p.file_id`;
const CURRENT = `record_status <> 'SEPARATED'`;

function policyJson(r: any) {
  return clean({
    id: r.id, title: r.title, category: r.category, version: r.version, effectiveDate: r.effective_date, summary: r.summary, body: r.body,
    fileId: r.file_id, fileName: r.file_id ? open(r.attached_name) : null, requireAck: r.require_ack, status: r.status,
    updatedBy: r.updated_by_name, updatedAt: iso(r.updated_at),
  });
}

async function lockPolicy(c: Db, id: string) {
  const p = (await c.query(`${SELECT} where p.id::text = $1 for update of p`, [id])).rows[0];
  if (!p) throw new UserError("That policy no longer exists", 404);
  return p;
}

// ---- HR ----

/** Every policy with how many current employees acknowledged its current version. */
export async function listPolicies(s: Session) {
  demand(s, "view", "rules");
  if (!(await schema020())) return [];
  const { rows } = await pool.query(
    `select p.*, f.file_name as attached_name,
            (select count(*)::int from policy_acknowledgements a join employees e on e.employee_id = a.employee_id
              where a.policy_id = p.id and a.version = p.version and e.${CURRENT}) as acknowledged,
            (select count(*)::int from employees where ${CURRENT}) as total
       from company_policies p left join files f on f.id = p.file_id
      order by (p.status = 'archived'), lower(p.title)`,
  );
  return rows.map((r) => ({ ...policyJson(r), acknowledged: r.acknowledged, total: r.total }));
}

/** A document uploaded before the policy is saved (the form uploads it first). */
export async function uploadFile(s: Session, body: any) {
  demand(s, "edit", "rules");
  await need020();
  const id = await tx((c) => storeFile(c, s, body?.dataUrl, String(body?.fileName ?? "policy"), DOCUMENT, 10 * 1024 * 1024));
  return { id };
}

/** Only a document you just uploaded for a policy may be attached (never someone's 201 file or receipt). */
async function checkAttachment(c: Db, s: Session, fileId: string) {
  const f = (await c.query(
    `select f.uploaded_by from files f where f.id::text = $1
        and not exists (select 1 from employee_documents d where d.file_id = f.id)
        and not exists (select 1 from reimbursement_claims r where r.receipt_file_id = f.id)
        and not exists (select 1 from employees e where e.photo_file_id = f.id)
        and not exists (select 1 from company_settings cs where cs.logo_file_id = f.id)`,
    [fileId],
  )).rows[0];
  if (!f || f.uploaded_by !== s.accountId) throw new UserError("Attach the document again");
}

export async function savePolicy(s: Session, id: string | undefined, body: any) {
  demand(s, id ? "edit" : "create", "rules");
  const title = String(body?.title ?? "").trim();
  const category = String(body?.category ?? "");
  const effectiveDate = String(body?.effectiveDate ?? "");
  const summary = String(body?.summary ?? "").trim();
  const text = String(body?.body ?? "").trim();
  const fileId = body?.fileId ? String(body.fileId) : null;
  if (!title) throw new UserError("Give the policy a title");
  if (title.length > 200) throw new UserError("Keep the title under 200 characters");
  if (!CATEGORIES.includes(category)) throw new UserError("Choose a category");
  if (!DATE.test(effectiveDate)) throw new UserError("Choose the date it takes effect");
  if (!text && !fileId) throw new UserError("Write the policy or attach the document");
  if (typeof body?.requireAck !== "boolean") throw new UserError("Choose whether employees must acknowledge it");
  await need020();
  return tx(async (c) => {
    const old = id ? await lockPolicy(c, id) : undefined;
    const dup = await c.query(`select 1 from company_policies where lower(title) = lower($1) and status <> 'archived' and ($2::uuid is null or id <> $2)`, [title, old?.id ?? null]);
    if (dup.rowCount) throw new UserError("There's already a policy with that title");
    if (fileId && fileId !== old?.file_id) await checkAttachment(c, s, fileId);
    const changed = !!old && (old.body !== text || (old.file_id ?? null) !== fileId || old.title !== title);
    const version = old ? (old.status === "published" && changed ? old.version + 1 : old.version) : 1;
    const values = [title, category, version, effectiveDate, summary, text, fileId, body.requireAck, s.accountId, s.name];
    const { rows: [p] } = old
      ? await c.query(
          `update company_policies set title = $2, category = $3, version = $4, effective_date = $5, summary = $6, body = $7, file_id = $8, require_ack = $9,
                  updated_by = $10, updated_by_name = $11, updated_at = now() where id = $1 returning id`,
          [old.id, ...values],
        )
      : await c.query(
          `insert into company_policies (title, category, version, effective_date, summary, body, file_id, require_ack, updated_by, updated_by_name)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
          values,
        );
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Administration", action: old ? "Edited policy" : "Added policy", target: title, detail: `Version ${version}` });
    return policyJson((await c.query(`${SELECT} where p.id = $1`, [p.id])).rows[0]);
  });
}

/** Publish, archive or move back to draft. Publishing emails everyone currently employed. */
export async function setPolicyStatus(s: Session, id: string, status: unknown) {
  demand(s, "edit", "rules");
  if (typeof status !== "string" || !STATUSES.includes(status)) throw new UserError("Choose draft, published or archived");
  await need020();
  await tx(async (c) => {
    const p = await lockPolicy(c, id);
    await c.query(`update company_policies set status = $2, updated_by = $3, updated_by_name = $4, updated_at = now() where id = $1`, [p.id, status, s.accountId, s.name]);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Administration", action: status === "published" ? "Published policy" : status === "archived" ? "Archived policy" : "Moved policy to draft", target: p.title, detail: `Version ${p.version}` });
    if (status === "published" && p.status !== "published") {
      const people = (await c.query(`select employee_id from employees where ${CURRENT}`)).rows;
      const body = `${p.title} is published${p.require_ack ? " and needs your confirmation that you've read it" : ""}. Read it on heyhr under Company policies.`;
      await queue(c, s, people.map((e) => ({ employeeId: e.employee_id, event: "policy", subject: `New company policy: ${p.title}`, body })));
    }
  });
}

/** Only drafts can be deleted; published policies stay on record. */
export async function deletePolicy(s: Session, id: string) {
  demand(s, "delete", "rules");
  await need020();
  await tx(async (c) => {
    const p = await lockPolicy(c, id);
    const acked = await c.query(`select 1 from policy_acknowledgements where policy_id = $1 limit 1`, [p.id]);
    if (p.status !== "draft" || acked.rowCount) throw new UserError("Published policies stay on record. Archive it instead.");
    await c.query(`delete from company_policies where id = $1`, [p.id]);
    await audit(c, { actorId: s.accountId, actorName: s.name, module: "Administration", action: "Deleted draft policy", target: p.title });
  });
}

/** Who has and hasn't acknowledged the current version. */
export async function acknowledgementsFor(s: Session, id: string) {
  demand(s, "view", "rules");
  const none = { done: [] as { name: string; at: string }[], waiting: [] as string[] };
  if (!(await schema020())) return none;
  const p = (await pool.query(`select id, version from company_policies where id::text = $1`, [id])).rows[0];
  if (!p) return none;
  const { rows } = await pool.query(
    `select e.first_name, e.middle_name, e.last_name, e.suffix, a.acknowledged_at
       from employees e left join policy_acknowledgements a on a.employee_id = e.employee_id and a.policy_id = $1 and a.version = $2
      where e.${CURRENT}`,
    [p.id, p.version],
  );
  return {
    done: rows.filter((r) => r.acknowledged_at).map((r) => ({ name: nameOf(r), at: iso(r.acknowledged_at) })).sort((a, b) => a.name.localeCompare(b.name)),
    waiting: rows.filter((r) => !r.acknowledged_at).map((r) => nameOf(r)).sort(),
  };
}

// ---- Employees ----

/** Published policies, with when you acknowledged the current version; unacknowledged first. */
export async function myPolicies(s: Session) {
  if (!(await schema020())) return [];
  const { rows } = await pool.query(
    `select p.*, f.file_name as attached_name, a.acknowledged_at
       from company_policies p left join files f on f.id = p.file_id
       left join policy_acknowledgements a on a.policy_id = p.id and a.version = p.version and a.employee_id = $1
      where p.status = 'published'
      order by (a.acknowledged_at is not null), lower(p.title)`,
    [s.employeeNo ?? null],
  );
  return rows.map((r) => clean({ ...policyJson(r), acknowledgedAt: r.acknowledged_at ? iso(r.acknowledged_at) : null }));
}

/** You confirm you've read the current version (only for yourself). */
export async function acknowledgePolicy(s: Session, id: string) {
  if (!s.employeeNo) throw new UserError("Your sign-in isn't linked to an employee record. Ask HR to link it.");
  await need020();
  await tx(async (c) => {
    const p = (await c.query(`select id, title, version from company_policies where id::text = $1 and status = 'published'`, [id])).rows[0];
    if (!p) throw new UserError("That policy is no longer published");
    const { rowCount } = await c.query(
      `insert into policy_acknowledgements (policy_id, version, employee_id) values ($1, $2, $3) on conflict do nothing`,
      [p.id, p.version, s.employeeNo],
    );
    if (rowCount) await audit(c, { actorId: s.accountId, actorName: s.name, module: "People", action: "Acknowledged policy", target: p.title, employeeNo: s.employeeNo, detail: `Version ${p.version}` });
  });
}
