// HeyHR API server. The Vite dev server proxies /api here, so the browser sees one origin.

import cookie from "@fastify/cookie";
import Fastify, { type FastifyReply } from "fastify";
import { COOKIE, accountJson, requireSession, signIn, signOut, loadSession } from "./auth.js";
import * as admin from "./admin.js";
import * as mfa from "./mfa.js";
import * as registration from "./registration.js";
import * as corehr from "./corehr.js";
import * as leave from "./leave.js";
import * as tk from "./timekeeping.js";
import * as payroll from "./payroll.js";
import * as paysettings from "./paysettings.js";
import * as loans from "./loans.js";
import * as finalpay from "./finalpay.js";
import * as reimb from "./reimbursements.js";
import * as records from "./records.js";
import * as holidays from "./holidays.js";
import * as orgunits from "./orgunits.js";
import * as settings from "./settings.js";
import * as policies from "./policies.js";
import * as outbox from "./outbox.js";
import * as support from "./support.js";
import * as subscription from "./subscription.js";
import * as notify from "./notify.js";
import { pool, UserError } from "./db.js";

// Behind a reverse proxy (nginx, a load balancer), set TRUST_PROXY=1 so each visitor's own address is
// used for the sign-in and registration limits instead of the proxy's.
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 1_000_000, trustProxy: process.env.TRUST_PROXY === "1" });
await app.register(cookie);

// Only JSON bodies. Fastify also reads text/plain by default, which a form on another website can send.
app.removeContentTypeParser("text/plain");

// Changes only from this website: browsers mark requests another site starts (Sec-Fetch-Site), so a
// page elsewhere can't make a signed-in person's browser post here (cross-site request forgery).
app.addHook("onRequest", async (req, reply) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return reply.code(403).send({ error: "Requests from other websites aren't allowed." });
});

// Standard protective headers on every response. HTTPS-only (HSTS) is sent when cookies are HTTPS-only.
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header("cross-origin-resource-policy", "same-origin");
  if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  if (process.env.COOKIE_SECURE !== "false") reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  return payload;
});

/**
 * Sends a stored file. Uploaded images (an SVG can carry script) open in a sandbox with no script;
 * PDFs open in the browser's viewer, which runs them in its own sandbox.
 */
function sendFile(reply: FastifyReply, f: { contentType: string; bytes: Buffer }, maxAge: number) {
  reply.header("content-type", f.contentType).header("cache-control", `private, max-age=${maxAge}`);
  if (f.contentType !== "application/pdf") reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  return reply.send(f.bytes);
}

// Sign-in tries per network address: slows password guessing across many accounts (the per-account
// lock only covers one). Failed tries only; a success clears the address.
const LOGIN_TRIES = 20;
const LOGIN_WINDOW_MS = 15 * 60_000;
const loginFails = new Map<string, number[]>();
const recentFails = (ip: string) => (loginFails.get(ip) ?? []).filter((t) => Date.now() - t < LOGIN_WINDOW_MS);

