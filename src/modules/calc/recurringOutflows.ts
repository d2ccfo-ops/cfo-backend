// P2.2e — the fixed costs a business pays whether or not it sells anything.
//
// Until now the forecast saw operating spend only as a flat daily run-rate
// derived from measured Expense history. That is defensible for ad-hoc spend
// and wrong for the three biggest outflows a D2C brand has: payroll, rent and
// EMI. They are not a rate, they are a DATE — ₹4L leaves the account on the
// 1st, not ₹13,333 leaving every day — and on a 90-day horizon the difference
// between those two descriptions is the difference between seeing a cash
// crunch and not seeing it. Worse, an organisation with no accounting
// connection has no Expense rows at all, so its run-rate is ₹0 and payroll is
// silently absent from a projection that otherwise looks complete.
//
// Everything here is pure calendar arithmetic over "YYYY-MM-DD" day keys. No
// database, no timezone conversion: a day key is a LABEL for a day on the
// organisation's calendar, already resolved by the caller, so UTC arithmetic
// on its parts is exact and cannot drift across a DST boundary the way adding
// 86,400,000ms to a timestamp does.

export const RECURRING_OUTFLOW_CATEGORIES = ["SALARY", "RENT", "EMI", "SUBSCRIPTION", "TAX", "OTHER"] as const;
export type RecurringOutflowCategory = (typeof RECURRING_OUTFLOW_CATEGORIES)[number];

export const RECURRING_CADENCES = ["WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL"] as const;
export type RecurringCadence = (typeof RECURRING_CADENCES)[number];

export interface RecurringOutflow {
  /** Stable identifier so an entry can be edited without being re-created. */
  id: string;
  label: string;
  category: RecurringOutflowCategory;
  /** Paise, as a string — the same wire convention as every other money value. */
  amountPaise: string;
  cadence: RecurringCadence;
  /** 1–31, for MONTHLY / QUARTERLY / ANNUAL. Clamped to the month's length. */
  dayOfMonth?: number;
  /** 0 (Sunday) – 6, for WEEKLY. */
  weekday?: number;
  /** 1–12. The anchor month for ANNUAL, and the first month of the cycle for QUARTERLY. */
  month?: number;
  /** Optional YYYY-MM-DD bounds — a salary that started in June, an EMI that ends in March. */
  startDay?: string;
  endDay?: string;
}

export interface Occurrence {
  day: string;
  amountPaise: bigint;
  entryId: string;
  label: string;
  category: RecurringOutflowCategory;
  /**
   * True when dayOfMonth was clamped because the month is shorter — a "pay on
   * the 31st" entry landing on 28 February. Surfaced rather than silently
   * adjusted, because the alternative reading (skip the month) would drop a
   * rent payment entirely and nobody would notice.
   */
  clamped?: true;
}

