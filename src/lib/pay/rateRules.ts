// Government contribution rate rules shared by the browser and the API server
// (server/src/payroll.ts): the built-in tables, what each rate field means, and
// the checks a new version must pass. Imports nothing that touches browser storage.

import type { Agency, AgencyRates, BirRates, RateBook, RateVersion, TaxBracket } from "../reports/statutory";

export const BUILT_IN_RATES: RateBook = {
  sss: [{ id: "sss-2025", effectiveFrom: "2025-01-01", source: "SSS contribution schedule 2025 (sss.gov.ph)", savedBy: "Built in", savedAt: "2026-09-01T00:00:00", rates: { eeRate: 0.05, erRate: 0.1, mscMin: 5000, mscMax: 35000, mscStep: 500, ecLow: 10, ecHigh: 30, ecThreshold: 15000 } }],
  philhealth: [{ id: "ph-2024", effectiveFrom: "2024-01-01", source: "PhilHealth premium schedule (philhealth.gov.ph)", savedBy: "Built in", savedAt: "2026-09-01T00:00:00", rates: { rate: 0.05, floor: 10000, ceiling: 100000 } }],
  pagibig: [{ id: "pi-2024", effectiveFrom: "2024-02-01", source: "HDMF Circular (pagibigfund.gov.ph)", savedBy: "Built in", savedAt: "2026-09-01T00:00:00", rates: { eeRate: 0.02, eeLowRate: 0.01, lowLimit: 1500, erRate: 0.02, maxFundSalary: 10000 } }],
  bir: [
    {
      id: "bir-2023",
      effectiveFrom: "2023-01-01",
      source: "BIR withholding tax table, RR 11-2018 as amended (TRAIN)",
      savedBy: "Built in",
      savedAt: "2026-09-01T00:00:00",
      rates: {
        monthly: [
          { over: 20_833, base: 0, rate: 0.15 },
          { over: 33_333, base: 1_875, rate: 0.2 },
          { over: 66_667, base: 8_541.8, rate: 0.25 },
          { over: 166_667, base: 33_541.8, rate: 0.3 },
          { over: 666_667, base: 183_541.8, rate: 0.35 },
        ],
        semiMonthly: [
          { over: 10_417, base: 0, rate: 0.15 },
          { over: 16_667, base: 937.5, rate: 0.2 },
          { over: 33_333, base: 4_270.7, rate: 0.25 },
          { over: 83_333, base: 16_770.7, rate: 0.3 },
          { over: 333_333, base: 91_770.7, rate: 0.35 },
        ],
      },
    },
  ],
};

/** What is wrong with a tax table, if anything. */
function checkBrackets(rows: TaxBracket[]) {
  if (!rows.length) return "add at least one bracket";
  for (const r of rows) {
    if (![r.over, r.base, r.rate].every((n) => Number.isFinite(n) && n >= 0)) return "every amount must be a number, 0 or more";
    if (r.rate > 0.6) return "a rate looks too high; enter it as a percent, for example 15 for 15%";
  }
  for (let i = 1; i < rows.length; i++) if (rows[i]!.over <= rows[i - 1]!.over) return "brackets must go from lowest to highest pay";
  return null;
}

export const AGENCIES: { id: Agency; label: string }[] = [
  { id: "sss", label: "SSS" },
  { id: "philhealth", label: "PhilHealth" },
  { id: "pagibig", label: "Pag-IBIG" },
  { id: "bir", label: "BIR tax" },
];

export type FieldKind = "pct" | "peso";
export interface RateField {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
}

/** What each agency's rates mean, in the order the page shows them. */
export const RATE_FIELDS: { [A in Agency]: (RateField & { key: keyof AgencyRates[A] & string })[] } = {
  sss: [
    { key: "eeRate", label: "Employee share", kind: "pct", hint: "Of the monthly salary credit" },
    { key: "erRate", label: "Employer share", kind: "pct", hint: "Of the monthly salary credit" },
    { key: "mscMin", label: "Lowest salary credit", kind: "peso" },
    { key: "mscMax", label: "Highest salary credit", kind: "peso" },
    { key: "mscStep", label: "Salary credit step", kind: "peso", hint: "Pay is rounded to this bracket" },
    { key: "ecThreshold", label: "EC: higher rate from", kind: "peso", hint: "Salary credit where EC switches" },
    { key: "ecLow", label: "EC below that", kind: "peso", hint: "Employer only, per month" },
    { key: "ecHigh", label: "EC from that", kind: "peso", hint: "Employer only, per month" },
  ],
  philhealth: [
    { key: "rate", label: "Premium rate", kind: "pct", hint: "Split 50/50 between employee and employer" },
    { key: "floor", label: "Salary floor", kind: "peso" },
    { key: "ceiling", label: "Salary ceiling", kind: "peso" },
  ],
  pagibig: [
    { key: "eeRate", label: "Employee share", kind: "pct" },
    { key: "eeLowRate", label: "Employee share, low earners", kind: "pct" },
    { key: "lowLimit", label: "Low earner limit", kind: "peso", hint: "Monthly pay up to this uses the low rate" },
    { key: "erRate", label: "Employer share", kind: "pct" },
    { key: "maxFundSalary", label: "Maximum fund salary", kind: "peso", hint: "Contributions stop growing above this" },
  ],
  // Tax brackets are a table, edited row by row on the page.
  bir: [],
};

/** What's wrong with a new rate version, or null. `existing` are the agency's saved versions; `today` is yyyy-mm-dd. */
export function rateProblem<A extends Agency>(agency: A, input: { effectiveFrom: string; source: string; rates: AgencyRates[A] }, existing: RateVersion<A>[], today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) return "Choose the date these rates take effect";
  if (!input.source.trim()) return "Name the source, for example the circular number";
  const rates = input.rates as unknown as Record<string, number>;
  for (const f of RATE_FIELDS[agency] as RateField[]) {
    const v = rates[f.key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `Enter a valid ${f.label.toLowerCase()}`;
    if (f.kind === "pct" && v > 0.5) return `${f.label} looks too high. Enter it as a percent, for example 5 for 5%`;
  }
  if (agency === "sss" && (rates.mscMin! >= rates.mscMax! || rates.mscStep! <= 0)) return "Check the salary credit range and step";
  if (agency === "philhealth" && rates.floor! >= rates.ceiling!) return "The salary floor must be below the ceiling";
  if (agency === "bir") {
    const bir = input.rates as unknown as BirRates;
    for (const [name, table] of [["Monthly", bir.monthly], ["Semi-monthly", bir.semiMonthly]] as const) {
      const problem = checkBrackets(table);
      if (problem) return `${name} table: ${problem}`;
    }
  }
  const current = [...existing].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)).find((v) => v.effectiveFrom <= today);
  if (current && input.effectiveFrom < current.effectiveFrom) return `Rates from ${current.effectiveFrom} already apply. New rates must take effect on or after that date.`;
  return null;
}
