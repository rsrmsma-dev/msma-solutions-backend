// Philippine holidays, shared by Timekeeping, Leave and Payroll.
//
// Three kinds:
// - Permanent: the same date every year (New Year, Independence Day, Christmas...).
// - Movable by rule: Holy Week follows Easter, National Heroes Day is the last Monday of
//   August, Chinese New Year follows the lunar calendar.
// - Proclaimed each year: Eid'l Fitr, Eid'l Adha, declared special days, local holidays.
// A proclamation can also move a holiday or cancel it for one year.
// HR maintains these on the Holiday calendar; verify against each year's proclamation.

import { api, serverMode } from "./http";

export type HolidayType = "regular" | "special";

/** One holiday on one date: what Timekeeping, Leave and Payroll read. */
export interface Holiday {
  date: string;
  name: string;
  type: HolidayType;
  source: string;
  /** Offices it applies to; empty or missing means every office. */
  offices?: string[];
  ruleId?: string;
  /** "Every year", "Follows Easter", "Moved from Aug 21"... */
  how?: string;
}

export type Repeat =
  | { kind: "fixed"; month: number; day: number }
  | { kind: "easter"; offset: number }
  | { kind: "last-weekday"; month: number; weekday: number }
  | { kind: "lunar"; dates: Record<string, string> }
  | { kind: "once"; date: string };

export interface HolidayRule {
  id: string;
  name: string;
  type: HolidayType;
  repeat: Repeat;
  offices: string[];
  source: string;
  builtIn: boolean;
  active: boolean;
}

/** A one-year change from a proclamation: move the holiday, or cancel it that year. */
export interface HolidayChange {
  id: string;
  ruleId: string;
  year: number;
  kind: "move" | "cancel";
  /** For a move: the new date. */
  date?: string;
  source: string;
  by: string;
  at: string;
}

const LAW = "RA 9492 / yearly proclamation";
const fixed = (id: string, name: string, type: HolidayType, month: number, day: number): HolidayRule => ({ id, name, type, repeat: { kind: "fixed", month, day }, offices: [], source: LAW, builtIn: true, active: true });

export const BUILT_IN_RULES: HolidayRule[] = [
  fixed("new-year", "New Year's Day", "regular", 1, 1),
  { id: "chinese-new-year", name: "Chinese New Year", type: "special", repeat: { kind: "lunar", dates: { "2025": "2025-01-29", "2026": "2026-02-17", "2027": "2027-02-06", "2028": "2028-01-26", "2029": "2029-02-13", "2030": "2030-02-03" } }, offices: [], source: "Yearly proclamation (lunar calendar)", builtIn: true, active: true },
  { id: "maundy-thursday", name: "Maundy Thursday", type: "regular", repeat: { kind: "easter", offset: -3 }, offices: [], source: LAW, builtIn: true, active: true },
  { id: "good-friday", name: "Good Friday", type: "regular", repeat: { kind: "easter", offset: -2 }, offices: [], source: LAW, builtIn: true, active: true },
  { id: "black-saturday", name: "Black Saturday", type: "special", repeat: { kind: "easter", offset: -1 }, offices: [], source: LAW, builtIn: true, active: true },
  fixed("araw-ng-kagitingan", "Araw ng Kagitingan", "regular", 4, 9),
  fixed("labor-day", "Labor Day", "regular", 5, 1),
  fixed("independence-day", "Independence Day", "regular", 6, 12),
  fixed("ninoy-aquino-day", "Ninoy Aquino Day", "special", 8, 21),
  { id: "national-heroes-day", name: "National Heroes Day", type: "regular", repeat: { kind: "last-weekday", month: 8, weekday: 1 }, offices: [], source: LAW, builtIn: true, active: true },
  fixed("all-saints", "All Saints' Day", "special", 11, 1),
  fixed("bonifacio-day", "Bonifacio Day", "regular", 11, 30),
  fixed("immaculate-conception", "Feast of the Immaculate Conception", "special", 12, 8),
  fixed("christmas-eve", "Christmas Eve", "special", 12, 24),
  fixed("christmas", "Christmas Day", "regular", 12, 25),
  fixed("rizal-day", "Rizal Day", "regular", 12, 30),
  fixed("last-day", "Last day of the year", "special", 12, 31),
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Easter Sunday (Gregorian), by the anonymous algorithm. */
function easter(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day, 12);
}

