import type { ConnectionStatus, MetricConfidence, Provider } from "@prisma/client";
import {
  DEFAULT_TIMEZONE,
  addZonedDays,
  resolveDateRange,
  startOfZonedDay,
  zonedDayKey,
} from "../../lib/dateRange.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { getAdSpendSummary } from "./ads.js";
import { getBurnAndRunway } from "./burn.js";
import { getAvailableCashSummary, getCashReceivedSummary } from "./cash.js";
import { getContributionMargin } from "./contribution.js";
import { getInventoryValueSummary } from "./inventory.js";
import { paiseToRupees } from "./money.js";
import { getPayablesSummary } from "./payables.js";
import { getCodExposure } from "./reconciliation.js";
import { getNetRevenueSummary } from "./revenue.js";
import { getSalesSummary } from "./sales.js";
import { getRtoRateSummary } from "./shipments.js";

// P2.2d — snapshot HISTORY, which is a different thing from the snapshot
// WRITES the metric modules already do.
//
// Six calc modules opportunistically persist a MetricSnapshot as a side effect
// of answering a dashboard request (cash.ts, revenue.ts, sales.ts, ads.ts,
// shipments.ts, inventory.ts). Every one of them finds-then-UPDATES the row for
// the current period in place, so the row always holds the latest belief and
// yesterday's belief is gone. That is fine for "what is this metric now" and
// useless for "what changed overnight", which is the question a daily brief
// exists to answer. Nothing in the codebase reads those rows today — they are
// write-only — so this module builds the history it needs rather than trying to
// reinterpret theirs.
//
// Three rules make the history trustworthy:
//
//  1. A row is written for the last COMPLETE day on the organisation's own
//     calendar, never for today. A flow metric captured mid-day is a partial
//     number wearing a whole day's date, and a brief built on it would report
//     an overnight "collapse" that is just the clock.
//  2. The target day is derived from `now` inside captureDailySnapshot and
//     cannot be passed in. That is the enforcement of "never updated after that
//     day": a run on day D+2 computes yesterday = D+1 and has no expression
//     that could reach D. Re-running on D+1 rewrites D+1's target row, which is
//     correct — it is the same day's belief, refreshed.
//  3. Rows live in their own formulaVersion namespace (DAILY_SNAPSHOT_VERSION),
//     so the opportunistic writes above — which key `available_cash` and
//     `inventory_value` to a UTC midnight rather than the org's — can never
//     interleave into a series read from here. Reads filter on it.
//
// This module deliberately owns no BullMQ import. queue/snapshotScheduler.ts
// constructs a Queue at module scope, and anything importing that opens a Redis
// connection and never exits — the trap syncCadence.ts documents and that cost
// this project a debugging session when runAnomalySweep briefly lived in
// queue/anomalyScheduler.ts. The sweep lives here so a script can run it and
// terminate.

// Not "v1". The namespace has to be distinguishable at a glance from the
// per-metric formula versions that share this column, because a query that
// forgets to filter on it silently mixes two producers' rows into one series.
export const DAILY_SNAPSHOT_VERSION = "daily-v1";

// The trailing window for rate metrics. A rate over a single day swings on
// order volume — one RTO out of three parcels is 33% — so the rates here are
// measured over the same 28 days the anomaly engine uses, ending on the
// captured day. The VALUE is as of that day; the WINDOW is what makes it
// stable enough to compare with yesterday's.
const RATE_WINDOW_DAYS = 28;

export type SnapshotKind = "position" | "flow" | "rate";
export type SnapshotUnit = "paise" | "count" | "pct" | "months";

/**
 * The connectors a metric is measured from, and a word for them.
 *
 * This exists because of the single sharpest failure mode in a nightly capture:
 * a store whose Shopify sync broke on Monday still answers "how much revenue on
 * Tuesday" with ₹0, because the query is well-formed and the table is simply
 * empty. Written to a dashboard that zero is a bad afternoon; written to
 * history it is permanent, and every later diff, brief and chart treats it as
 * measured. A day no source observed has no honest number, so no row is
 * written for it — the sweep reports the hole instead.
 */
interface SourceGroup {
  label: string;
  providers: readonly Provider[];
}

