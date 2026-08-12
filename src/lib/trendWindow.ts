import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  DEFAULT_TIMEZONE,
  addZonedDays,
  startOfZonedDay,
  zonedDayKey,
  zonedParts,
} from "./dateRange.js";

// The window a TREND chart is drawn over, which is a different question from
// the window a metric CARD is computed over (lib/dateRange.ts).
//
// A card answers "what was net revenue in the period I picked". A trend answers
// "how has it moved", and it needs two things the card window cannot give it:
// a bucket size, and the freedom to be zoomed independently of the page's date
// filter. The Overview's 6-month trend deliberately ignores the date picker for
// exactly that reason — a "trend" that collapses to the picked week shows one
// point and tells you nothing.
//
// Zooming is what makes this its own module: the client sends a window, the
// server decides the bucket size and says which one it used. Putting that
// decision on the server means the labels, the boundaries and the bucket count
// are all derived in one place; a client that picked its own granularity would
// eventually disagree with the buckets it was sent.

export type TrendGranularity = "day" | "week" | "month";

export interface TrendWindow {
  from: Date;
  to: Date;
  granularity: TrendGranularity;
  // Whether the granularity was asked for or inferred from the span. Reported
  // to the client so the zoom control can show "auto" honestly.
  granularityWasAuto: boolean;
  timeZone: string;
  // True when the caller sent nothing — the trailing-6-month default that the
  // Overview and Revenue pages have always drawn.
  isDefault: boolean;
}

// Zooming in past a week of span stops being a trend and becomes a bar chart of
// one week, and every point below it is a single day that the Revenue page
// already lists. Zooming out past two years hits the same heap ceiling
// MAX_RANGE_DAYS guards in dateRange.ts, for the same reason: these calcs load
// orders into memory to run the ladder over them.
export const MIN_SPAN_DAYS = 7;
export const MAX_SPAN_DAYS = 730;

// A line with more points than the chart has pixels of width is a solid block,
// not a trend. When the requested granularity would exceed this the window is
// served one step coarser and says so, rather than returning 730 daily points
// that no screen can draw.
export const MAX_BUCKETS = 200;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const parsed = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s;
  }, "not a real calendar date");

export const trendWindowQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    // "auto" is the normal case: the client zooms by changing the SPAN and lets
    // the server pick the bucket. An explicit value exists so a caller can pin
    // one (the Revenue page's monthly view), and is still capped by MAX_BUCKETS.
    granularity: z.enum(["auto", "day", "week", "month"]).optional(),
  })
  .refine((q) => (q.from == null) === (q.to == null), {
    message: "from and to must be supplied together",
  });

