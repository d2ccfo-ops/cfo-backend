import { DEFAULT_TIMEZONE, endOfZonedDay, startOfZonedDay, zonedParts } from "../../lib/dateRange.js";

// §20.14's prerequisite (P5.3): report periods that respect the financial year.
//
// An Indian company reports April to March. A report that quietly used the
// calendar year would put Q4 in the wrong year for every customer this product
// is built for, and — worse — would do it silently: the numbers would all be
// real, correctly computed, and labelled with a year they do not belong to.
// That is a harder error to notice than a wrong figure.
//
// Pure, and tested exhaustively across the boundary, because every off-by-one
// here is a whole quarter in the wrong place.

export const DEFAULT_FISCAL_START_MONTH = 4; // April, the Indian FY

export interface FiscalPeriod {
  /** "FY2026-27", "Q3 FY2026-27", "August 2026". */
  label: string;
  /** Machine key: "2026-27", "2026-27-Q3", "2026-08". */
  key: string;
  from: Date;
  to: Date;
}

/**
 * Which financial year a given instant falls in.
 *
 * Returns the STARTING calendar year. With an April start, 2026-03-31 is in
 * FY2025-26 and 2026-04-01 is in FY2026-27.
 */
export function fiscalYearOf(instant: Date, startMonth: number, timeZone: string = DEFAULT_TIMEZONE): number {
  const { y, m } = zonedParts(instant, timeZone);
  return m >= startMonth ? y : y - 1;
}

export function fiscalYearLabel(startYear: number, startMonth: number): string {
  // A January fiscal start is the calendar year, and writing it as "FY2026-27"
  // would be wrong rather than merely odd.
  if (startMonth === 1) return `FY${startYear}`;
  return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function monthStart(year: number, month: number, timeZone: string): Date {
  return startOfZonedDay(`${year}-${String(month).padStart(2, "0")}-01`, timeZone);
}

function monthEnd(year: number, month: number, timeZone: string): Date {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  // Last instant of the day before the next month starts. Computed from the
  // next month rather than from a days-in-month table, so February and leap
  // years need no special case.
  const firstOfNext = monthStart(nextYear, nextMonth, timeZone);
  const lastDay = new Date(firstOfNext.getTime() - 1);
  const parts = zonedParts(lastDay, timeZone);
  return endOfZonedDay(`${parts.y}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`, timeZone);
}

export function fiscalYearPeriod(startYear: number, startMonth: number, timeZone: string = DEFAULT_TIMEZONE): FiscalPeriod {
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  return {
    label: fiscalYearLabel(startYear, startMonth),
    key: startMonth === 1 ? String(startYear) : `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    from: monthStart(startYear, startMonth, timeZone),
    to: monthEnd(endYear, endMonth, timeZone),
  };
}

/** Q1..Q4 of a financial year, where Q1 begins at the fiscal start month. */
export function fiscalQuarterPeriod(
  startYear: number,
  startMonth: number,
  quarter: 1 | 2 | 3 | 4,
  timeZone: string = DEFAULT_TIMEZONE
): FiscalPeriod {
  const offset = (quarter - 1) * 3;
  const rawStart = startMonth + offset;
  const qStartMonth = ((rawStart - 1) % 12) + 1;
  const qStartYear = startYear + Math.floor((rawStart - 1) / 12);

  const rawEnd = rawStart + 2;
  const qEndMonth = ((rawEnd - 1) % 12) + 1;
  const qEndYear = startYear + Math.floor((rawEnd - 1) / 12);

  return {
    label: `Q${quarter} ${fiscalYearLabel(startYear, startMonth)}`,
    key: `${startMonth === 1 ? startYear : `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`}-Q${quarter}`,
    from: monthStart(qStartYear, qStartMonth, timeZone),
    to: monthEnd(qEndYear, qEndMonth, timeZone),
  };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthPeriod(year: number, month: number, timeZone: string = DEFAULT_TIMEZONE): FiscalPeriod {
  return {
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    key: `${year}-${String(month).padStart(2, "0")}`,
    from: monthStart(year, month, timeZone),
    to: monthEnd(year, month, timeZone),
  };
}

/**
 * The periods a report can be run for, newest first.
 *
 * Offered rather than free-form, because a report is a document someone files
 * — "the August P&L" and "1 Aug to 30 Aug" are different things, and the
 * second one is how a figure ends up defensible only to the person who ran it.
 * A custom range is still accepted by the route; these are what the UI lists.
 */
export function availablePeriods(
  now: Date,
  startMonth: number,
  timeZone: string = DEFAULT_TIMEZONE,
  count = 8
): FiscalPeriod[] {
  const out: FiscalPeriod[] = [];
  const { y, m } = zonedParts(now, timeZone);

  // Months, most recent first, including the current (partial) one.
  let ry = y;
  let rm = m;
  for (let i = 0; i < count; i += 1) {
    out.push(monthPeriod(ry, rm, timeZone));
    rm -= 1;
    if (rm === 0) {
      rm = 12;
      ry -= 1;
    }
  }

  const fy = fiscalYearOf(now, startMonth, timeZone);
  for (const q of [4, 3, 2, 1] as const) {
    const period = fiscalQuarterPeriod(fy, startMonth, q, timeZone);
    // A quarter that has not begun is not a period anyone can report on, and
    // listing it would produce an empty report that looks like a bad month.
    if (period.from <= now) out.push(period);
  }
  out.push(fiscalYearPeriod(fy, startMonth, timeZone));
  out.push(fiscalYearPeriod(fy - 1, startMonth, timeZone));

  return out;
}
