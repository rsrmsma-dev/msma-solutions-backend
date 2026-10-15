// The Core HR store: seeded once with the company structure (no employees),
// then saved to localStorage so HR's edits survive a reload. Core HR owns the
// employee master record; the shared directory and document lists other
// pages read are kept in step with it (see syncShared).

import {
  employeeDirectory,
  personnelDocuments,
  personnelProfiles,
  setCurrentEmployee,
  setEmployeeDirectory,
  setPersonnelDocuments,
} from "../mockData";
import { api, serverMode } from "../http";
import type { Employee, PersonnelDocument } from "../types";
import type {
  AuditEntry,
  CoreEmployee,
  EmployeeDocument,
  JobEvent,
  JobLevel,
  OrgUnit,
  Position,
} from "./types";

export interface CoreHrState {
  units: OrgUnit[];
  positions: Position[];
  employees: CoreEmployee[];
  documents: EmployeeDocument[];
  events: JobEvent[];
  audit: AuditEntry[];
}

// v2: the seven job titles, and clusters RPM / VCM / ADS only.
// v3: the three partners, each heading the cluster named after their initials.
// v4: no sample employees; only the company structure is seeded.
const STORAGE_KEY = "heyhr-corehr-v4";
const SEED_ACTOR = "HR & People Operations";

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d: Date = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// ---- Seed ----

/** The firm's starting structure: [branch, department, position, team]. One row per budgeted slot. */
const ORG_SEED: [string, string, string, string][] = [
  ["Cebu HQ", "Partners", "Partner", "ADS"],
  ["Cebu HQ", "Partners", "Partner", "RPM"],
  ["Cebu HQ", "Partners", "Partner", "VCM"],
  ["Cebu HQ", "Tax Advisory", "Experienced Associate", "RPM"],
  ["Cebu HQ", "Audit & Assurance", "Associate Director", "VCM"],
  ["Cebu HQ", "Audit & Assurance", "Junior Associate", "VCM"],
  ["Manila", "Corporate Legal", "Experienced Associate", "ADS"],
  ["Davao", "Bookkeeping", "Experienced Associate", "RPM"],
  ["Cebu HQ", "Audit & Assurance", "Experienced Associate", "VCM"],
  ["Cebu HQ", "Audit & Assurance", "Junior Associate", "ADS"],
  ["Cebu HQ", "Audit & Assurance", "Junior Associate", "RPM"],
  ["Cebu HQ", "Audit & Assurance", "Junior Associate", "VCM"],
  ["Cebu HQ", "Tax Advisory", "Junior Associate", "ADS"],
  ["Davao", "Bookkeeping", "Experienced Associate", "RPM"],
  ["Manila", "Corporate Legal", "Executive Assistant / Secretary", "ADS"],
  ["Cebu HQ", "Admin & Support", "BSS Team Leader", "ADS"],
  ["Cebu HQ", "Admin & Support", "Experienced Admin Assistant", "VCM"],
];

const BRANCHES = [
  { name: "Cebu HQ", code: "CEB", address: "8F Park Centrale Tower, Cebu IT Park, Lahug, Cebu City" },
  { name: "Manila", code: "MNL", address: "21F Zuellig Building, Makati Avenue, Makati City" },
  { name: "Davao", code: "DVO", address: "3F Abreeza Corporate Center, J.P. Laurel Avenue, Davao City" },
] as const;

const DEPARTMENT_CODES: Record<string, string> = {
  "Audit & Assurance": "AUD",
  "Tax Advisory": "TAX",
  Bookkeeping: "BKP",
  "Corporate Legal": "LEG",
  "Admin & Support": "ADM",
  "Human Resources": "HRD",
  Partners: "PTR",
};

/** Accounting departments are split into client-group teams; support departments aren't. */
const TEAMED_DEPARTMENTS = new Set(["Audit & Assurance", "Tax Advisory"]);

function levelFor(title: string): JobLevel {
  if (/^partner$/i.test(title)) return "Executive";
  if (/director/i.test(title)) return "Manager";
  if (/lead|supervisor/i.test(title)) return "Supervisor";
  return "Rank and file";
}

