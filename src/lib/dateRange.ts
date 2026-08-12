import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

// One place that turns `?from=&to=` into the window every period-based metric
// runs on, plus the comparison window it's measured against. Every calc module
// takes the same resolved object so that two cards on the same screen can
// never silently be reporting different periods.

export interface ResolvedRange {
  from: Date;
  to: Date;
  priorFrom: Date;
  priorTo: Date;
  // True when the caller passed no range at all. Two things hang off this:
  // the comparison semantics below, and whether a MetricSnapshot row gets
  // written (see the note on persistence at the bottom of this comment).
  isDefault: boolean;
  // What the prior window actually represents, so the UI can label the delta
  // truthfully instead of always claiming "vs last month".
  comparison: "previous_month" | "previous_period";
  // The calendar both windows were cut on. Carried here so a response can state
  // the days it actually used rather than leaving a browser in another timezone
  // to re-derive them from UTC instants and land a day out.
  timeZone: string;
}

/**
 * Both windows, as days on the organisation's own calendar.
 *
 * A card that says "₹43,554 vs ₹1,16,798" and nothing else is asking the reader
 * to trust a comparison whose boundaries it will not disclose — and the two
 * windows are NOT always the same length (a month-to-date on 31 March is
 * compared against 1–28 February, because February has no 31st). Stating the
 * dates is what makes that visible instead of misleading.
 */
export function describeRange(range: ResolvedRange) {
  const tz = range.timeZone;
  const dayCount = (a: Date, b: Date) =>
    Math.max(1, Math.round((b.getTime() - a.getTime()) / 86_400_000 + 0.5));
  return {
    start: range.from.toISOString(),
    end: range.to.toISOString(),
    startDay: zonedDayKey(range.from, tz),
    endDay: zonedDayKey(range.to, tz),
    days: dayCount(range.from, range.to),
    timeZone: tz,
    isDefault: range.isDefault,
    comparison: range.comparison,
    comparedTo: {
      start: range.priorFrom.toISOString(),
      end: range.priorTo.toISOString(),
      startDay: zonedDayKey(range.priorFrom, tz),
      endDay: zonedDayKey(range.priorTo, tz),
      days: dayCount(range.priorFrom, range.priorTo),
    },
  };
}

// ISO calendar date (YYYY-MM-DD). Deliberately not accepting full timestamps:
// a founder picking "1 Aug to 8 Aug" means whole days, and letting a caller
// pass an arbitrary instant would make two cards disagree by hours depending
// on when each request was built.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  // Round-trip, not just Date.parse: JS silently rolls invalid calendar dates
  // over ("2026-02-30" becomes 2 March), so parsing alone would accept a
  // nonsense date and quietly shift the window. Requiring the parsed date to
  // re-serialise to the same string is what actually rejects it.
  .refine((s) => {
    const parsed = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s;
  }, "not a real calendar date");

export const dateRangeQuerySchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  // Both or neither. One alone is ambiguous — an open-ended "from 1 Aug" would
  // quietly mean something different on every subsequent day.
  .refine((q) => (q.from == null) === (q.to == null), {
    message: "from and to must be supplied together",
  });

// Two years. Not a performance guard so much as a correctness one: these calcs
// load rows into memory to sum them (see modules/calc/*), so an unbounded range
// on a large catalogue is a heap problem, and no card on this product asks a
// question spanning more than a couple of years.
const MAX_RANGE_DAYS = 730;

// §3. Windows are cut on the organisation's own calendar, not UTC. A merchant
// in Delhi picking "Today" means midnight-to-now in Delhi; cutting that on UTC
// starts the day at 05:30 IST and drops every order taken in the first 5½ hours
// — measured on 8 Aug 2026, that was 4 of 50 orders and 26% of the day's
// revenue, and it dragged AOV from ₹1,037 down to ₹856.
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

// How far the zone is ahead of UTC at a given instant, via Intl rather than a
// hard-coded +5:30 — so a merchant on a DST-observing zone still gets correct
// boundaries either side of a transition.
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value);
  const asIfUtc = Date.UTC(f.year!, f.month! - 1, f.day!, f.hour! % 24, f.minute!, f.second!);
  // Compared against the instant truncated to the second, because Intl only
  // reports down to seconds. Without this the sub-second part of the instant
  // leaks into the offset and the boundary lands ~1s late — enough for the end
  // of one day and the start of the next to overlap and double-count an order.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// The UTC instant of a wall-clock time in `timeZone`. Applied twice because the
// offset itself depends on the instant: the first pass lands near the right
// moment, the second corrects it if that landing crossed a DST boundary. IST
// has no DST, so the second pass is a no-op there and matters only for others.
export function zonedTimeToUtc(
  y: number, m: number, d: number, hh: number, mm: number, ss: number, ms: number,
  timeZone: string
): Date {
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  let instant = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  instant = new Date(naive - zoneOffsetMs(instant, timeZone));
  return instant;
}

