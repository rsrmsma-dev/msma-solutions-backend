// National holidays, shared by Timekeeping and Leave. The list is proclaimed
// each year; verify against the proclamation before relying on it for pay.

export interface Holiday {
  date: string;
  name: string;
  type: "regular" | "special";
  source: string;
}

/** The proclaimed national holidays. */
const NATIONAL: Holiday[] = [
  { date: "2026-01-01", name: "New Year's Day", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-02-17", name: "Chinese New Year", type: "special", source: "Proclamation (2026 holidays)" },
  { date: "2026-04-02", name: "Maundy Thursday", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-04-03", name: "Good Friday", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-04-04", name: "Black Saturday", type: "special", source: "Proclamation (2026 holidays)" },
  { date: "2026-04-09", name: "Araw ng Kagitingan", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-05-01", name: "Labor Day", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-06-12", name: "Independence Day", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-08-21", name: "Ninoy Aquino Day", type: "special", source: "Proclamation (2026 holidays)" },
  { date: "2026-08-31", name: "National Heroes Day", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-11-01", name: "All Saints' Day", type: "special", source: "Proclamation (2026 holidays)" },
  { date: "2026-11-30", name: "Bonifacio Day", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-12-08", name: "Feast of the Immaculate Conception", type: "special", source: "Proclamation (2026 holidays)" },
  { date: "2026-12-24", name: "Christmas Eve", type: "special", source: "Proclamation (2026 holidays)" },
  { date: "2026-12-25", name: "Christmas Day", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-12-30", name: "Rizal Day", type: "regular", source: "Proclamation (2026 holidays)" },
  { date: "2026-12-31", name: "Last day of the year", type: "special", source: "Proclamation (2026 holidays)" },
];

// Company holidays HR adds in Settings > Time off & leave (e.g. a founding day, a local holiday).
const CUSTOM_KEY = "heyhr-custom-holidays-v1";
function loadCustom(): Holiday[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    return raw ? (JSON.parse(raw) as Holiday[]) : [];
  } catch {
    return [];
  }
}

/**
 * Every holiday Timekeeping and Leave count: national plus the company's own. One array that
 * changes in place, so everything holding it sees added or removed holidays.
 */
export const HOLIDAYS: Holiday[] = [];
function rebuild(custom: Holiday[]) {
  HOLIDAYS.splice(0, HOLIDAYS.length, ...[...NATIONAL, ...custom].sort((a, b) => a.date.localeCompare(b.date)));
}
rebuild(loadCustom());

export const isCustomHoliday = (h: Holiday) => h.source === "Company";
export const customHolidays = () => HOLIDAYS.filter(isCustomHoliday);

export function setCustomHolidays(next: Holiday[]) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  } catch {
    // Not remembered after reload; still applies now.
  }
  rebuild(next);
}

export const holidayOn = (date: string) => HOLIDAYS.find((h) => h.date === date);