/** "Antonio Dandan Sanchez Jr." → first Antonio, middle Dandan, last Sanchez, suffix Jr. */
function splitName(name: string) {
  const words = name.trim().split(/\s+/);
  const suffix = words.length > 2 && /^(jr\.?|sr\.?|ii|iii|iv)$/i.test(words[words.length - 1]!) ? words.pop()! : "";
  const particles = new Set(["dela", "de", "del", "san", "santa", "delos"]);
  let lastStart = words.length - 1;
  while (lastStart > 1 && particles.has(words[lastStart - 1]!.toLowerCase())) lastStart--;
  // Three or more words left: the one before the surname is the middle name.
  const middleName = lastStart >= 2 ? words[lastStart - 1]! : "";
  const firstName = words.slice(0, middleName ? lastStart - 1 : lastStart).join(" ");
  return { firstName, middleName, lastName: words.slice(lastStart).join(" "), suffix };
}

function documentFromShared(d: PersonnelDocument): EmployeeDocument {
  return {
    id: d.id,
    employeeId: d.employeeId,
    type: d.type,
    status: d.status,
    fileName: d.fileName,
    uploadedAt: d.uploadedOn,
    verifiedBy: d.status === "Verified" ? SEED_ACTOR : undefined,
    verifiedAt: d.status === "Verified" ? d.uploadedOn : undefined,
    referenceNo: d.idNumber ?? d.licenseNumber,
    expiresOn: d.idExpiry ?? d.licenseExpiry,
  };
}

function seed(): CoreHrState {
  const units: OrgUnit[] = [{ id: "org-msma", type: "company", name: "MSMA Group", code: "MSMA", parentId: null, active: true }];
  const branchId = (office: string) => `br-${slug(office)}`;
  const deptId = (office: string, dept: string) => `dp-${slug(office)}-${slug(dept)}`;
  const teamId = (office: string, dept: string, cluster: string) => `tm-${slug(office)}-${slug(dept)}-${slug(cluster)}`;

  for (const b of BRANCHES) units.push({ id: branchId(b.name), type: "branch", name: b.name, code: b.code, parentId: "org-msma", address: b.address, active: true });

  const addDept = (office: string, dept: string) => {
    const id = deptId(office, dept);
    if (!units.some((u) => u.id === id)) units.push({ id, type: "department", name: dept, code: DEPARTMENT_CODES[dept] ?? dept.slice(0, 3).toUpperCase(), parentId: branchId(office), active: true });
    return id;
  };
  const addTeam = (office: string, dept: string, cluster: string) => {
    const id = teamId(office, dept, cluster);
    if (!units.some((u) => u.id === id)) units.push({ id, type: "team", name: cluster, code: cluster.slice(0, 3).toUpperCase(), parentId: deptId(office, dept), active: true });
    return id;
  };

  // An HR department with no one in it yet, so the structure shows an unfilled unit.
  addDept("Cebu HQ", "Human Resources");

  const positions: Position[] = [];
  const positionFor = (e: Employee) => {
    const dept = addDept(e.office, e.department);
    const id = `ps-${slug(e.office)}-${slug(e.department)}-${slug(e.position)}`;
    let p = positions.find((x) => x.id === id);
    if (!p) {
      p = { id, title: e.position, code: e.position.split(/\s+/).map((w) => w[0]).join("").toUpperCase(), departmentId: dept, level: levelFor(e.position), employmentType: "Regular", slots: 0, active: true };
      positions.push(p);
    }
    p.slots++;
    return p;
  };

  // Roles and teams the firm is set up with; nobody is assigned to them yet.
  for (const [office, department, position, cluster] of ORG_SEED) {
    positionFor({ office, department, position } as Employee);
    if (TEAMED_DEPARTMENTS.has(department)) addTeam(office, department, cluster);
  }

  // Some headroom: a couple of open slots, and one budgeted role nobody holds yet.
  for (const p of positions) if (p.level === "Rank and file" && p.slots >= 2) p.slots++;
  positions.push({ id: "ps-cebu-hq-human-resources-experienced-admin-assistant", title: "Experienced Admin Assistant", code: "EAA", departmentId: "dp-cebu-hq-human-resources", level: "Rank and file", employmentType: "Probationary", slots: 2, active: true, description: "Recruitment, onboarding and 201 file upkeep." });

  // Rank-and-file report to their department's supervisory position.
  for (const p of positions) {
    if (p.level !== "Rank and file") continue;
    const lead = positions.find((x) => x.departmentId === p.departmentId && x.level !== "Rank and file");
    if (lead) p.reportsToPositionId = lead.id;
  }

  return { units, positions, employees: [], documents: [], events: [], audit: [] };
}

// ---- Persistence ----

function load(): CoreHrState {
  // With the API server, the records come from the database after sign-in (see refreshCoreHr).
  if (serverMode) return { units: [], positions: [], employees: [], documents: [], events: [], audit: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as CoreHrState;
      if (Array.isArray(s.units) && Array.isArray(s.employees) && Array.isArray(s.documents)) return s;
    }
  } catch {
    // Blocked or corrupt storage — start from the seed.
  }
  return seed();
}

