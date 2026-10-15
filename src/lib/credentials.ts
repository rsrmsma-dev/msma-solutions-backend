import type { Role } from "./types";

/** The built-in demo logins: one per role (and the older "Admin" one, now an HR account). */
export type DemoKey = "sysadmin" | "superadmin" | "admin" | "hr" | "approver" | "accounting" | "employee";

export interface DemoCredential {
  key: DemoKey;
  username: string;
  password: string;
  /** The workspace it signs into. */
  role: Role;
  label: string;
  /** false: still signs in, but isn't offered on the sign-in page's demo list. */
  listed?: boolean;
}

// Strong, unique passwords on purpose: simple ones like "admin1" are in public
// leaked-password lists, which makes Chrome show a "Change your password" warning.
// Demo-only fixed accounts — this prototype has no real backend/user store,
// so each built-in role is reachable with one username/password pair.
const defaultCredentials: DemoCredential[] = [
  { key: "sysadmin", username: "sysadmin", password: "Heyhr-SysAdmin-2026!", role: "admin", label: "System Admin" },
  { key: "superadmin", username: "superadmin", password: "Heyhr-Super-2026!", role: "admin", label: "Super Admin" },
  { key: "admin", username: "admin", password: "Heyhr-Admin-2026!", role: "admin", label: "HR (Office Administrator)", listed: false },
  { key: "hr", username: "admin1", password: "Heyhr-HR-2026!", role: "admin", label: "HR" },
  { key: "approver", username: "approver", password: "Heyhr-Approver-2026!", role: "manager", label: "Approver", listed: false },
  { key: "accounting", username: "accounting", password: "Heyhr-Accounting-2026!", role: "admin", label: "Accounting" },
  { key: "employee", username: "ceb.msma", password: "Malunggay-4800", role: "employee", label: "Employee" },
];

const CREDENTIALS_KEY = "msma-hris-credentials-v2";
const OLD_KEY = "msma-hris-credentials";

type CredentialOverrides = Partial<Record<DemoKey, { username: string; password: string }>>;

// Changes made in Settings are kept in localStorage so a new username or
// password still works after a reload.
function loadOverrides(): CredentialOverrides {
  try {
    const stored = localStorage.getItem(CREDENTIALS_KEY);
    if (stored) return JSON.parse(stored) as CredentialOverrides;
    // Earlier versions saved changes per workspace; carry over HR and Employee.
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const o = JSON.parse(old) as Partial<Record<"admin" | "employee", { username: string; password: string }>>;
      const changed = (v?: { username: string; password: string }, weak?: string) => v && v.password !== weak;
      return { ...(changed(o.admin, "admin1") ? { hr: o.admin } : {}), ...(changed(o.employee, "admin2") ? { employee: o.employee } : {}) };
    }
  } catch {
    // Storage blocked or corrupt — fall back to the seed accounts.
  }
  return {};
}

export function getCredentials(): DemoCredential[] {
  const overrides = loadOverrides();
  return defaultCredentials.map((c) => ({ ...c, ...overrides[c.key] }));
}

export function getCredential(key: DemoKey): DemoCredential {
  return getCredentials().find((c) => c.key === key)!;
}

export function setCredential(key: DemoKey, username: string, password: string) {
  const overrides = { ...loadOverrides(), [key]: { username, password } };
  try {
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(overrides));
  } catch {
    // Non-fatal in the prototype: nothing else to persist to.
  }
}

export function findCredential(username: string, password: string): DemoCredential | undefined {
  const normalized = username.trim().toLowerCase();
  return getCredentials().find((c) => c.username === normalized && c.password === password);
}
