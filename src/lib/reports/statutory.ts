// Government contribution and withholding tax rules, kept as dated data with
// their source. SSS, PhilHealth and Pag-IBIG are maintained on the Government
// contributions page: a new circular is a new version with its effective date,
// never an edit of the old one, so past pay can still be worked out. Verify on
// the official site before using these for real pay.

import { api, serverMode } from "../http";
import { BUILT_IN_RATES } from "../pay/rateRules";

export interface Rule<T> {
  effectiveFrom: string;
  source: string;
  lastVerified: string;
  rates: T;
}

export interface SssRates { eeRate: number; erRate: number; mscMin: number; mscMax: number; mscStep: number; ecLow: number; ecHigh: number; ecThreshold: number }
export interface PhilHealthRates { rate: number; floor: number; ceiling: number }
export interface PagIbigRates { eeRate: number; eeLowRate: number; lowLimit: number; erRate: number; maxFundSalary: number }
/** One row of a BIR table: on pay over `over`, tax is `base` plus `rate` of the excess. */
export interface TaxBracket { over: number; base: number; rate: number }
export interface BirRates { monthly: TaxBracket[]; semiMonthly: TaxBracket[] }
export interface AgencyRates { sss: SssRates; philhealth: PhilHealthRates; pagibig: PagIbigRates; bir: BirRates }
export type Agency = keyof AgencyRates;

export interface RateVersion<A extends Agency = Agency> {
  id: string;
  effectiveFrom: string;
  source: string;
  rates: AgencyRates[A];
  savedBy: string;
  savedAt: string;
}

export type RateBook = { [A in Agency]: RateVersion<A>[] };

const BUILT_IN = BUILT_IN_RATES;

const KEY = "heyhr-contributions-v1";

function load(): RateBook {
  // With the API server, the built-in rates stand in until the database's arrive (see refreshRates).
  if (serverMode) return BUILT_IN;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<RateBook>;
      return { sss: s.sss?.length ? s.sss : BUILT_IN.sss, philhealth: s.philhealth?.length ? s.philhealth : BUILT_IN.philhealth, pagibig: s.pagibig?.length ? s.pagibig : BUILT_IN.pagibig, bir: s.bir?.length ? s.bir : BUILT_IN.bir };
    }
  } catch {
    // Blocked or corrupt storage: use the built-in rates.
  }
  return BUILT_IN;
}

let book: RateBook = load();

/** With the API server: loads every agency's versions from the database. */
export async function refreshRates() {
  if (!serverMode) return;
  const next = await api<RateBook>("GET", "/payroll/rates");
  book = { sss: next.sss?.length ? next.sss : BUILT_IN.sss, philhealth: next.philhealth?.length ? next.philhealth : BUILT_IN.philhealth, pagibig: next.pagibig?.length ? next.pagibig : BUILT_IN.pagibig, bir: next.bir?.length ? next.bir : BUILT_IN.bir };
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Every version for an agency, newest effective date first. */
export function versionsOf<A extends Agency>(agency: A): RateVersion<A>[] {
  return [...(book[agency] as RateVersion<A>[])].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
}

/** The version in force on a date (default today); before the first one, the earliest. */
export function versionOn<A extends Agency>(agency: A, on = todayIso()): RateVersion<A> {
  const all = versionsOf(agency);
  return all.find((v) => v.effectiveFrom <= on) ?? all[all.length - 1]!;
}

export const ratesOn = <A extends Agency>(agency: A, on?: string): AgencyRates[A] => versionOn(agency, on).rates;

/** Adds a version. Replaces one with the same effective date (a correction before it applies). */
export function addVersion<A extends Agency>(agency: A, input: { effectiveFrom: string; source: string; rates: AgencyRates[A] }, actor: string): RateVersion<A> {
  const v: RateVersion<A> = { id: `${agency}-${Date.now().toString(36)}`, ...input, source: input.source.trim(), savedBy: actor, savedAt: new Date().toISOString() };
  const kept = (book[agency] as RateVersion<A>[]).filter((x) => x.effectiveFrom !== input.effectiveFrom);
  book = { ...book, [agency]: [...kept, v] };
  try {
    localStorage.setItem(KEY, JSON.stringify(book));
  } catch {
    // Not saved across reloads; fine in the prototype.
  }
  return v;
}

/** Removes a version that hasn't taken effect yet. Versions already in force stay for the record. */
export function removeVersion(agency: Agency, id: string) {
  const v = book[agency].find((x) => x.id === id);
  if (!v || v.effectiveFrom <= todayIso() || book[agency].length === 1) return false;
  book = { ...book, [agency]: book[agency].filter((x) => x.id !== id) } as RateBook;
  try {
    localStorage.setItem(KEY, JSON.stringify(book));
  } catch {
    // As above.
  }
  return true;
}

/** Non-taxable ceiling for 13th month and other benefits. */
export const THIRTEENTH_MONTH_EXEMPT = 90_000;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Monthly Salary Credit: the ₱500 bracket the pay falls in, within the floor and ceiling. */
export function sssMsc(monthly: number, on?: string) {
  const r = ratesOn("sss", on);
  if (monthly <= 0) return 0;
  const msc = Math.round(monthly / r.mscStep) * r.mscStep;
  return Math.min(r.mscMax, Math.max(r.mscMin, msc));
}

/** Monthly SSS: employee share, employer share and Employees' Compensation (employer only). */
export function sss(monthly: number, on?: string) {
  const r = ratesOn("sss", on);
  const msc = sssMsc(monthly, on);
  if (!msc) return { msc: 0, ee: 0, er: 0, ec: 0 };
  return { msc, ee: round2(msc * r.eeRate), er: round2(msc * r.erRate), ec: msc < r.ecThreshold ? r.ecLow : r.ecHigh };
}

/** Monthly PhilHealth premium, split 50/50. */
export function philhealth(monthly: number, on?: string) {
  if (monthly <= 0) return { ee: 0, er: 0 };
  const r = ratesOn("philhealth", on);
  const half = round2((Math.min(r.ceiling, Math.max(r.floor, monthly)) * r.rate) / 2);
  return { ee: half, er: half };
}

/** Monthly Pag-IBIG, on pay up to the Maximum Fund Salary. */
export function pagibig(monthly: number, on?: string) {
  if (monthly <= 0) return { ee: 0, er: 0 };
  const r = ratesOn("pagibig", on);
  const base = Math.min(monthly, r.maxFundSalary);
  return { ee: round2(base * (monthly <= r.lowLimit ? r.eeLowRate : r.eeRate)), er: round2(base * r.erRate) };
}

/** Withholding tax on taxable pay, from the BIR table in force on a date (default today). */
export function withholding(taxable: number, period: "monthly" | "semi-monthly", on?: string) {
  const r = ratesOn("bir", on);
  const table = period === "monthly" ? r.monthly : r.semiMonthly;
  // The highest bracket the pay is over.
  const b = [...table].sort((x, y) => y.over - x.over).find((x) => taxable > x.over);
  return b ? round2(b.base + (taxable - b.over) * b.rate) : 0;
}