/** Someone whose last day has passed becomes separated (HR recorded it ahead of time). */
function withSeparationsDue(s: CoreHrState): CoreHrState {
  const today = isoDate();
  if (!s.employees.some((e) => e.job.separationDate && e.job.separationDate < today && e.job.status !== "Separated")) return s;
  return { ...s, employees: s.employees.map((e) => (e.job.separationDate && e.job.separationDate < today && e.job.status !== "Separated" ? { ...e, job: { ...e.job, status: "Separated" as const } } : e)) };
}

export let state: CoreHrState = withSeparationsDue(load());

export function commit(next: CoreHrState) {
  state = next;
  if (serverMode) return syncShared();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the change still applies for this session.
  }
  syncShared();
}

// ---- Keeping the rest of the prototype in step ----

export function fullName(p: CoreEmployee["personal"]) {
  const mi = p.middleName.trim() ? `${p.middleName.trim()[0]!.toUpperCase()}.` : "";
  return [p.firstName, mi, p.lastName, p.suffix].map((x) => x.trim()).filter(Boolean).join(" ");
}

export function initialsOf(p: CoreEmployee["personal"]) {
  return `${p.firstName.trim()[0] ?? ""}${p.lastName.trim()[0] ?? ""}`.toUpperCase();
}

function ancestor(unitId: string | undefined, type: OrgUnit["type"]) {
  let u = state.units.find((x) => x.id === unitId);
  while (u && u.type !== type) u = state.units.find((x) => x.id === u!.parentId);
  return u;
}

/** Pushes Core HR's records into the shared directory and document list, so the
 * Overview, the Partner side and the employee's own checklist all agree. */
function syncShared() {
  const byId = new Map(employeeDirectory.map((e) => [e.id, e]));
  setEmployeeDirectory(
    state.employees.map((c) => {
      const prev = byId.get(c.id);
      const position = state.positions.find((p) => p.id === c.job.positionId);
      const team = ancestor(c.job.unitId, "team");
      const cluster = (["RPM", "VCM", "ADS"].includes(team?.code ?? "") ? team!.code : (prev?.cluster ?? "ADS")) as Employee["cluster"];
      return {
        ...prev,
        id: c.id,
        name: fullName(c.personal),
        initials: initialsOf(c.personal),
        position: position?.title ?? prev?.position ?? "Unassigned",
        department: ancestor(c.job.unitId, "department")?.name ?? prev?.department ?? "",
        office: (ancestor(c.job.unitId, "branch")?.name ?? prev?.office ?? "Cebu HQ") as Employee["office"],
        cluster,
        status: c.job.status === "Active" ? "Active" : "On leave",
        reportsToId: c.job.supervisorId ?? "admin",
        email: c.contact.workEmail || undefined,
        phone: c.contact.mobile || undefined,
        emergencyContact: c.contact.emergencyName || undefined,
        faceEnrolled: c.faceEnrolled ?? prev?.faceEnrolled,
      };
    }),
  );
  const shared = new Map(personnelDocuments.map((d) => [d.id, d]));
  setPersonnelDocuments(
    state.documents.map((d) => {
      const isLicense = d.type === "Professional License";
      return {
        ...shared.get(d.id),
        id: d.id,
        employeeId: d.employeeId,
        type: d.type,
        status: d.status,
        fileName: d.fileName,
        uploadedOn: d.uploadedAt,
        ...(isLicense ? { licenseNumber: d.referenceNo, licenseExpiry: d.expiresOn } : { idNumber: d.referenceNo, idExpiry: d.expiresOn, idType: d.idType }),
      };
    }),
  );
}

const CHRIS_MANAGER_FLAG = "heyhr-demo-chris-reports-to-antonio";

/** Picks up what other pages did to the shared lists: someone added through the
 * Overview's Add employee, or an employee uploading their own document. */