export function spanDays(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

// The bucket size a span deserves. The boundaries are set so that the two
// windows people actually land on keep the shape they already know: a trailing
// 6 months (~183 days) stays monthly, and a single month zooms to daily.
export function autoGranularity(days: number): TrendGranularity {
  if (days <= 35) return "day";
  if (days <= 180) return "week";
  return "month";
}

const COARSER: Record<TrendGranularity, TrendGranularity | null> = {
  day: "week",
  week: "month",
  month: null,
};

function approximateBuckets(days: number, granularity: TrendGranularity): number {
  if (granularity === "day") return days;
  if (granularity === "week") return Math.ceil(days / 7);
  return Math.ceil(days / 28);
}

// Coarsen until the bucket count fits. Loops rather than stepping once because
// a 730-day window asked for daily buckets is two steps away from fitting.
function capBuckets(days: number, granularity: TrendGranularity): TrendGranularity {
  let g = granularity;
  while (approximateBuckets(days, g) > MAX_BUCKETS) {
    const next = COARSER[g];
    if (next === null) return g;
    g = next;
  }
  return g;
}

// Six months back from the current month start, on the org's calendar. This is
// the default window, and it reproduces exactly what getRevenueTrend drew
// before it could be zoomed — an untouched chart shows the same line it always
// did.
function trailingMonthsStart(now: Date, timeZone: string, months: number): Date {
  const { y, m } = zonedParts(now, timeZone);
  // Date.UTC normalises a month underflow (m - 6 going negative rolls the year
  // back), so this is safe across a year boundary without special-casing it.
  const shifted = new Date(Date.UTC(y, m - 1 - (months - 1), 1));
  const key = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return startOfZonedDay(key, timeZone);
}

export function resolveTrendWindow(
  query: unknown,
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
  defaultMonths = 6
): TrendWindow {
  const parsed = trendWindowQuerySchema.parse(query);

  if (parsed.from == null || parsed.to == null) {
    return {
      from: trailingMonthsStart(now, timeZone, defaultMonths),
      to: now,
      granularity: "month",
      granularityWasAuto: true,
      timeZone,
      isDefault: true,
    };
  }

  const from = startOfZonedDay(parsed.from, timeZone);
  // Exclusive-ish end: the start of the day AFTER `to`, minus a millisecond.
  // Bucketing then never has to reason about whether the final day is included.
  const to = new Date(startOfZonedDay(addZonedDays(parsed.to, 1), timeZone).getTime() - 1);

  if (to < from) {
    throw new z.ZodError([{ code: "custom", path: ["to"], message: "to must be on or after from" }]);
  }

  const days = spanDays(from, to);
  if (days < MIN_SPAN_DAYS) {
    throw new z.ZodError([
      { code: "custom", path: ["from"], message: `window must span at least ${MIN_SPAN_DAYS} days` },
    ]);
  }
  if (days > MAX_SPAN_DAYS) {
    throw new z.ZodError([
      { code: "custom", path: ["from"], message: `window must not exceed ${MAX_SPAN_DAYS} days` },
    ]);
  }

  const asked = parsed.granularity ?? "auto";
  const wasAuto = asked === "auto";
  const requested = wasAuto ? autoGranularity(days) : asked;
  const granularity = capBuckets(days, requested);

  return {
    from,
    to,
    granularity,
    // If the cap moved it, the client did not get what it asked for and the
    // control should stop claiming otherwise.
    granularityWasAuto: wasAuto || granularity !== requested,
    timeZone,
    isDefault: false,
  };
}

// The Monday on or before a zoned day key. Weeks start Monday because that is
// how an Indian D2C operator reads a week; a Sunday-start week would put a
// weekend sale spike at the start of one bucket and the end of another.
export function startOfZonedWeekKey(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0 = Sunday
  return addZonedDays(dayKey, -((dow + 6) % 7));
}

// Which bucket an instant belongs to, decided on the ORGANISATION's calendar.
// A 01:00 IST order belongs to the merchant's day, not to UTC's previous one —
// the same §3 rule the date filter follows, and it matters far more here,
// because at daily granularity a UTC cut moves 5½ hours of orders into the
// wrong point on the line.
export function bucketKeyFor(instant: Date, granularity: TrendGranularity, timeZone: string): string {
  const dayKey = zonedDayKey(instant, timeZone);
  if (granularity === "day") return dayKey;
  if (granularity === "week") return startOfZonedWeekKey(dayKey);
  return dayKey.slice(0, 7);
}

// Every bucket in the window, in order, including empty ones. Contiguity is the
// point: a gap in the data has to render as a gap in the line, which only works
// if the bucket exists and carries null.
export function enumerateBuckets(window: TrendWindow): { key: string; start: Date; end: Date }[] {
  const { granularity, timeZone } = window;
  const firstKey = bucketKeyFor(window.from, granularity, timeZone);
  const lastKey = bucketKeyFor(window.to, granularity, timeZone);

  const keys: string[] = [];
  if (granularity === "month") {
    let key = firstKey;
    for (let i = 0; i < 400; i += 1) {
      keys.push(key);
      if (key === lastKey) break;
      key = addZonedMonths(key, 1);
    }
  } else {
    const step = granularity === "week" ? 7 : 1;
    let key = firstKey;
    for (let i = 0; i < 1000; i += 1) {
      keys.push(key);
      if (key === lastKey) break;
      key = addZonedDays(key, step);
    }
  }

  return keys.map((key) => {
    const startKey = granularity === "month" ? `${key}-01` : key;
    const nextKey =
      granularity === "month"
        ? `${addZonedMonths(key, 1)}-01`
        : addZonedDays(startKey, granularity === "week" ? 7 : 1);
    return {
      key,
      start: startOfZonedDay(startKey, timeZone),
      // Inclusive end, one millisecond before the next bucket opens — so
      // "was the bank visible during this bucket" is decidable without the
      // caller having to know whether the boundary is open or closed.
      end: new Date(startOfZonedDay(nextKey, timeZone).getTime() - 1),
    };
  });
}

// "2026-08" + 1 → "2026-09". Date.UTC normalises the December rollover.
function addZonedMonths(monthKey: string, months: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1 + months, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Axis labels. Short enough for a tick, and unambiguous when the window crosses
// a year — "Jan" next to "Dec" with no year is the kind of label that gets read
// as a collapse in revenue.
export function bucketLabel(
  key: string,
  granularity: TrendGranularity,
  crossesYears: boolean
): string {
  if (granularity === "month") {
    const d = new Date(`${key}-01T00:00:00Z`);
    const month = d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
    return crossesYears ? `${month} ${String(d.getUTCFullYear()).slice(2)}` : month;
  }
  const d = new Date(`${key}T00:00:00Z`);
  const day = d.getUTCDate();
  const month = d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
  return crossesYears ? `${day} ${month} ${String(d.getUTCFullYear()).slice(2)}` : `${day} ${month}`;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      trendWindow?: TrendWindow;
    }
  }
}

// Parsed in SYNCHRONOUS middleware for the same reason withDateRange is: a
// ZodError thrown here reaches middleware/errorHandler.ts and returns a 400,
// where the same throw from inside an async handler used to become an unhandled
// rejection. express-async-errors now covers that case too, but keeping the
// parse out of the handler means the handler can trust req.trendWindow exists.
export function withTrendWindow(req: Request, _res: Response, next: NextFunction) {
  try {
    req.trendWindow = resolveTrendWindow(req.query, new Date(), req.auth?.timezone ?? DEFAULT_TIMEZONE);
    next();
  } catch (err) {
    next(err);
  }
}