const ORDER_SOURCES: SourceGroup = { label: "order", providers: ["SHOPIFY", "AMAZON", "FLIPKART"] };
const BANK_SOURCES: SourceGroup = { label: "bank", providers: ["BANK", "BANK_AA"] };
const AD_SOURCES: SourceGroup = { label: "ad platform", providers: ["META_ADS", "GOOGLE_ADS"] };
const COURIER_SOURCES: SourceGroup = {
  label: "courier",
  providers: ["SHIPROCKET", "DELHIVERY", "CLICKPOST", "BLUEDART"],
};
const BOOKS_SOURCES: SourceGroup = { label: "accounting", providers: ["ZOHO_BOOKS"] };

export interface DailyMetricSpec {
  key: string;
  label: string;
  /** Which connectors have to have seen the day before this can be recorded. */
  sources: SourceGroup;
  /**
   * position — a stock reading as of the end of the day. Yesterday-to-today is
   *   a movement, and the diff is the interesting number.
   * flow — everything that happened during the day. The row IS the number; the
   *   diff is a day-over-day comparison, which is also meaningful but is not
   *   "the change in a balance".
   * rate — a ratio over the trailing window ending on the day.
   *
   * Carried because the daily brief has to word these three differently, and a
   * consumer guessing from the key's suffix would eventually guess wrong.
   */
  kind: SnapshotKind;
  unit: SnapshotUnit;
  /** Which direction is good news. null where it genuinely depends. */
  betterWhen: "higher" | "lower" | null;
  /**
   * Whether the figure is a true reading for that day or the closest reading
   * available at capture time. Inventory levels, payables and COD exposure are
   * CURRENT-state tables with no history behind them — asking them for "the
   * value as of the end of yesterday" is not a question they can answer, so the
   * row holds what was true when the job ran, a couple of hours later. Marked
   * rather than hidden: a brief that says "inventory fell ₹4L yesterday" off a
   * non-reconstructable metric is making a claim about a window it did not
   * measure.
   */
  asOfCaptureTime?: true;
}

export const DAILY_SNAPSHOT_METRICS: readonly DailyMetricSpec[] = [
  // --- positions
  { key: "available_cash", label: "Available cash", sources: BANK_SOURCES, kind: "position", unit: "paise", betterWhen: "higher" },
  { key: "inventory_value", label: "Inventory value", sources: ORDER_SOURCES, kind: "position", unit: "paise", betterWhen: null, asOfCaptureTime: true },
  { key: "payables_outstanding", label: "Payables outstanding", sources: BOOKS_SOURCES, kind: "position", unit: "paise", betterWhen: "lower", asOfCaptureTime: true },
  { key: "cod_delivered_value", label: "COD delivered, awaiting remittance", sources: COURIER_SOURCES, kind: "position", unit: "paise", betterWhen: null, asOfCaptureTime: true },
  { key: "cod_unknown_value", label: "COD gone dark", sources: COURIER_SOURCES, kind: "position", unit: "paise", betterWhen: "lower", asOfCaptureTime: true },
  // --- flows over the captured day
  { key: "net_revenue_day", label: "Net revenue", sources: ORDER_SOURCES, kind: "flow", unit: "paise", betterWhen: "higher" },
  { key: "gross_sales_day", label: "Gross sales", sources: ORDER_SOURCES, kind: "flow", unit: "paise", betterWhen: "higher" },
  { key: "order_count_day", label: "Orders placed", sources: ORDER_SOURCES, kind: "flow", unit: "count", betterWhen: "higher" },
  { key: "ad_spend_day", label: "Ad spend", sources: AD_SOURCES, kind: "flow", unit: "paise", betterWhen: null },
  { key: "cash_received_day", label: "Cash received", sources: BANK_SOURCES, kind: "flow", unit: "paise", betterWhen: "higher" },
  // --- rates over the trailing window ending on the captured day
  { key: "rto_rate_28d", label: "RTO rate (28d)", sources: COURIER_SOURCES, kind: "rate", unit: "pct", betterWhen: "lower" },
  // Gated on the ORDER source alone, though the ladder also subtracts freight,
  // fees and ads. Requiring all four to be current would omit this on almost
  // every real account, and net revenue is both the denominator and the term
  // that moves it — a stale ad connection shifts CM3 by a point, a stale order
  // connection makes it meaningless. contribution.ts already carries per-layer
  // coverage warnings for the rest.
  { key: "cm3_pct_28d", label: "CM3 margin (28d)", sources: ORDER_SOURCES, kind: "rate", unit: "pct", betterWhen: "higher" },
  { key: "runway_months", label: "Runway", sources: BANK_SOURCES, kind: "rate", unit: "months", betterWhen: "higher", asOfCaptureTime: true },
] as const;