/** The rule's date in a year, or undefined when it has none that year. */
export function dateOf(rule: HolidayRule, year: number): string | undefined {
  const r = rule.repeat;
  if (r.kind === "fixed") return iso(year, r.month, r.day);
  if (r.kind === "once") return r.date.startsWith(`${year}-`) ? r.date : undefined;
  if (r.kind === "lunar") return r.dates[String(year)];
  if (r.kind === "easter") {
    const d = easter(year);
    d.setDate(d.getDate() + r.offset);
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  const last = new Date(year, r.month, 0, 12);
  while (last.getDay() !== r.weekday) last.setDate(last.getDate() - 1);
  return iso(year, r.month, last.getDate());
}

/** "Every year", "Follows Easter", ... for the calendar. */
export function describeRepeat(r: Repeat): string {
  if (r.kind === "fixed") return `Every year · ${MONTHS[r.month - 1]} ${r.day}`;
  if (r.kind === "once") return "This year only";
  if (r.kind === "lunar") return "Movable · lunar calendar";
  if (r.kind === "easter") return "Movable · follows Easter";
  return `Movable · last ${WEEKDAYS[r.weekday]} of ${MONTHS[r.month - 1]}`;
}

// ---- Saved data: HR's own holidays and one-year changes ----
// Without the API server they're kept in localStorage. With it, the database is the source and
// this is a cache loaded after sign-in (refreshHolidays); the server counts the same holidays.

export interface SavedHolidays {
  rules: HolidayRule[];
  changes: HolidayChange[];
}
type Saved = SavedHolidays;

const KEY = "heyhr-holidays-v1";

function load(): Saved {
  if (serverMode) return { rules: BUILT_IN_RULES, changes: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Saved>;
      // Built-in rules always come from the code; HR may only turn them off.
      const off = new Set((s.rules ?? []).filter((r) => r.builtIn && !r.active).map((r) => r.id));
      return { rules: [...BUILT_IN_RULES.map((r) => ({ ...r, active: !off.has(r.id) })), ...(s.rules ?? []).filter((r) => !r.builtIn)], changes: s.changes ?? [] };
    }
  } catch {
    // Storage blocked or corrupt: built-ins only.
  }
  return { rules: BUILT_IN_RULES, changes: [] };
}

let saved: Saved = load();

/** Every holiday in a year, with moves and cancellations applied, in date order. */
export function holidaysFor(year: number): Holiday[] {
  return holidaysFrom(saved, year);
}