function parts(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

function key(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Day 0 of month m+1 is the last day of month m. */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The weekday of a day key, 0 = Sunday. */
function weekdayOf(day: string): number {
  const { y, m, d } = parts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * A cadence expressed as the amount it costs in a typical month.
 *
 * Used only to offset the measured expense run-rate (see cashForecast.ts) —
 * never to place money on a day. Integer maths throughout: a weekly bill is
 * 52/12 of a month, not "about 4.33 times".
 */
export function monthlyEquivalent(entry: RecurringOutflow): bigint {
  const amount = BigInt(entry.amountPaise || "0");
  switch (entry.cadence) {
    case "WEEKLY":
      return (amount * 52n) / 12n;
    case "MONTHLY":
      return amount;
    case "QUARTERLY":
      return amount / 3n;
    case "ANNUAL":
      return amount / 12n;
  }
}

/**
 * Every time this entry is paid between `fromDay` and `toDay`, inclusive.
 *
 * The month-length rule is the interesting one. An entry set to the 31st has
 * no 31st to land on in February, and the two available readings are opposite:
 * skip the month, or pay on the last day. This clamps to the last day, because
 * skipping means a rent payment vanishes from the forecast for a month and the
 * line quietly looks better than reality — the exact failure this whole item
 * exists to fix. The clamp is flagged on the occurrence so a caller can say so.
 */
export function occurrencesInRange(entry: RecurringOutflow, fromDay: string, toDay: string): Occurrence[] {
  const amountPaise = BigInt(entry.amountPaise || "0");
  if (amountPaise <= 0n || fromDay > toDay) return [];

  // The entry's own lifetime narrows the window before any dates are
  // generated, so an EMI that ended last March produces nothing at all rather
  // than a list that has to be filtered afterwards.
  const from = entry.startDay && entry.startDay > fromDay ? entry.startDay : fromDay;
  const to = entry.endDay && entry.endDay < toDay ? entry.endDay : toDay;
  if (from > to) return [];

  const out: Occurrence[] = [];
  const emit = (day: string, clamped: boolean) => {
    if (day < from || day > to) return;
    out.push({
      day,
      amountPaise,
      entryId: entry.id,
      label: entry.label,
      category: entry.category,
      ...(clamped ? { clamped: true as const } : {}),
    });
  };

  if (entry.cadence === "WEEKLY") {
    const weekday = entry.weekday ?? 1; // Monday when unset
    const start = parts(from);
    const end = parts(to);
    const startMs = Date.UTC(start.y, start.m - 1, start.d);
    const endMs = Date.UTC(end.y, end.m - 1, end.d);
    for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
      const day = new Date(ms).toISOString().slice(0, 10);
      if (weekdayOf(day) === weekday) emit(day, false);
    }
    return out;
  }

  // Monthly, quarterly and annual all land on a day-of-month within some set
  // of months, so they share one walk over the calendar months the window
  // touches. Walking months rather than days is what keeps a 90-day horizon at
  // three iterations instead of ninety.
  const dayOfMonth = entry.dayOfMonth ?? 1;
  const anchorMonth = entry.month ?? 1;
  const start = parts(from);
  const end = parts(to);

  for (let y = start.y, m = start.m; y < end.y || (y === end.y && m <= end.m); ) {
    let applies: boolean;
    switch (entry.cadence) {
      case "MONTHLY":
        applies = true;
        break;
      case "QUARTERLY":
        // Every third month from the anchor, in either direction — (m − anchor)
        // mod 3, made non-negative so an anchor later in the year than the
        // window still produces the right months.
        applies = (((m - anchorMonth) % 3) + 3) % 3 === 0;
        break;
      case "ANNUAL":
        applies = m === anchorMonth;
        break;
    }

    if (applies) {
      const last = daysInMonth(y, m);
      const landed = Math.min(dayOfMonth, last);
      emit(key(y, m, landed), landed !== dayOfMonth);
    }

    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  return out;
}

export interface ExpandedSchedule {
  /** Day key → total paise scheduled to leave that day. */
  byDay: Map<string, bigint>;
  occurrences: Occurrence[];
  totalPaise: bigint;
  /** Sum of every entry's typical-month cost, for the run-rate offset. */
  monthlyEquivalentPaise: bigint;
  /** Entries that produced a clamped date, so the caller can explain it. */
  clampedLabels: string[];
}

export function expandSchedule(
  entries: readonly RecurringOutflow[],
  fromDay: string,
  toDay: string
): ExpandedSchedule {
  const byDay = new Map<string, bigint>();
  const occurrences: Occurrence[] = [];
  let totalPaise = 0n;
  let monthlyEquivalentPaise = 0n;
  const clamped = new Set<string>();

  for (const entry of entries) {
    monthlyEquivalentPaise += monthlyEquivalent(entry);
    for (const o of occurrencesInRange(entry, fromDay, toDay)) {
      occurrences.push(o);
      byDay.set(o.day, (byDay.get(o.day) ?? 0n) + o.amountPaise);
      totalPaise += o.amountPaise;
      if (o.clamped) clamped.add(o.label);
    }
  }

  // Sorted so a response lists payments in the order they happen, not in the
  // order the entries were configured.
  occurrences.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  return { byDay, occurrences, totalPaise, monthlyEquivalentPaise, clampedLabels: [...clamped] };
}