const SPEC_BY_KEY = new Map(DAILY_SNAPSHOT_METRICS.map((m) => [m.key, m]));

export interface DailyRow {
  metricKey: string;
  valueMinor: bigint | null;
  valueNumeric: number | null;
  confidence: MetricConfidence;
}

// ---------------------------------------------------------------------------
// Gather → build. Split so the mapping rules are a pure function over already
// -computed summaries and can be tested without a database, the same shape
// anomalies.ts uses.
// ---------------------------------------------------------------------------

export interface ConnectionObservation {
  provider: Provider;
  status: ConnectionStatus;
  lastSyncedAt: Date | null;
}

/**
 * Did every connected source of this kind see the whole of the captured day?
 *
 * ALL of them, not any: a store shipping through both Shiprocket and Bluedart
 * whose Shiprocket feed stopped on Monday has a Tuesday RTO rate built from
 * half its parcels. That number is not "slightly low", it is a different
 * measurement wearing the same name — and unlike a stale dashboard card, a row
 * written here is never revisited.
 *
 * A never-synced connection counts as not having observed anything, matching
 * freshness.ts: "a connection that has never completed a sync is the least
 * fresh state there is, not an unknown."
 *
 * Only ACTIVE connections are consulted. A PENDING or REVOKED one is not a
 * stale source, it is not a source — counting it would block a metric forever
 * on the strength of a half-finished connect flow.
 */
export function observedThroughDay(
  connections: readonly ConnectionObservation[],
  group: SourceGroup,
  dayEnd: Date
): { observed: boolean; reason: string | null } {
  const relevant = connections.filter((c) => c.status === "ACTIVE" && group.providers.includes(c.provider));
  if (relevant.length === 0) {
    return { observed: false, reason: `no ${group.label} source is connected` };
  }
  const behind = relevant.filter((c) => c.lastSyncedAt === null || c.lastSyncedAt.getTime() <= dayEnd.getTime());
  if (behind.length > 0) {
    const detail = behind
      .map((c) => `${c.provider} last synced ${c.lastSyncedAt ? c.lastSyncedAt.toISOString() : "never"}`)
      .join(", ");
    return { observed: false, reason: `the ${group.label} source never observed this day (${detail})` };
  }
  return { observed: true, reason: null };
}

export interface DailySnapshotSources {
  /** Every connection on the org, for the freshness gate above. */
  connections: ConnectionObservation[];
  /** The last millisecond of the captured day, on the org's calendar. */
  dayEnd: Date;
  availableCash: Awaited<ReturnType<typeof getAvailableCashSummary>>;
  cashReceived: Awaited<ReturnType<typeof getCashReceivedSummary>>;
  netRevenue: Awaited<ReturnType<typeof getNetRevenueSummary>>;
  sales: Awaited<ReturnType<typeof getSalesSummary>>;
  adSpend: Awaited<ReturnType<typeof getAdSpendSummary>>;
  rto: Awaited<ReturnType<typeof getRtoRateSummary>>;
  inventory: Awaited<ReturnType<typeof getInventoryValueSummary>>;
  payables: Awaited<ReturnType<typeof getPayablesSummary>>;
  cod: Awaited<ReturnType<typeof getCodExposure>>;
  burn: Awaited<ReturnType<typeof getBurnAndRunway>>;
  contribution: Awaited<ReturnType<typeof getContributionMargin>>;
}

/** A value to record, or a plain-language reason there is nothing honest to record. */
type Resolution =
  | { minor: bigint; confidence: MetricConfidence }
  | { numeric: number; confidence: MetricConfidence }
  | { omit: string };

