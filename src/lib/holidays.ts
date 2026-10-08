// National holidays, shared by Timekeeping and Leave. The list is proclaimed
// each year; verify against the proclamation before relying on it for pay.

export interface Holiday {
  date: string;
  name: string;
  type: "regular" | "special";
  source: string;
}

export const HOLIDAYS: Holiday[] = [
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

export const holidayOn = (date: string) => HOLIDAYS.find((h) => h.date === date);
