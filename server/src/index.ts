// HeyHR API server. The Vite dev server proxies /api here, so the browser sees one origin.

import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { COOKIE, accountJson, requireSession, signIn, signOut, loadSession } from "./auth.js";
import * as admin from "./admin.js";
import * as corehr from "./corehr.js";
import * as leave from "./leave.js";
import * as tk from "./timekeeping.js";
import * as payroll from "./payroll.js";
import * as reimb from "./reimbursements.js";
import * as records from "./records.js";
import { pool, UserError } from "./db.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 1_000_000 });
await app.register(cookie);

/** Database rule violations, said the way the form would say them. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  employees_pkey: "That employee ID is already used",
  employees_email_key: "Another employee already uses that email",
  employees_email_ci: "Another employee already uses that email",
  employees_mobile_no_key: "Another employee already uses that mobile number",
  employees_tin_key: "Another employee already has that TIN",
  employees_sss_no_key: "Another employee already has that SSS number",
  employees_philhealth_no_key: "Another employee already has that PhilHealth number",
  employees_pagibig_no_key: "Another employee already has that Pag-IBIG MID",
  employees_mobile_format: "Use an 11-digit mobile number, e.g. 09171234567",
  employees_email_format: "Enter a valid email",
  employees_names_letters: "Names can only have letters",
  employees_basic_rate_positive: "Enter the monthly salary",
  payroll_adjustments_payroll_run_id_employee_id_fkey: "That employee isn't in this run",
};

app.setErrorHandler((err, req, reply) => {
  if (err instanceof UserError) return reply.code(err.status).send({ error: (err as Error).message });
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
  const { token, workspace, account } = await signIn(String(req.body?.username ?? ""), String(req.body?.password ?? ""), req.headers["user-agent"]);
  reply.setCookie(COOKIE, token, cookieOptions);
  return { workspace, account };
});

// Employees HR already added create their own sign-in (no session needed).
app.post<{ Body: any }>("/api/auth/register", (req) => admin.registerAccount(req.ip, req.body));

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
    return reply.header("content-type", f.contentType).header("cache-control", "private, max-age=600").header("x-content-type-options", "nosniff").send(f.bytes);
  });

  r.post<{ Body: { values: unknown } }>("/api/corehr/employees", (req) => corehr.createEmployee(req.session!, req.body?.values));
  r.patch<{ Params: { id: string; section: string }; Body: unknown }>("/api/corehr/employees/:id/:section", (req) => corehr.updateSection(req.session!, req.params.id, req.params.section, req.body));
  r.post<{ Params: { id: string } }>("/api/corehr/employees/:id/reveal-government", async (req) => (await corehr.logGovernmentReveal(req.session!, req.params.id), { ok: true }));
  r.put<{ Params: { id: string }; Body: { supervisorId: string | null } }>("/api/corehr/employees/:id/supervisor", async (req) => (await corehr.setReportsTo(req.session!, req.params.id, req.body?.supervisorId ?? null), { ok: true }));
  r.put<{ Body: { employeeId: string } }>("/api/corehr/company-head", async (req) => (await corehr.setCompanyHead(req.session!, String(req.body?.employeeId ?? "")), { ok: true }));
  r.patch<{ Params: { id: string }; Body: unknown }>("/api/corehr/documents/:id", async (req) => (await corehr.updateDocument(req.session!, req.params.id, req.body), { ok: true }));
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
  r.post<{ Body: { kind?: string; match?: unknown } }>("/api/timekeeping/clock", (req) => tk.clockRemote(req.session!, String(req.body?.kind ?? ""), req.body?.match));
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
  r.delete<{ Params: { id: string } }>("/api/payroll/runs/:id", async (req) => (await payroll.deleteRun(req.session!, req.params.id), ok));
  r.get("/api/payroll/my-payslips", (req) => payroll.myPayslips(req.session!));
});

// ---- Reimbursements and stored files ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);
  r.get("/api/reimbursements/claims", (req) => reimb.listClaims(req.session!));
  // Receipt photos come in as data URLs; allow room for one.
  r.post<{ Body: any }>("/api/reimbursements/claims", { bodyLimit: 8 * 1024 * 1024 }, (req) => reimb.fileClaim(req.session!, req.body));
  r.post<{ Params: { id: string }; Body: { approve?: boolean; note?: string } }>("/api/reimbursements/claims/:id/decision", (req) =>
    reimb.decideClaim(req.session!, req.params.id, !!req.body?.approve, String(req.body?.note ?? "")));
  r.get<{ Params: { id: string } }>("/api/files/:id", async (req, reply) => {
    const f = await reimb.readFile(req.session!, req.params.id);
    return reply.header("content-type", f.contentType).header("cache-control", "private, max-age=3600").header("x-content-type-options", "nosniff").send(f.bytes);
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
  r.put<{ Params: { id: string }; Body: { status?: string } }>("/api/trainings/:id/status", (req) => records.setTrainingStatus(req.session!, req.params.id, String(req.body?.status ?? "")));
  r.get("/api/me/license", (req) => records.myLicense(req.session!));
  r.get("/api/licenses", (req) => records.listLicenses(req.session!));
  r.put<{ Params: { id: string }; Body: { cpdUnitsEarned?: unknown } }>("/api/licenses/:id/cpd", (req) => records.setCpdUnits(req.session!, req.params.id, req.body?.cpdUnitsEarned));
  r.get("/api/me/certificates", (req) => records.listMyCertificates(req.session!));
  r.post<{ Body: any }>("/api/me/certificates", (req) => records.requestCertificate(req.session!, req.body));
  r.delete<{ Params: { id: string } }>("/api/me/certificates/:id", async (req) => (await records.cancelCertificate(req.session!, req.params.id), ok));
  r.get("/api/certificates", (req) => records.listCertificatesForReview(req.session!));
  r.put<{ Params: { id: string }; Body: { status?: string } }>("/api/certificates/:id/status", (req) => records.setCertificateStatus(req.session!, req.params.id, String(req.body?.status ?? "")));
});

// ---- Administration & Security ----

app.register(async (r) => {
  r.addHook("preHandler", requireSession);

  r.post<{ Body: { currentPassword?: string; newPassword?: string } }>("/api/auth/change-password", (req) =>
    admin.changeOwnPassword(req.session!, String(req.body?.currentPassword ?? ""), String(req.body?.newPassword ?? "")));

  // Every signed-in user needs the role definitions to know what they can open.
  r.get("/api/roles", () => admin.listRoles(false));
  r.get("/api/admin/roles", () => admin.listRoles(true));
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
  r.put<{ Body: any }>("/api/admin/settings", (req) => admin.saveSettings(req.session!, req.body));
  r.get("/api/admin/audit", (req) => admin.listAdminAudit(req.session!));
});

app.get("/api/health", async () => {
  await pool.query("select 1");
  return { ok: true };
});

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "127.0.0.1" });