// One resolver per catalogue entry. A map rather than a run of if-blocks so
// that "every metric is accounted for" is checkable — dailySnapshot.test.ts
// asserts the two sets match, which is what stops a metric added to the
// catalogue from silently never being captured.
const RESOLVERS: Record<string, (s: DailySnapshotSources) => Resolution> = {
  available_cash: (s) => ({
    minor: BigInt(s.availableCash.valueMinor),
    // Mirrors cash.ts: a total missing an opening anchor on one of several
    // accounts is an estimate of the balance, not a provisional reading of it.
    confidence: s.availableCash.missingOpeningBalance.length > 0 ? "ESTIMATED" : "PROVISIONAL",
  }),

  cash_received_day: (s) => ({ minor: BigInt(s.cashReceived.valueMinor), confidence: "PROVISIONAL" }),

  // `status` is the calc layer's own verdict on whether the window is fully
  // covered, so the confidence stamped here is the one the metric already
  // reached about itself rather than a second opinion formed here.
  net_revenue_day: (s) => ({ minor: BigInt(s.netRevenue.valueMinor), confidence: salesConfidence(s) }),
  gross_sales_day: (s) => ({ minor: BigInt(s.sales.grossSales.valueMinor), confidence: salesConfidence(s) }),
  order_count_day: (s) => ({ numeric: s.sales.orders.value, confidence: "PROVISIONAL" }),

  // CM3 is the bottom of the contribution ladder and the only level that
  // includes advertising. Null when there is no net revenue to divide by — a
  // margin percentage of nothing is not 0%, it is undefined.
  cm3_pct_28d: (s) => {
    const cm3 = s.contribution.levels.cm3.marginPct;
    return cm3 === null
      ? { omit: "no net revenue in the trailing window, so there is no margin to express as a percentage" }
      : { numeric: cm3, confidence: "ESTIMATED" };
  },

  // dayCount is the number of account-days with a record in the window. Zero
  // means no ad data reached us for that day, which is not the same claim as
  // "spent nothing". Mixed currency nulls the total in ads.ts rather than
  // summing USD into rupees.
  ad_spend_day: (s) => {
    if (s.adSpend.dayCount === 0) return { omit: "no ad-spend records cover this day" };
    if (s.adSpend.valueMinor == null) {
      return { omit: "ad accounts bill in more than one currency, so there is no single rupee total" };
    }
    return { minor: BigInt(s.adSpend.valueMinor), confidence: "PROVISIONAL" };
  },

  // A rate over zero dispatches is undefined, not 0%.
  rto_rate_28d: (s) =>
    s.rto.dispatchedCount === 0 || s.rto.rtoRatePct === null
      ? { omit: "nothing was dispatched in the trailing window, so there is no rate" }
      : { numeric: s.rto.rtoRatePct, confidence: "ESTIMATED" },

  inventory_value: (s) =>
    s.inventory.variantCount === 0
      ? { omit: "no product catalogue has been synced" }
      : { minor: BigInt(s.inventory.valueMinor), confidence: "PROVISIONAL" },

  payables_outstanding: (s) => {
    if (!s.payables.connected) return { omit: "no vendor bills exist" };
    if (s.payables.totalOutstandingMinor == null) {
      return { omit: "bills span more than one currency, so there is no single total (see payables.ts)" };
    }
    return { minor: BigInt(s.payables.totalOutstandingMinor), confidence: "PROVISIONAL" };
  },

  // Both COD buckets need courier data to mean anything: without it the split
  // between "delivered and owed to us" and "gone dark" does not exist, and a
  // ₹0 dark bucket would read as reassurance about something never measured.
  cod_delivered_value: (s) =>
    s.cod.hasCourierData
      ? { minor: s.cod.deliveredValue, confidence: "ESTIMATED" }
      : { omit: "no shipment data, so delivered COD cannot be separated from the rest" },
  cod_unknown_value: (s) =>
    s.cod.hasCourierData
      ? { minor: s.cod.unknownValue, confidence: "ESTIMATED" }
      : { omit: "no shipment data, so nothing can be called untracked" },

  // Null whenever §85's precondition fails — not burning, no transactions, no
  // cash figure — and burn.ts already carries the reason in words.
  runway_months: (s) =>
    s.burn.runwayMonths === null
      ? { omit: s.burn.runwayReason }
      : { numeric: s.burn.runwayMonths, confidence: "ESTIMATED" },
};

function salesConfidence(s: DailySnapshotSources): MetricConfidence {
  return s.sales.status === "INCOMPLETE" ? "ESTIMATED" : "PROVISIONAL";
}

export interface OmittedMetric {
  metricKey: string;
  reason: string;
}

export interface DailySnapshotDecision {
  rows: DailyRow[];
  omitted: OmittedMetric[];
}

/**
 * Which metrics this organisation can honestly report for this day, and at
 * what value.
 *
 * Two gates, in order. First: did every source behind the metric actually
 * observe the day? Second: given that it did, is there a number — a rate needs
 * a denominator, a rupee total needs one currency. Anything that fails either
 * is OMITTED WITH A REASON, never written as zero. That is the dashboard's own
 * rule (missing data shows a connect-source state, never a placeholder), and it
 * binds harder here: a zero on a card is corrected by the next refresh, a zero
 * in history is indistinguishable from a measured zero forever after.
 */