// Today's calendar date as the organisation sees it.
export function zonedParts(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
  const [y, m, d] = p.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

export function startOfZonedDay(iso: string, timeZone: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return zonedTimeToUtc(y!, m!, d!, 0, 0, 0, 0, timeZone);
}

// "YYYY-MM-DD" as the organisation's calendar reads it. The forecast buckets
// orders and projects days by this, never by UTC date — a 01:00 IST order
// belongs to the merchant's today, not to UTC's yesterday.
export function zonedDayKey(instant: Date, timeZone: string): string {
  const { y, m, d } = zonedParts(instant, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Calendar-day arithmetic on a zoned day key, without ever constructing a
// local Date — adding 86,400,000 ms to a timestamp is not the same as adding a
// day, and drifts across a DST boundary.
export function addZonedDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function endOfZonedDay(iso: string, timeZone: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return zonedTimeToUtc(y!, m!, d!, 23, 59, 59, 999, timeZone);
}

// The no-parameters case reproduces exactly what every metric did before date
// filtering existed: month-to-date, compared against the same slice of the
// previous month. Kept identical on purpose — the existing cards are verified
// against real data, and quietly changing what "vs last month" means would
// invalidate that without anyone noticing.
// How many days the month BEFORE (y, m) has. Day 0 of a month is the last day
// of the one before it, which is the standard way to ask this without a leap
// year table — Date.UTC also normalises m = 0 back into the previous December.
function daysInPreviousMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
}

function defaultRange(now: Date, timeZone: string): ResolvedRange {
  // "This month" and "the same slice of last month" are both read off the
  // organisation's calendar — on 1 August at 02:00 IST it is still July in UTC,
  // and a month-to-date card that answered for July would be indefensible.
  const { y, m, d } = zonedParts(now, timeZone);

  // There is no 31 February. Asking for one used to roll forward silently —
  // on 31 March the "previous month" window ran 1 Feb → 3 MARCH, 31 days long
  // and containing three days of the very month it was being compared against.
  // It fired on 29/30/31 March and on the 31st of May, July, October and
  // December: about seven days a year, every one of them a month boundary,
  // which is precisely when someone is looking at a month-on-month card.
  //
  // Clamped to the last real day of the previous month instead. That makes the
  // prior window SHORTER than the current one on those days (1–28 Feb against
  // 1–31 Mar), which is honest and visible, rather than longer and wrong. The
  // response states both windows so a reader can see it.
  const priorDay = Math.min(d, daysInPreviousMonth(y, m));

  return {
    from: zonedTimeToUtc(y, m, 1, 0, 0, 0, 0, timeZone),
    to: now,
    priorFrom: zonedTimeToUtc(y, m - 1, 1, 0, 0, 0, 0, timeZone),
    priorTo: zonedTimeToUtc(y, m - 1, priorDay, 23, 59, 59, 999, timeZone),
    isDefault: true,
    comparison: "previous_month",
    timeZone,
  };
}

export function resolveDateRange(
  query: unknown,
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): ResolvedRange {
  const parsed = dateRangeQuerySchema.parse(query);
  if (parsed.from == null || parsed.to == null) return defaultRange(now, timeZone);

  const from = startOfZonedDay(parsed.from, timeZone);
  const to = endOfZonedDay(parsed.to, timeZone);

  if (to < from) {
    throw new z.ZodError([
      { code: "custom", path: ["to"], message: "to must be on or after from" },
    ]);
  }

  const spanMs = to.getTime() - from.getTime();
  if (spanMs > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    throw new z.ZodError([
      { code: "custom", path: ["from"], message: `range must not exceed ${MAX_RANGE_DAYS} days` },
    ]);
  }

  // The immediately preceding window of identical length. For an explicit
  // range this is the only comparison that holds regardless of what was
  // picked — a calendar-month comparison is meaningless against "last 7 days".
  const priorTo = new Date(from.getTime() - 1);
  const priorFrom = new Date(priorTo.getTime() - spanMs);

  return { from, to, priorFrom, priorTo, isDefault: false, comparison: "previous_period", timeZone };
}

// MetricSnapshot exists to make the canonical numbers reproducible and
// versioned — it is not a cache of whatever range someone happened to drag a
// picker to. Writing a row per ad-hoc exploration would fill the table with
// overlapping periods that no longer mean "the value of this metric for this
// month", which is what every consumer of that table assumes. So snapshots are
// written for the default period only; custom ranges compute and return
// without persisting.
export function shouldPersistSnapshot(range: ResolvedRange): boolean {
  return range.isDefault;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      dateRange?: ResolvedRange;
    }
  }
}

// Parsing happens in SYNCHRONOUS middleware, not inline inside each async route
// handler, and that is load-bearing rather than stylistic. This project is on
// Express 4 (see package.json) with no express-async-errors and no asyncHandler
// wrapper, so a throw inside an `async (req, res) => {}` handler does not reach
// middleware/errorHandler.ts — it becomes an unhandled promise rejection and
// the request hangs until the client gives up. Verified directly: an async
// handler throwing a ZodError produced no response at all, while the same throw
// from sync middleware returns the intended 400.
//
// So: parse here, hand the failure to next(err) — which errorHandler *does*
// see — and let the async handler read the already-validated req.dateRange.
// The organisation's timezone comes off req.auth, which requireAuth has already
// resolved — this middleware always runs after it. Falling back to the default
// rather than throwing keeps any unauthenticated path working; the fallback is
// IST, which is where this product's merchants are.
export function withDateRange(req: Request, _res: Response, next: NextFunction) {
  try {
    req.dateRange = resolveDateRange(req.query, new Date(), req.auth?.timezone ?? DEFAULT_TIMEZONE);
    next();
  } catch (err) {
    next(err);
  }
}