/** The same, from any set of rules and changes (the API server passes the database's). */
export function holidaysFrom(saved: Saved, year: number): Holiday[] {
  const out: Holiday[] = [];
  for (const rule of saved.rules.filter((r) => r.active)) {
    const original = dateOf(rule, year);
    if (!original) continue;
    const change = saved.changes.find((c) => c.ruleId === rule.id && c.year === year);
    if (change?.kind === "cancel") continue;
    const moved = change?.kind === "move" && change.date ? change.date : undefined;
    const d = new Date(`${original}T12:00:00`);
    out.push({
      date: moved ?? original,
      name: rule.name,
      type: rule.type,
      source: moved ? change!.source : rule.source,
      offices: rule.offices,
      ruleId: rule.id,
      how: moved ? `Moved from ${MONTHS[d.getMonth()]} ${d.getDate()}` : describeRepeat(rule.repeat),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/**
 * The holidays the rest of the app reads: last year to next year, kept up to date
 * in place so every module sees HR's changes right away.
 */
export const HOLIDAYS: Holiday[] = [];
/** The years the app keeps holidays for: last year to next year (the API server passes this year in the company's timezone). */
export const holidayYears = (y = new Date().getFullYear()) => {
  return [y - 1, y, y + 1];
};
function rebuild() {
  HOLIDAYS.splice(0, HOLIDAYS.length, ...holidayYears().flatMap(holidaysFor));
}
rebuild();

function persist(next: Saved) {
  saved = next;
  if (serverMode) return rebuild();
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not kept after a reload; fine in the prototype.
  }
  rebuild();
}

const appliesTo = (h: Holiday, office?: string) => !h.offices?.length || (!!office && h.offices.includes(office));

/** The holiday on a date. Pass the employee's office so local holidays count only there. */
export const holidayOn = (date: string, office?: string) => HOLIDAYS.find((h) => h.date === date && appliesTo(h, office));

/** Two regular holidays on one date (the workbook's DH / DRH day types). */
export const isDoubleHoliday = (date: string, office?: string) => HOLIDAYS.filter((h) => h.date === date && h.type === "regular" && appliesTo(h, office)).length > 1;

// ---- Maintenance (Holiday calendar page) ----

const DELAY = 200;
const respond = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), DELAY));
const fail = (m: string): Promise<never> => new Promise((_, rej) => setTimeout(() => rej(new Error(m)), DELAY));
const newId = () => `hol-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// ---- With the API server ----

let loading: Promise<void> | null = null;
let loadedAt = 0;

/** Loads HR's holidays and changes from the API server; the built-ins always come from the code. */
export function refreshHolidays(maxAgeMs = 0): Promise<void> {
  if (!serverMode) return Promise.resolve();
  if (loading) return loading;
  if (maxAgeMs && Date.now() - loadedAt < maxAgeMs) return Promise.resolve();
  loading = api<Saved>("GET", "/holidays")
    .then((next) => {
      persist({ rules: [...BUILT_IN_RULES, ...next.rules.filter((r) => !r.builtIn)], changes: next.changes });
      loadedAt = Date.now();
    })
    .finally(() => (loading = null));
  return loading;
}

const fresh = () => refreshHolidays(2000);

export const listHolidayRules = async () => (await fresh(), respond(saved.rules));
export const listHolidays = async (year: number) => (await fresh(), respond(holidaysFor(year)));
export const listHolidayChanges = async (year: number) => (await fresh(), respond(saved.changes.filter((c) => c.year === year)));

export async function addHoliday(input: { name: string; type: HolidayType; date: string; everyYear: boolean; offices: string[]; source: string }): Promise<HolidayRule> {
  if (!input.name.trim()) return fail("Name the holiday");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return fail("Choose the date");
  if (!input.source.trim()) return fail("Name the source, for example the proclamation number or the city ordinance");
  const [, m, d] = input.date.split("-").map(Number);
  const repeat: Repeat = input.everyYear ? { kind: "fixed", month: m!, day: d! } : { kind: "once", date: input.date };
  const clash = holidaysFor(Number(input.date.slice(0, 4))).find((h) => h.date === input.date && h.name.toLowerCase() === input.name.trim().toLowerCase());
  if (clash) return fail("That holiday is already on the calendar for that date");
  if (serverMode) {
    const added = await api<HolidayRule>("POST", "/holidays", { ...input, name: input.name.trim(), source: input.source.trim() });
    await refreshHolidays();
    return added;
  }
  const rule: HolidayRule = { id: newId(), name: input.name.trim(), type: input.type, repeat, offices: input.offices, source: input.source.trim(), builtIn: false, active: true };
  persist({ ...saved, rules: [...saved.rules, rule] });
  return respond(rule);
}

export async function removeHoliday(ruleId: string): Promise<void> {
  const r = saved.rules.find((x) => x.id === ruleId);
  if (!r) return fail("That holiday no longer exists");
  if (r.builtIn) return fail("National holidays can't be deleted. Cancel it for one year instead, if a proclamation says so.");
  if (serverMode) {
    await api("DELETE", `/holidays/${encodeURIComponent(ruleId)}`);
    return refreshHolidays();
  }
  persist({ rules: saved.rules.filter((x) => x.id !== ruleId), changes: saved.changes.filter((c) => c.ruleId !== ruleId) });
  return respond(undefined);
}

/** Move a holiday to another date, or cancel it, for one year only. */
export async function changeHolidayForYear(input: { ruleId: string; year: number; kind: "move" | "cancel"; date?: string; source: string }, by: string): Promise<HolidayChange> {
  const rule = saved.rules.find((x) => x.id === input.ruleId);
  if (!rule) return fail("That holiday no longer exists");
  if (!input.source.trim()) return fail("Name the proclamation that changes it");
  if (input.kind === "move") {
    if (!input.date || !input.date.startsWith(`${input.year}-`)) return fail(`Choose the new date in ${input.year}`);
    if (input.date === dateOf(rule, input.year)) return fail("That's already its date");
  }
  if (serverMode) {
    const change = await api<HolidayChange>("PUT", "/holidays/changes", { ...input, source: input.source.trim() });
    await refreshHolidays();
    return change;
  }
  const change: HolidayChange = { id: newId(), ruleId: input.ruleId, year: input.year, kind: input.kind, date: input.kind === "move" ? input.date : undefined, source: input.source.trim(), by, at: new Date().toISOString() };
  persist({ ...saved, changes: [...saved.changes.filter((c) => !(c.ruleId === input.ruleId && c.year === input.year)), change] });
  return respond(change);
}

/** Put a holiday back on its usual date for that year. */
export async function undoHolidayChange(ruleId: string, year: number): Promise<void> {
  if (serverMode) {
    await api("DELETE", `/holidays/changes/${encodeURIComponent(ruleId)}/${year}`);
    return refreshHolidays();
  }
  persist({ ...saved, changes: saved.changes.filter((c) => !(c.ruleId === ruleId && c.year === year)) });
  return respond(undefined);
}

// ---- Company holidays from Settings > Time off & leave ----
// Settings adds one-off company holidays (source "Company"). They're "once" rules here, so the
// Holiday calendar and Settings show the same list.

const COMPANY = "Company";
const isCompanyRule = (r: HolidayRule) => !r.builtIn && r.source === COMPANY && r.repeat.kind === "once";

export const isCustomHoliday = (h: Holiday) => h.source === COMPANY;

export function customHolidays(): Holiday[] {
  return saved.rules
    .filter((r) => r.active && isCompanyRule(r))
    .map((r) => ({ date: (r.repeat as { date: string }).date, name: r.name, type: r.type, source: COMPANY, offices: r.offices, ruleId: r.id }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function setCustomHolidays(next: Holiday[]) {
  const others = saved.rules.filter((r) => !isCompanyRule(r));
  const company = next.map((h): HolidayRule => ({ id: h.ruleId ?? newId(), name: h.name, type: h.type, repeat: { kind: "once", date: h.date }, offices: h.offices ?? [], source: COMPANY, builtIn: false, active: true }));
  persist({ ...saved, rules: [...others, ...company] });
}

// Company holidays saved by the older Settings-only list move into the calendar once.
// With the API server, Settings adds and removes them through the API (lib/settings/workspace.ts).
(function adoptOldCompanyHolidays() {
  if (serverMode) return;
  const OLD = "heyhr-custom-holidays-v1";
  try {
    const raw = localStorage.getItem(OLD);
    if (!raw) return;
    const old = JSON.parse(raw) as Holiday[];
    const have = new Set(customHolidays().map((h) => h.date));
    setCustomHolidays([...customHolidays(), ...old.filter((h) => !have.has(h.date)).map((h) => ({ ...h, source: COMPANY }))]);
    localStorage.removeItem(OLD);
  } catch {
    // Unreadable: leave it.
  }
})();