export function reconcile() {
  // The server owns the records; nothing in the browser adds to them behind its back.
  if (serverMode) return;
  let changed = false;
  let next = state;
  // Once per browser: the employee demo login (Chris S. David) reports to Antonio Sanchez, who can
  // approve. Saved data from before keeps any later change HR makes.
  try {
    const chris = next.employees.find((e) => e.id === "MSMA-00846");
    if (chris && !localStorage.getItem(CHRIS_MANAGER_FLAG)) {
      localStorage.setItem(CHRIS_MANAGER_FLAG, "1");
      if (chris.job.supervisorId !== "MSMA-00001") {
        next = { ...next, employees: next.employees.map((e) => (e.id === chris.id ? { ...e, job: { ...e.job, supervisorId: "MSMA-00001" } } : e)) };
        changed = true;
      }
    }
  } catch {
    // Storage blocked: nothing to remember.
  }
  for (const e of employeeDirectory) {
    if (next.employees.some((c) => c.id === e.id)) continue;
    changed = true;
    const dept = next.units.find((u) => u.type === "department" && u.name === e.department && next.units.find((b) => b.id === u.parentId)?.name === e.office);
    const position = next.positions.find((p) => p.departmentId === dept?.id && p.title.toLowerCase() === e.position.toLowerCase());
    const { firstName, middleName, lastName, suffix } = splitName(e.name);
    const today = isoDate();
    const profile = personnelProfiles.find((p) => p.employeeId === e.id);
    const employee: CoreEmployee = {
      id: e.id,
      personal: { firstName, middleName, lastName, suffix, birthDate: profile?.birthDate ?? "", sex: "", civilStatus: "", nationality: "Filipino" },
      contact: { workEmail: e.email ?? "", personalEmail: "", mobile: e.phone ?? "", address: "", city: "", province: "", emergencyName: "", emergencyRelationship: "", emergencyPhone: "" },
      government: { sss: "", philhealth: "", pagibig: "", tin: "" },
      job: { positionId: position?.id ?? "", unitId: dept?.id ?? "", employmentType: "Probationary", status: "Active", dateHired: today, monthlySalary: 0, workSchedule: "Mon–Fri, 8:30 AM – 5:00 PM" },
      createdAt: new Date().toISOString(),
    };
    next = {
      ...next,
      employees: [...next.employees, employee],
      events: [{ id: newId("ev"), employeeId: e.id, kind: "Hired", effectiveDate: today, changes: [{ label: "Position", to: position?.title ?? e.position }], recordedBy: "HR", recordedAt: new Date().toISOString() }, ...next.events],
    };
  }
  const known = new Set(next.documents.map((d) => d.id));
  // Someone who already has a checklist (e.g. added by hand before they were built in) keeps theirs.
  const hasChecklist = new Set(next.documents.map((d) => d.employeeId));
  const fresh = personnelDocuments.filter((d) => !known.has(d.id) && !hasChecklist.has(d.employeeId)).map(documentFromShared);
  const uploads = new Map(personnelDocuments.filter((d) => d.status === "Submitted").map((d) => [d.id, d]));
  const documents = next.documents.map((d) => {
    const s = uploads.get(d.id);
    if (d.status === "Missing" && s) {
      changed = true;
      return { ...d, status: "Submitted" as const, fileName: s.fileName, uploadedAt: s.uploadedOn };
    }
    return d;
  });
  if (fresh.length) changed = true;
  if (changed) commit({ ...next, documents: [...documents, ...fresh] });
}

syncShared();

let loading: Promise<void> | null = null;
let loadedAt = 0;

/** Loads Core HR from the API server into this store, so every module reads the database's records.
 * Reads within a moment of the last load reuse it, so one page opening doesn't fetch the same data many times. */
export function refreshCoreHr(maxAgeMs = 0): Promise<void> {
  if (!serverMode) return Promise.resolve();
  if (loading) return loading;
  if (maxAgeMs && Date.now() - loadedAt < maxAgeMs) return Promise.resolve();
  loading = api<CoreHrState>("GET", "/corehr/state")
    .then((next) => {
      state = next;
      loadedAt = Date.now();
      syncShared();
      applySignedInEmployee();
    })
    .finally(() => (loading = null));
  return loading;
}

// The signed-in account's own employee record, which the Employee workspace shows as "me".
let signedIn: { employeeId?: string; name: string } | null = null;

/** With the API server, "me" is the employee linked to the account (or no one), not the demo profile. */
export function setSignedInEmployee(account: { employeeId?: string; name: string } | null) {
  signedIn = account;
  applySignedInEmployee();
}

function applySignedInEmployee() {
  if (!serverMode || !signedIn) return;
  const e = signedIn.employeeId ? employeeDirectory.find((x) => x.id === signedIn!.employeeId) : undefined;
  const initials = signedIn.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  setCurrentEmployee(
    e ?? { id: "", name: signedIn.name, initials, position: "No employee record linked", department: "", office: "Cebu HQ", cluster: "RPM", status: "Active" },
  );
}

/** Signed out: drop everything the server sent. */
export function clearCoreHr() {
  if (!serverMode) return;
  loadedAt = 0;
  signedIn = null;
  state = load();
  syncShared();
}