export function decideDailyRows(s: DailySnapshotSources): DailySnapshotDecision {
  const rows: DailyRow[] = [];
  const omitted: OmittedMetric[] = [];

  for (const spec of DAILY_SNAPSHOT_METRICS) {
    const observation = observedThroughDay(s.connections, spec.sources, s.dayEnd);
    if (!observation.observed) {
      omitted.push({ metricKey: spec.key, reason: observation.reason! });
      continue;
    }

    const resolved = RESOLVERS[spec.key]!(s);
    if ("omit" in resolved) {
      omitted.push({ metricKey: spec.key, reason: resolved.omit });
      continue;
    }

    rows.push({
      metricKey: spec.key,
      valueMinor: "minor" in resolved ? resolved.minor : null,
      valueNumeric: "numeric" in resolved ? resolved.numeric : null,
      confidence: resolved.confidence,
    });
  }

  return { rows, omitted };
}

/** Exported for the completeness test — see the note on RESOLVERS. */
export const RESOLVED_METRIC_KEYS = Object.keys(RESOLVERS);

async function gather(
  organizationId: string,
  timeZone: string,
  day: string,
  dayEnd: Date,
  now: Date
): Promise<DailySnapshotSources> {
  // The captured day, as one whole day on the org's calendar. resolveDateRange
  // with an explicit from/to also sets isDefault:false, which is what stops the
  // six opportunistic persisters from writing a row of their own off the back
  // of this job — see shouldPersistSnapshot in lib/dateRange.ts.
  const dayRange = resolveDateRange({ from: day, to: day }, now, timeZone);
  const rateRange = resolveDateRange(
    { from: addZonedDays(day, -(RATE_WINDOW_DAYS - 1)), to: day },
    now,
    timeZone
  );

  const [connections, availableCash, cashReceived, netRevenue, sales, adSpend, rto, inventory, payables, cod, burn, contribution] =
    await Promise.all([
      prisma.connection.findMany({
        where: { organizationId },
        select: { provider: true, status: true, lastSyncedAt: true },
      }),
      getAvailableCashSummary(organizationId, dayRange),
      getCashReceivedSummary(organizationId, dayRange),
      getNetRevenueSummary(organizationId, dayRange),
      getSalesSummary(organizationId, dayRange),
      getAdSpendSummary(organizationId, dayRange),
      getRtoRateSummary(organizationId, rateRange),
      // No range parameter exists on these four: they read current-state tables
      // (stock levels, open bills, live COD exposure, the last 90 days of bank
      // movement) that hold no history to look back through. Hence
      // asOfCaptureTime on their specs.
      getInventoryValueSummary(organizationId),
      getPayablesSummary(organizationId),
      getCodExposure(organizationId),
      getBurnAndRunway(organizationId),
      getContributionMargin(organizationId, rateRange),
    ]);

  return { connections, dayEnd, availableCash, cashReceived, netRevenue, sales, adSpend, rto, inventory, payables, cod, burn, contribution };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface DailySnapshotCapture {
  organizationId: string;
  timeZone: string;
  /** The day the rows describe: the last complete day on the org's calendar. */
  day: string;
  written: number;
  /**
   * Metrics with no honest value for this day, each with the reason — omitted,
   * not zeroed. The interesting half of the answer on a partly-connected or
   * partly-synced account, and the only way to tell "recorded as zero" from
   * "never looked" without reading the table.
   */
  omitted: OmittedMetric[];
  rows: DailyRow[];
}

/**
 * The last complete day on `timeZone`'s calendar.
 *
 * Yesterday-in-a-timezone is complete at every instant of that timezone's
 * today, whatever hour the job happens to fire — which is what lets one cron
 * serve organisations on different calendars without a per-org schedule.
 */
export function lastCompleteDay(now: Date, timeZone: string): string {
  return addZonedDays(zonedDayKey(now, timeZone), -1);
}

/**
 * Write one day of history for one organisation.
 *
 * Deliberately takes no day parameter. The target is derived from `now`, so
 * there is no expression in this module that writes to a day older than
 * yesterday — which is how "never updated after that day" is enforced, rather
 * than by a flag someone can forget to check.
 */
export async function captureDailySnapshot(organizationId: string, now: Date = new Date()): Promise<DailySnapshotCapture> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  const timeZone = org?.timezone ?? DEFAULT_TIMEZONE;
  const day = lastCompleteDay(now, timeZone);

  const periodStart = startOfZonedDay(day, timeZone);
  // End of the captured day, obtained as the instant before the next day
  // starts. dateRange.ts keeps its own endOfZonedDay private, and re-deriving
  // one here would be a second implementation of a boundary that has already
  // been got wrong once in this codebase.
  const periodEnd = new Date(startOfZonedDay(addZonedDays(day, 1), timeZone).getTime() - 1);

  const sources = await gather(organizationId, timeZone, day, periodEnd, now);
  const { rows, omitted } = decideDailyRows(sources);

  for (const row of rows) {
    // find-then-update rather than .upsert(): the compound unique includes the
    // nullable legalEntityId, and Prisma's generated input type demands a
    // non-null string for it — the same limitation snapshots.ts documents.
    const existing = await prisma.metricSnapshot.findFirst({
      where: {
        organizationId,
        legalEntityId: null,
        metricKey: row.metricKey,
        granularity: "DAILY",
        periodStart,
        formulaVersion: DAILY_SNAPSHOT_VERSION,
      },
      select: { id: true },
    });

    if (existing) {
      await prisma.metricSnapshot.update({
        where: { id: existing.id },
        data: {
          periodEnd,
          valueMinor: row.valueMinor,
          valueNumeric: row.valueNumeric,
          confidence: row.confidence,
          computedAt: now,
        },
      });
    } else {
      await prisma.metricSnapshot.create({
        data: {
          organizationId,
          metricKey: row.metricKey,
          granularity: "DAILY",
          periodStart,
          periodEnd,
          valueMinor: row.valueMinor,
          valueNumeric: row.valueNumeric,
          formulaVersion: DAILY_SNAPSHOT_VERSION,
          confidence: row.confidence,
          computedAt: now,
        },
      });
    }
  }

  return {
    organizationId,
    timeZone,
    day,
    written: rows.length,
    omitted,
    rows,
  };
}