/** Database rule violations, said the way the form would say them. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  employees_pkey: "That employee ID is already used",
  employees_email_key: "Another employee already uses that email",
  employees_email_ci: "Another employee already uses that email",
  employees_mobile_no_key: "Another employee already uses that mobile number",
  employees_tin_hash_key: "Another employee already has that TIN",
  employees_sss_no_hash_key: "Another employee already has that SSS number",
  employees_philhealth_no_hash_key: "Another employee already has that PhilHealth number",
  employees_pagibig_no_hash_key: "Another employee already has that Pag-IBIG MID",
  employees_mobile_format: "Use an 11-digit mobile number, e.g. 09171234567",
  employees_email_format: "Enter a valid email",
  employees_names_letters: "Names can only have letters",
  employees_basic_rate_positive: "Enter the monthly salary",
  payroll_adjustments_payroll_run_id_employee_id_fkey: "That employee isn't in this run",
  company_policies_title_ci: "There's already a policy with that title",
  company_settings_paydays: "Paydays should be at least a week apart",
  employee_pay_profiles_amounts: "Amounts can't be negative",
  employee_pay_profiles_client_share: "The share charged to a client is 0 to 100%",
};

app.setErrorHandler((err, req, reply) => {
  if (err instanceof UserError) return reply.code(err.status).send({ error: (err as Error).message, ...(err.code ? { code: err.code } : {}) });
  const pgErr = err as { code?: string; constraint?: string; message: string };
  if (pgErr.code === "23505" || pgErr.code === "23514") {
    // The date-rule trigger raises its own readable message.
    const message = (pgErr.constraint && CONSTRAINT_MESSAGES[pgErr.constraint]) ?? (pgErr.constraint ? "That value isn't allowed" : pgErr.message);
    return reply.code(400).send({ error: message });
  }
  if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) return reply.code((err as { statusCode: number }).statusCode).send({ error: (err as Error).message });
  req.log.error(err);
  return reply.code(500).send({ error: "Something went wrong on the server. Try again." });
});

const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: process.env.COOKIE_SECURE !== "false" };

// ---- Sign-in ----

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
  if (recentFails(req.ip).length >= LOGIN_TRIES) return reply.code(429).send({ error: "Too many sign-in attempts from this network. Wait 15 minutes and try again." });
  // Someone whose last day has passed can't sign in any more. A failure here never blocks signing in.
  try {
    await corehr.separationsDue(pool);
  } catch (e) {
    req.log.error(e, "Couldn't apply separations that are due");
  }
  let result;
  try {
    result = await signIn(String(req.body?.username ?? ""), String(req.body?.password ?? ""), req.headers["user-agent"]);
  } catch (e) {
    if (e instanceof UserError && e.status === 401) loginFails.set(req.ip, [...recentFails(req.ip), Date.now()]);
    throw e;
  }
  loginFails.delete(req.ip);
  if ("mfaRequired" in result) {
    // The password was right; the browser now sends the code from the authenticator app (/api/auth/mfa).
    reply.setCookie(COOKIE, result.token, cookieOptions);
    return { mfaRequired: true };
  }
  const { token, workspace, account } = result;
  reply.setCookie(COOKIE, token, cookieOptions);
  return { workspace, account };
});

// The second sign-in step: the 6-digit code from the authenticator app, or a backup code.
app.post<{ Body: { code?: string } }>("/api/auth/mfa", async (req, reply) => {
  if (recentFails(req.ip).length >= LOGIN_TRIES) return reply.code(429).send({ error: "Too many sign-in attempts from this network. Wait 15 minutes and try again." });
  const r = await mfa.verifyLogin(req.cookies[COOKIE], String(req.body?.code ?? ""));
  if ("error" in r) {
    loginFails.set(req.ip, [...recentFails(req.ip), Date.now()]);
    if (r.locked) reply.clearCookie(COOKIE, cookieOptions);
    return reply.code(401).send({ error: r.error });
  }
  loginFails.delete(req.ip);
  return r.ok;
});

// The Register form (no session): when name, mobile and email match an employee HR added, their sign-in
// is created; HR then gives them a temporary password (Reset password in Users).
app.post<{ Body: any }>("/api/auth/register", (req) => registration.register(req.ip, req.body));

app.post<{ Body: { reason?: "manual" | "idle" } }>("/api/auth/logout", async (req, reply) => {
  await signOut(req.cookies[COOKIE], req.body?.reason === "idle" ? "idle" : "manual");
  reply.clearCookie(COOKIE, cookieOptions);
  return { ok: true };
});

app.get("/api/auth/me", async (req, reply) => {
  const s = await loadSession(req);
  if (!s) return reply.code(401).send({ error: "Not signed in" });
  return accountJson(pool, s.accountId);
});

// ---- Core HR / 201 File ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);

  r.get("/api/corehr/state", (req) => corehr.loadState(req.session!));
  r.post("/api/me/face-enrolled", async (req) => (await corehr.enrollOwnFace(req.session!), { ok: true }));
  r.get("/api/corehr/profiles", (req) => corehr.listProfiles(req.session!));
  r.get<{ Params: { id: string } }>("/api/corehr/employees/:id/profile", (req) => corehr.getProfile(req.session!, req.params.id));
  r.put<{ Params: { id: string }; Body: any }>("/api/corehr/employees/:id/profile", { bodyLimit: 5 * 1024 * 1024 }, (req) => corehr.updateProfile(req.session!, req.params.id, req.body));
  r.post<{ Params: { id: string }; Body: { target?: string } }>("/api/corehr/employees/:id/viewed", async (req) => (await corehr.logView(req.session!, req.params.id, String(req.body?.target ?? "")), { ok: true }));
  r.put<{ Params: { id: string }; Body: any }>("/api/corehr/documents/:id/file", { bodyLimit: 15 * 1024 * 1024 }, async (req) => (await corehr.attachDocumentFile(req.session!, req.params.id, req.body), { ok: true }));
  r.get<{ Params: { id: string } }>("/api/corehr/documents/:id/file", async (req, reply) => {
    const d = (await pool.query(`select file_id from employee_documents where id::text = $1`, [req.params.id])).rows[0];
    if (!d?.file_id) return reply.code(404).send({ error: "No file uploaded yet" });
    const f = await reimb.readFile(req.session!, d.file_id);
    return sendFile(reply, f, 600);
  });

  r.post<{ Body: { values: unknown } }>("/api/corehr/employees", (req) => corehr.createEmployee(req.session!, req.body?.values));
  r.patch<{ Params: { id: string; section: string }; Body: unknown }>("/api/corehr/employees/:id/:section", (req) => corehr.updateSection(req.session!, req.params.id, req.params.section, req.body));
  r.post<{ Params: { id: string } }>("/api/corehr/employees/:id/reveal-government", async (req) => (await corehr.logGovernmentReveal(req.session!, req.params.id), { ok: true }));
  r.put<{ Params: { id: string }; Body: { supervisorId: string | null } }>("/api/corehr/employees/:id/supervisor", async (req) => (await corehr.setReportsTo(req.session!, req.params.id, req.body?.supervisorId ?? null), { ok: true }));
  r.put<{ Body: { employeeId: string } }>("/api/corehr/company-head", async (req) => (await corehr.setCompanyHead(req.session!, String(req.body?.employeeId ?? "")), { ok: true }));
  r.post<{ Params: { id: string }; Body: any }>("/api/corehr/employees/:id/separation", (req) => corehr.recordSeparation(req.session!, req.params.id, req.body));
  r.post<{ Params: { id: string }; Body: any }>("/api/corehr/employees/:id/regularize", (req) => corehr.regularize(req.session!, req.params.id, req.body));
  r.delete<{ Params: { id: string } }>("/api/corehr/employees/:id/separation", (req) => corehr.cancelSeparation(req.session!, req.params.id));
  r.patch<{ Params: { id: string }; Body: unknown }>("/api/corehr/documents/:id", async (req) => (await corehr.updateDocument(req.session!, req.params.id, req.body), { ok: true }));

  // Maintenance > Locations and Departments.
  r.post<{ Body: any }>("/api/corehr/locations", (req) => orgunits.saveLocation(req.session!, undefined, req.body));
  r.put<{ Params: { id: string }; Body: any }>("/api/corehr/locations/:id", (req) => orgunits.saveLocation(req.session!, req.params.id, req.body));
  r.put<{ Params: { id: string }; Body: { active?: unknown } }>("/api/corehr/locations/:id/active", async (req) => (await orgunits.setLocationActive(req.session!, req.params.id, req.body?.active), { ok: true }));
  r.post<{ Body: any }>("/api/corehr/departments", (req) => orgunits.saveDepartment(req.session!, undefined, req.body));
  r.put<{ Params: { id: string }; Body: any }>("/api/corehr/departments/:id", (req) => orgunits.saveDepartment(req.session!, req.params.id, req.body));
  r.put<{ Params: { id: string }; Body: { active?: unknown } }>("/api/corehr/departments/:id/active", async (req) => (await orgunits.setDepartmentActive(req.session!, req.params.id, req.body?.active), { ok: true }));
});

// ---- Holiday calendar ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);
  const ok = { ok: true };
  r.get("/api/holidays", () => holidays.listHolidays());
  r.post<{ Body: any }>("/api/holidays", (req) => holidays.addHoliday(req.session!, req.body));
  r.put<{ Body: any }>("/api/holidays/changes", (req) => holidays.changeForYear(req.session!, req.body));
  r.delete<{ Params: { ruleId: string; year: string } }>("/api/holidays/changes/:ruleId/:year", async (req) => (await holidays.undoChange(req.session!, req.params.ruleId, Number(req.params.year)), ok));
  r.delete<{ Params: { id: string } }>("/api/holidays/:id", async (req) => (await holidays.removeHoliday(req.session!, req.params.id), ok));
});

// ---- Settings: leave policy, scheduling rules and personal settings ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);
  r.put<{ Body: any }>("/api/settings/leave-policy", (req) => settings.saveLeavePolicy(req.session!, req.body));
  r.put<{ Body: any }>("/api/settings/scheduling", (req) => settings.saveSchedulingRules(req.session!, req.body));
  r.get("/api/me/preferences", (req) => settings.myPreferences(req.session!));
  r.put<{ Params: { section: string }; Body: any }>("/api/me/preferences/:section", (req) => settings.saveMyPreferences(req.session!, req.params.section, req.body));
});

// ---- Company policies and the email / text outbox ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);
  const ok = { ok: true };
  r.get("/api/policies", (req) => policies.listPolicies(req.session!));
  r.get("/api/policies/mine", (req) => policies.myPolicies(req.session!));
  r.post<{ Body: any }>("/api/policies", (req) => policies.savePolicy(req.session!, undefined, req.body));
  r.put<{ Params: { id: string }; Body: any }>("/api/policies/:id", (req) => policies.savePolicy(req.session!, req.params.id, req.body));
  r.put<{ Params: { id: string }; Body: { status?: unknown } }>("/api/policies/:id/status", async (req) => (await policies.setPolicyStatus(req.session!, req.params.id, req.body?.status), ok));
  r.delete<{ Params: { id: string } }>("/api/policies/:id", async (req) => (await policies.deletePolicy(req.session!, req.params.id), ok));
  r.get<{ Params: { id: string } }>("/api/policies/:id/acknowledgements", (req) => policies.acknowledgementsFor(req.session!, req.params.id));
  r.post<{ Params: { id: string } }>("/api/policies/:id/acknowledge", async (req) => (await policies.acknowledgePolicy(req.session!, req.params.id), ok));
  // A policy's document comes in as a data URL before the policy is saved; it's read back through /api/files/:id.
  r.post<{ Body: any }>("/api/policies/files", { bodyLimit: 15 * 1024 * 1024 }, (req) => policies.uploadFile(req.session!, req.body));
  r.get("/api/outbox", (req) => outbox.listOutbox(req.session!));
  r.post<{ Body: any }>("/api/outbox", (req) => outbox.queueFromBrowser(req.session!, req.body));
  r.delete("/api/outbox", async (req) => (await outbox.clearOutbox(req.session!), ok));
  // The bell: only ever the signed-in person's own notifications.
  r.get("/api/notifications", (req) => notify.listMine(req.session!));
  r.get("/api/notifications/unread-count", (req) => notify.unreadCount(req.session!));
  r.post("/api/notifications/read", async (req) => (await notify.markAllRead(req.session!), ok));
  r.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req) => (await notify.markRead(req.session!, req.params.id), ok));
});

// ---- Leave ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);
  r.get("/api/leave/state", (req) => leave.loadState(req.session!));
  r.post<{ Body: any }>("/api/leave/requests", (req) => leave.fileLeave(req.session!, req.body ?? {}));
  r.post<{ Params: { id: string }; Body: { approve?: boolean; note?: string } }>("/api/leave/requests/:id/decision", (req) =>
    leave.decideRequest(req.session!, req.params.id, !!req.body?.approve, String(req.body?.note ?? "")));
  r.post<{ Params: { id: string }; Body: { note?: string } }>("/api/leave/requests/:id/cancel", (req) => leave.cancelRequest(req.session!, req.params.id, String(req.body?.note ?? "")));
  r.post<{ Body: any }>("/api/leave/credits", (req) => leave.adjustCredits(req.session!, req.body ?? {}));
  r.post<{ Body: any }>("/api/leave/types", (req) => leave.saveType(req.session!, req.body ?? {}));
  r.put<{ Params: { id: string }; Body: { active?: boolean } }>("/api/leave/types/:id/active", async (req) => (await leave.setTypeActive(req.session!, req.params.id, !!req.body?.active), { ok: true }));
});

// ---- Timekeeping & attendance ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);
  const ok = { ok: true };
  r.get("/api/timekeeping/state", (req) => tk.loadState(req.session!));
  r.post<{ Body: any }>("/api/timekeeping/punches", (req) => tk.addCorrection(req.session!, req.body));
  r.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/timekeeping/punches/:id/set-aside", async (req) => (await tk.setPunchAside(req.session!, req.params.id, String(req.body?.reason ?? "")), ok));
  r.post<{ Params: { id: string } }>("/api/timekeeping/punches/:id/keep", async (req) => (await tk.keepPunch(req.session!, req.params.id), ok));
  r.post<{ Params: { id: string } }>("/api/timekeeping/punches/:id/restore", async (req) => (await tk.restorePunch(req.session!, req.params.id), ok));
  r.post<{ Body: any }>("/api/timekeeping/shifts", (req) => tk.saveShift(req.session!, req.body));
  r.put<{ Body: { employeeIds?: unknown; shiftId?: unknown } }>("/api/timekeeping/usual-shift", async (req) => (await tk.setUsualShift(req.session!, req.body?.employeeIds, req.body?.shiftId ?? null), ok));
  r.put<{ Body: { employeeId?: string; date?: string; value?: string | null } }>("/api/timekeeping/day-shift", async (req) =>
    (await tk.setDayShift(req.session!, String(req.body?.employeeId ?? ""), String(req.body?.date ?? ""), req.body?.value ?? null), ok));
  r.post<{ Body: any }>("/api/timekeeping/requests", (req) => tk.fileRequest(req.session!, req.body));
  r.post<{ Params: { id: string }; Body: { approve?: boolean; note?: string } }>("/api/timekeeping/requests/:id/decision", (req) =>
    tk.decideRequest(req.session!, req.params.id, !!req.body?.approve, String(req.body?.note ?? "")));
  r.put<{ Body: any }>("/api/timekeeping/tardiness-rule", (req) => tk.saveTardinessRule(req.session!, req.body));
  r.post<{ Body: any }>("/api/timekeeping/remote-days", (req) => tk.declareRemoteDay(req.session!, req.body));
  r.delete<{ Params: { id: string } }>("/api/timekeeping/remote-days/:id", async (req) => (await tk.cancelRemoteDay(req.session!, req.params.id), ok));
  r.post<{ Body: { on?: boolean } }>("/api/timekeeping/wfh", async (req) => (await tk.setWorkFromHome(req.session!, req.body?.on === true), ok));
  r.post<{ Body: { kind?: string; match?: unknown; location?: unknown } }>("/api/timekeeping/clock", (req) => tk.clockRemote(req.session!, String(req.body?.kind ?? ""), req.body?.match, req.body?.location));
  r.post<{ Body: any }>("/api/timekeeping/notices", (req) => tk.sendNotice(req.session!, req.body));
  r.post<{ Params: { id: string } }>("/api/timekeeping/notices/:id/acknowledge", async (req) => (await tk.acknowledgeNotice(req.session!, req.params.id), ok));
  r.post<{ Body: any }>("/api/timekeeping/fixes", (req) => tk.fileFix(req.session!, req.body));
  r.post<{ Params: { id: string }; Body: { approve?: boolean; note?: string } }>("/api/timekeeping/fixes/:id/decision", (req) =>
    tk.decideFix(req.session!, req.params.id, !!req.body?.approve, String(req.body?.note ?? "")));
});

// ---- Payroll ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);
  const ok = { ok: true };
  r.get("/api/payroll/rates", () => payroll.listRates());
  r.post<{ Params: { agency: string }; Body: any }>("/api/payroll/rates/:agency", (req) => payroll.saveRates(req.session!, req.params.agency, req.body));
  r.delete<{ Params: { agency: string; id: string } }>("/api/payroll/rates/:agency/:id", async (req) => (await payroll.deleteRates(req.session!, req.params.agency, req.params.id), ok));
  r.get("/api/payroll/runs", (req) => payroll.listRuns(req.session!));
  r.post<{ Body: any }>("/api/payroll/runs", (req) => payroll.createRun(req.session!, req.body));
  r.get<{ Params: { id: string } }>("/api/payroll/runs/:id", (req) => payroll.getRun(req.session!, req.params.id));
  r.put<{ Params: { id: string }; Body: any }>("/api/payroll/runs/:id/lines", (req) => payroll.refreshRun(req.session!, req.params.id, req.body));
  r.post<{ Params: { id: string }; Body: any }>("/api/payroll/runs/:id/adjustments", (req) => payroll.addAdjustment(req.session!, req.params.id, req.body));
  r.post<{ Params: { id: string; adj: string }; Body: any }>("/api/payroll/runs/:id/adjustments/:adj/remove", (req) => payroll.removeAdjustment(req.session!, req.params.id, req.params.adj, req.body));
  r.post<{ Params: { id: string }; Body: any }>("/api/payroll/runs/:id/approve", (req) => payroll.approveRun(req.session!, req.params.id, req.body));
  r.post<{ Params: { id: string } }>("/api/payroll/runs/:id/review", (req) => payroll.reviewRun(req.session!, req.params.id));
  r.delete<{ Params: { id: string } }>("/api/payroll/runs/:id", async (req) => (await payroll.deleteRun(req.session!, req.params.id), ok));
  r.get("/api/payroll/my-payslips", (req) => payroll.myPayslips(req.session!));
  // Loans & deductions, and final pay.
  r.get("/api/payroll/pay-settings", (req) => paysettings.getPaySettings(req.session!));
  r.put<{ Body: any }>("/api/payroll/paydays", (req) => paysettings.savePaydays(req.session!, req.body));
  r.put<{ Params: { id: string }; Body: any }>("/api/payroll/pay-profiles/:id", (req) => paysettings.savePayProfile(req.session!, req.params.id, req.body));
  r.get("/api/payroll/loans", (req) => loans.listLoans(req.session!));
  r.post<{ Body: any }>("/api/payroll/loans", (req) => loans.saveLoan(req.session!, undefined, req.body));
  r.put<{ Params: { id: string }; Body: any }>("/api/payroll/loans/:id", (req) => loans.saveLoan(req.session!, req.params.id, req.body));
  r.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/payroll/loans/:id/stop", async (req) => (await loans.stopLoan(req.session!, req.params.id, String(req.body?.reason ?? "")), ok));
  r.get("/api/payroll/final-pay", (req) => finalpay.listCases(req.session!));
  r.post<{ Body: any }>("/api/payroll/final-pay", (req) => finalpay.openCase(req.session!, req.body));
  r.post<{ Body: any }>("/api/payroll/final-pay/release", (req) => finalpay.releaseCase(req.session!, req.body));
  r.delete<{ Params: { id: string } }>("/api/payroll/final-pay/:id", async (req) => (await finalpay.removeCase(req.session!, req.params.id), ok));
});

// ---- Reimbursements and stored files ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);
  r.get("/api/reimbursements/claims", (req) => reimb.listClaims(req.session!));
  // Receipt photos come in as data URLs; allow room for one.
  r.post<{ Body: any }>("/api/reimbursements/claims", { bodyLimit: 8 * 1024 * 1024 }, (req) => reimb.fileClaim(req.session!, req.body));
  r.post<{ Params: { id: string }; Body: { approve?: boolean; note?: string } }>("/api/reimbursements/claims/:id/decision", (req) =>
    reimb.decideClaim(req.session!, req.params.id, !!req.body?.approve, String(req.body?.note ?? "")));
  r.post<{ Body: any }>("/api/reimbursements/claims/pay", (req) => reimb.releaseClaims(req.session!, req.body));
  r.get<{ Params: { id: string } }>("/api/files/:id", async (req, reply) => {
    const f = await reimb.readFile(req.session!, req.params.id);
    return sendFile(reply, f, 3600);
  });
});

// ---- Self-service records: announcements, benefits, trainings, licenses, certificates ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);
  const ok = { ok: true };
  r.get("/api/announcements", () => records.listAnnouncements());
  r.post<{ Body: any }>("/api/announcements", (req) => records.postAnnouncement(req.session!, req.body));
  r.get("/api/me/benefits", (req) => records.listMyBenefits(req.session!));
  r.post<{ Body: any }>("/api/me/benefits", (req) => records.addBenefit(req.session!, req.body));
  r.post<{ Params: { id: string } }>("/api/me/benefits/:id/confirm", (req) => records.confirmBenefit(req.session!, req.params.id));
  r.delete<{ Params: { id: string } }>("/api/me/benefits/:id", async (req) => (await records.removeBenefit(req.session!, req.params.id), ok));
  r.get("/api/me/trainings", (req) => records.listMyTrainings(req.session!));
  r.put<{ Params: { id: string }; Body: { status?: string } }>("/api/me/trainings/:id/status", (req) => records.setMyTrainingStatus(req.session!, req.params.id, String(req.body?.status ?? "")));
  r.put<{ Params: { id: string }; Body: { status?: string } }>("/api/trainings/:id/status", (req) => records.setTrainingStatus(req.session!, req.params.id, String(req.body?.status ?? "")));
  r.get("/api/me/license", (req) => records.myLicense(req.session!));
  r.get("/api/licenses", (req) => records.listLicenses(req.session!));
  r.put<{ Params: { id: string }; Body: { cpdUnitsEarned?: unknown } }>("/api/licenses/:id/cpd", (req) => records.setCpdUnits(req.session!, req.params.id, req.body?.cpdUnitsEarned));
  r.get("/api/me/certificates", (req) => records.listMyCertificates(req.session!));
  r.post<{ Body: any }>("/api/me/certificates", (req) => records.requestCertificate(req.session!, req.body));
  r.delete<{ Params: { id: string } }>("/api/me/certificates/:id", async (req) => (await records.cancelCertificate(req.session!, req.params.id), ok));
  r.get("/api/certificates", (req) => records.listCertificatesForReview(req.session!));
  r.put<{ Params: { id: string }; Body: { status?: string } }>("/api/certificates/:id/status", (req) => records.setCertificateStatus(req.session!, req.params.id, String(req.body?.status ?? "")));
  r.post<{ Params: { id: string } }>("/api/certificates/:id/issue", (req) => records.issueCertificate(req.session!, req.params.id));
  r.post<{ Params: { id: string } }>("/api/certificates/:id/ready", (req) => records.markCertificateReady(req.session!, req.params.id));
  r.post<{ Params: { id: string } }>("/api/certificates/:id/released", (req) => records.markCertificateReleased(req.session!, req.params.id));
  r.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/certificates/:id/decline", (req) => records.declineCertificate(req.session!, req.params.id, req.body?.reason));
});

// ---- Administration & Security ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);

  // Two-factor sign-in (Settings › Security).
  r.get("/api/me/mfa", (req) => mfa.status(req.session!));
  r.post("/api/me/mfa/setup", (req) => mfa.setup(req.session!));
  r.post<{ Body: { code?: string } }>("/api/me/mfa/enable", (req) => mfa.enable(req.session!, String(req.body?.code ?? "")));
  r.post<{ Body: { password?: string; code?: string } }>("/api/me/mfa/disable", (req) => mfa.disable(req.session!, String(req.body?.password ?? ""), String(req.body?.code ?? "")));
  r.post<{ Body: { code?: string } }>("/api/me/mfa/backup-codes", (req) => mfa.regenerateBackupCodes(req.session!, String(req.body?.code ?? "")));
  r.post<{ Params: { id: string } }>("/api/admin/accounts/:id/mfa-reset", async (req) => (await admin.resetMfa(req.session!, req.params.id), { ok: true }));

  r.post<{ Body: { currentPassword?: string; newPassword?: string } }>("/api/auth/change-password", (req) =>
    admin.changeOwnPassword(req.session!, String(req.body?.currentPassword ?? ""), String(req.body?.newPassword ?? "")));

  // Every signed-in user needs the role definitions to know what they can open.
  r.get("/api/roles", (req) => admin.listRoles(false, undefined, req.session!));
  r.get("/api/admin/roles", (req) => admin.listRoles(true, undefined, req.session!));
  r.post<{ Body: any }>("/api/admin/roles", (req) => admin.saveRole(req.session!, req.body ?? {}));
  r.delete<{ Params: { id: string } }>("/api/admin/roles/:id", async (req) => (await admin.deleteRole(req.session!, req.params.id), { ok: true }));

  r.get("/api/admin/accounts", (req) => admin.listAccounts(req.session!));
  r.post<{ Body: any }>("/api/admin/accounts", (req) => admin.createAccount(req.session!, req.body ?? {}));
  r.put<{ Params: { id: string }; Body: { roleId?: string } }>("/api/admin/accounts/:id/role", async (req) => (await admin.setAccountRole(req.session!, req.params.id, String(req.body?.roleId ?? "")), { ok: true }));
  r.put<{ Params: { id: string }; Body: { status?: string } }>("/api/admin/accounts/:id/status", async (req) => (await admin.setAccountStatus(req.session!, req.params.id, String(req.body?.status ?? "")), { ok: true }));
  r.post<{ Params: { id: string } }>("/api/admin/accounts/:id/unlock", async (req) => (await admin.unlockAccount(req.session!, req.params.id), { ok: true }));
  r.post<{ Params: { id: string } }>("/api/admin/accounts/:id/reset-password", (req) => admin.resetPassword(req.session!, req.params.id));

  r.get("/api/settings", () => admin.getSettings());
  r.get("/api/workflows", () => admin.listWorkflows());
  r.put<{ Body: any }>("/api/admin/workflows", (req) => admin.saveWorkflow(req.session!, req.body));
  // The company logo comes in as a data URL (up to 1 MB as a file).
  r.put<{ Body: any }>("/api/admin/settings", { bodyLimit: 2 * 1024 * 1024 }, (req) => admin.saveSettings(req.session!, req.body));
  r.get("/api/admin/audit", (req) => admin.listAdminAudit(req.session!));

  // Support tickets (Administration > Support).
  r.get("/api/support/tickets", (req) => support.listTickets(req.session!));
  r.post<{ Body: any }>("/api/support/tickets", (req) => support.fileTicket(req.session!, req.body));
  r.post<{ Params: { id: string }; Body: any }>("/api/support/tickets/:id/messages", (req) => support.replyTicket(req.session!, req.params.id, req.body));
  r.patch<{ Params: { id: string }; Body: any }>("/api/support/tickets/:id", (req) => support.updateTicket(req.session!, req.params.id, req.body));
  r.post<{ Params: { id: string } }>("/api/support/tickets/:id/close", (req) => support.closeTicket(req.session!, req.params.id));

  // Subscription & seat limits: the company's plan (Super Admin, HR), Clients & Subscriptions (System Admin).
  r.get("/api/subscription", (req) => subscription.getSubscription(req.session!));
  r.post("/api/subscription/seat-check", (req) => subscription.seatCheck(req.session!));
  r.post<{ Body: any }>("/api/subscription/upgrade-requests", (req) => subscription.requestUpgrade(req.session!, req.body));
  r.get("/api/subscription/clients", (req) => subscription.listClients(req.session!));
  r.get("/api/subscription/plans", (req) => subscription.listPlans(req.session!));
  r.get("/api/subscription/events", (req) => subscription.listEvents(req.session!));
  r.put<{ Params: { id: string }; Body: any }>("/api/subscription/clients/:id/plan", (req) => subscription.changePlan(req.session!, req.params.id, req.body));
  r.put<{ Params: { id: string }; Body: any }>("/api/subscription/clients/:id/seat-override", (req) => subscription.setSeatOverride(req.session!, req.params.id, req.body));
  r.put<{ Params: { id: string }; Body: any }>("/api/subscription/clients/:id/extension", (req) => subscription.setExtension(req.session!, req.params.id, req.body));

  // Older plan screen (before seat limits counted employees); the website no longer calls these.
  r.get("/api/admin/subscription", (req) => admin.getSubscription(req.session!));
  r.put<{ Body: any }>("/api/admin/subscription", (req) => admin.saveSubscription(req.session!, req.body));
});

app.get("/api/health", async () => {
  await pool.query("select 1");
  return { ok: true };
});

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "127.0.0.1" });