export interface DailySnapshotSweepResult {
  organizations: number;
  ran: number;
  failed: number;
  written: number;
  /**
   * Organisations whose history has a hole — the day before the one just
   * captured has no rows. Reported rather than backfilled: the position metrics
   * marked asOfCaptureTime cannot be reconstructed for a past day, so a
   * backfill would write today's inventory and payables under a date they were
   * never true of. A hole that is visible can be reasoned about; a hole filled
   * with the wrong numbers cannot.
   */
  gaps: Array<{ organizationId: string; day: string; previousDay: string }>;
  /**
   * Organisations that have connections but recorded nothing for this day —
   * every metric was gated out, which in practice means a sync has stopped.
   *
   * This is the signal that matters operationally. A hole caused by a broken
   * feed looks exactly like a quiet night from the outside, and the difference
   * only becomes visible weeks later when someone asks why the chart has a
   * notch in it. Reported with the reasons so the answer is in the log rather
   * than in a subsequent investigation.
   */
  blocked: Array<{ organizationId: string; day: string; reasons: OmittedMetric[] }>;
}

export async function runDailySnapshotSweep(now: Date = new Date()): Promise<DailySnapshotSweepResult> {
  const organizations = await prisma.organization.findMany({ select: { id: true } });

  const result: DailySnapshotSweepResult = {
    organizations: organizations.length,
    ran: 0,
    failed: 0,
    written: 0,
    gaps: [],
    blocked: [],
  };

  for (const org of organizations) {
    try {
      const capture = await captureDailySnapshot(org.id, now);
      result.ran += 1;
      result.written += capture.written;

      if (capture.written === 0) {
        // "No connections" is an empty organisation, not a broken one — an
        // account someone signed up for and never finished. Reporting those
        // every night would bury the ones that genuinely stopped reporting.
        const connected = await prisma.connection.count({ where: { organizationId: org.id, status: "ACTIVE" } });
        if (connected > 0) result.blocked.push({ organizationId: org.id, day: capture.day, reasons: capture.omitted });
      }

      if (capture.written > 0) {
        const previousDay = addZonedDays(capture.day, -1);
        const priorRows = await prisma.metricSnapshot.count({
          where: {
            organizationId: org.id,
            granularity: "DAILY",
            formulaVersion: DAILY_SNAPSHOT_VERSION,
            periodStart: startOfZonedDay(previousDay, capture.timeZone),
          },
        });
        // Zero prior rows on the very first run is expected, not a gap — only
        // report one once there is history to have a hole in.
        if (priorRows === 0) {
          const anyHistory = await prisma.metricSnapshot.count({
            where: {
              organizationId: org.id,
              granularity: "DAILY",
              formulaVersion: DAILY_SNAPSHOT_VERSION,
              periodStart: { lt: startOfZonedDay(previousDay, capture.timeZone) },
            },
          });
          if (anyHistory > 0) result.gaps.push({ organizationId: org.id, day: capture.day, previousDay });
        }
      }
    } catch (err) {
      // One organisation's failure must not abandon the rest of the sweep —
      // the same reasoning as the anomaly sweep. A day missed for every org
      // because one org has malformed data is a far worse outcome than a
      // single hole, and the hole is reported above either way.
      result.failed += 1;
      logger.error({ err, organizationId: org.id }, "daily_snapshot_org_failed");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Read side — the series, and the overnight diff the daily brief is built on
// ---------------------------------------------------------------------------

export interface SnapshotPoint {
  day: string;
  valueMinor: string | null;
  value: number | null;
  valueNumeric: number | null;
  confidence: MetricConfidence;
  computedAt: string;
}

export interface SnapshotSeries {
  metric: DailyMetricSpec;
  points: SnapshotPoint[];
}

function toPoint(
  row: { periodStart: Date; valueMinor: bigint | null; valueNumeric: number | null; confidence: MetricConfidence; computedAt: Date },
  timeZone: string
): SnapshotPoint {
  return {
    day: zonedDayKey(row.periodStart, timeZone),
    valueMinor: row.valueMinor === null ? null : row.valueMinor.toString(),
    value: row.valueMinor === null ? null : paiseToRupees(row.valueMinor),
    valueNumeric: row.valueNumeric,
    confidence: row.confidence,
    computedAt: row.computedAt.toISOString(),
  };
}

const MAX_HISTORY_DAYS = 365;

export async function getSnapshotHistory(
  organizationId: string,
  days: number,
  now: Date = new Date()
): Promise<{ timeZone: string; days: number; series: SnapshotSeries[] }> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  const timeZone = org?.timezone ?? DEFAULT_TIMEZONE;
  const window = Math.min(Math.max(1, Math.floor(days)), MAX_HISTORY_DAYS);
  const since = startOfZonedDay(addZonedDays(lastCompleteDay(now, timeZone), -(window - 1)), timeZone);

  const rows = await prisma.metricSnapshot.findMany({
    where: {
      organizationId,
      granularity: "DAILY",
      formulaVersion: DAILY_SNAPSHOT_VERSION,
      periodStart: { gte: since },
    },
    orderBy: { periodStart: "asc" },
    select: { metricKey: true, periodStart: true, valueMinor: true, valueNumeric: true, confidence: true, computedAt: true },
  });

  const byMetric = new Map<string, SnapshotPoint[]>();
  for (const row of rows) {
    // A key that is no longer in the catalogue is skipped rather than returned
    // shapeless: a consumer reads `metric.unit` to know whether the number is
    // rupees or a percentage, and a point with no spec has no safe rendering.
    if (!SPEC_BY_KEY.has(row.metricKey)) continue;
    const list = byMetric.get(row.metricKey) ?? [];
    list.push(toPoint(row, timeZone));
    byMetric.set(row.metricKey, list);
  }

  return {
    timeZone,
    days: window,
    series: DAILY_SNAPSHOT_METRICS.filter((m) => byMetric.has(m.key)).map((m) => ({
      metric: m,
      points: byMetric.get(m.key)!,
    })),
  };
}

export interface DailyMetricMove {
  metric: DailyMetricSpec;
  current: SnapshotPoint;
  previous: SnapshotPoint | null;
  /** Null when there is nothing to compare against — never 0. */
  deltaMinor: string | null;
  delta: number | null;
  deltaNumeric: number | null;
  changePct: number | null;
  direction: "up" | "down" | "flat" | null;
  /** True when `previous` is not literally the day before `current`. */
  previousIsAdjacent: boolean;
}

export interface DailySnapshotDiff {
  timeZone: string;
  day: string | null;
  metrics: DailyMetricMove[];
  warnings: string[];
}

/**
 * The two most recent rows per metric, and the move between them.
 *
 * The comparison is against the previous ROW, not against a hard-coded
 * "yesterday" — and it says whether that row is actually adjacent. A brief that
 * announces "cash fell ₹6L overnight" off a three-day gap is describing three
 * days while claiming one, and the only way a consumer can avoid that is by
 * being told.
 */
export async function getDailySnapshotDiff(organizationId: string, now: Date = new Date()): Promise<DailySnapshotDiff> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  const timeZone = org?.timezone ?? DEFAULT_TIMEZONE;

  const rows = await prisma.metricSnapshot.findMany({
    where: { organizationId, granularity: "DAILY", formulaVersion: DAILY_SNAPSHOT_VERSION },
    orderBy: { periodStart: "desc" },
    // Two rows per metric is all this needs, but "two per group" is not a query
    // Prisma expresses. Bounded by catalogue size × a small window instead,
    // which is a few dozen rows even for the fullest org.
    take: DAILY_SNAPSHOT_METRICS.length * 4,
    select: { metricKey: true, periodStart: true, valueMinor: true, valueNumeric: true, confidence: true, computedAt: true },
  });

  const metrics: DailyMetricMove[] = [];
  let latestDay: string | null = null;

  for (const spec of DAILY_SNAPSHOT_METRICS) {
    const forMetric = rows.filter((r) => r.metricKey === spec.key);
    const currentRow = forMetric[0];
    if (!currentRow) continue;

    const current = toPoint(currentRow, timeZone);
    if (latestDay === null || current.day > latestDay) latestDay = current.day;

    const previousRow = forMetric[1];
    const previous = previousRow ? toPoint(previousRow, timeZone) : null;

    let deltaMinor: string | null = null;
    let delta: number | null = null;
    let deltaNumeric: number | null = null;
    let changePct: number | null = null;
    let direction: "up" | "down" | "flat" | null = null;

    if (previous) {
      if (currentRow.valueMinor !== null && previousRow!.valueMinor !== null) {
        const d = currentRow.valueMinor - previousRow!.valueMinor;
        deltaMinor = d.toString();
        delta = paiseToRupees(d);
        direction = d > 0n ? "up" : d < 0n ? "down" : "flat";
        if (previousRow!.valueMinor !== 0n) {
          changePct = Math.round((Number(d) / Math.abs(Number(previousRow!.valueMinor))) * 1000) / 10;
        }
      } else if (currentRow.valueNumeric !== null && previousRow!.valueNumeric !== null) {
        // Rounded to 2dp for the same reason anomalies.ts rounds its rupee
        // differences: 12.3 − 11.9 is 0.40000000000000036 in float, and this
        // number is rendered.
        const d = Math.round((currentRow.valueNumeric - previousRow!.valueNumeric) * 100) / 100;
        deltaNumeric = d;
        direction = d > 0 ? "up" : d < 0 ? "down" : "flat";
        if (previousRow!.valueNumeric !== 0) {
          changePct = Math.round((d / Math.abs(previousRow!.valueNumeric)) * 1000) / 10;
        }
      }
    }

    metrics.push({
      metric: spec,
      current,
      previous,
      deltaMinor,
      delta,
      deltaNumeric,
      changePct,
      direction,
      previousIsAdjacent: previous !== null && previous.day === addZonedDays(current.day, -1),
    });
  }

  const warnings: string[] = [];
  if (metrics.length === 0) {
    warnings.push("No daily snapshots have been captured yet — the nightly job has not run for this organisation.");
  } else {
    const withoutPrevious = metrics.filter((m) => m.previous === null);
    if (withoutPrevious.length > 0) {
      warnings.push(
        `${withoutPrevious.length} metric(s) have only one day of history, so no overnight change can be shown yet: ${withoutPrevious.map((m) => m.metric.label).join(", ")}.`
      );
    }
    const nonAdjacent = metrics.filter((m) => m.previous !== null && !m.previousIsAdjacent);
    if (nonAdjacent.length > 0) {
      warnings.push(
        `${nonAdjacent.length} metric(s) are compared against a day that is not yesterday — the history has a gap, so these changes cover more than one day.`
      );
    }
    const stale = metrics.filter((m) => m.current.day !== lastCompleteDay(now, timeZone));
    if (stale.length > 0) {
      warnings.push(
        `${stale.length} metric(s) have no row for ${lastCompleteDay(now, timeZone)}; the figures shown are from an earlier capture.`
      );
    }
  }

  return { timeZone, day: latestDay, metrics, warnings };
}
