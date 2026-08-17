// §19 answer charts — the third and last thing the server adds to an answer.
//
// SAME RULE AS enrichFigures: only copy, never compute.
//
// The reference design draws charts inside an AI answer. The tempting way to
// get them is to let the model emit a series, or to have this file build one
// by walking a tool result and doing arithmetic on the way. Both are the §1
// violation wearing a different hat — a chart is a quantitative claim about
// every point on it, and a fabricated series is worse than a fabricated
// figure because nobody audits a line the way they audit a number.
//
// So a chart is produced ONLY when a tool already returned the whole series
// as its own output. Eight tools do — the registry at the bottom of this file
// (EXTRACTORS) is the authority, not this comment:
//
//   get_revenue_trend        → series[]  net revenue per day/week/month (§11)
//   get_contribution_margin  → layers[]  the CM ladder's measured cost layers
//   get_cash_forecast        → days[]    the projected daily closing balance
//   run_forecast_scenario    → days[]    the same shape, under a scenario
//   get_product_profitability→ bottomByMargin[]  SKUs already ranked by CM0
//   get_refund_analysis      → byGateway[]
//   get_settlement_summary   → byProvider[]
//   get_ad_spend_analysis    → byPlatform[]
//
// Every other tool returns scalars, and no chart is offered for them. There is
// no "if it has three numbers, plot it" fallback: a shape this file does not
// recognise yields nothing, which is the only direction that cannot lie.
//
// WHY paiseToRupees IS NOT "COMPUTING"
//
// Some series carry only *Minor paise strings. Converting them uses the same
// paiseToRupees helper every calc module already used to produce its own
// rupee-denominated `amount`/`value` fields — the rupee figures elsewhere in
// the very same tool result came through it. It changes the unit a number is
// written in, not the measurement. Nothing here adds, subtracts, divides two
// measurements, or infers a value that was not returned.

import { paiseToRupees } from "../calc/money.js";
import type { ToolResultRecord } from "./enrichFigures.js";

export interface ChartPoint {
  x: string;
  y: number;
}

export interface ChartSeries {
  name: string;
  points: ChartPoint[];
  // No colour here on purpose. Which palette entry a series gets is a
  // presentation decision belonging to the client, and a server that names
  // one has to be redeployed when the theme changes.
}

export interface AnswerChart {
  kind: "bar" | "line";
  title: string;
  subtitle?: string;
  yFormat: "currency" | "number" | "percent";
  /** The tool this was copied out of, shown on the card like a figure's source. */
  source: string;
  series: ChartSeries[];
  /** States what the chart leaves out. Never decorative. */
  footnote?: string;
}

/**
 * Point caps. A 90-day forecast is a legible line; 50 SKUs is not a legible
 * bar chart. Truncation is always reported in the footnote — a chart that
 * silently shows the top 12 of 741 is a chart that lies about the catalogue.
 */
const MAX_BARS = 12;
const MAX_LINE_POINTS = 90;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite number, or null. Never coerces a string that is not plainly one. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

/** A paise string as the calc modules write it, in rupees. Unit change only. */
function minorToMajor(v: unknown): number | null {
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) return null;
  const n = paiseToRupees(BigInt(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * The CM ladder's cost layers.
 *
 * Two exclusions, both load-bearing:
 *
 *   memo layers are dropped. RTO cost is reported but NOT subtracted, because
 *   its rupees already sit inside forward and reverse shipping — charting it
 *   beside them would draw the same money twice and invite a founder to add
 *   up the bars.
 *
 *   hasSource:false layers are dropped rather than drawn at zero. A zero bar
 *   labelled "Packaging" reads as "packaging is free"; it actually means no
 *   system reports it. They are named in the footnote instead, so the absence
 *   is stated rather than drawn as a measurement of nothing.
 */
function contributionLayers(data: unknown): AnswerChart | null {
  if (!isRecord(data) || !Array.isArray(data.layers)) return null;

  const points: ChartPoint[] = [];
  const unsourced: string[] = [];
  for (const raw of data.layers) {
    if (!isRecord(raw)) continue;
    const label = typeof raw.label === "string" ? raw.label : null;
    if (!label) continue;
    if (raw.memo === true) continue;
    if (raw.hasSource !== true) {
      unsourced.push(label);
      continue;
    }
    const y = num(raw.amount) ?? minorToMajor(raw.amountMinor);
    if (y === null) continue;
    points.push({ x: label, y });
  }
  if (points.length === 0) return null;

  const notes: string[] = [];
  if (unsourced.length > 0) {
    notes.push(`Not shown — no data source, so these are not measured: ${unsourced.join(", ")}.`);
  }
  return {
    kind: "bar",
    title: "Where the margin goes",
    subtitle: "Measured cost layers of the CM ladder (§37)",
    yFormat: "currency",
    source: "get_contribution_margin",
    series: [{ name: "Cost", points }],
    ...(notes.length > 0 ? { footnote: notes.join(" ") } : {}),
  };
}

/** The forecast's projected closing balance, one point per day. */
function cashForecast(data: unknown): AnswerChart | null {
  if (!isRecord(data) || !Array.isArray(data.days)) return null;

  const all: ChartPoint[] = [];
  for (const raw of data.days) {
    if (!isRecord(raw)) continue;
    const x = typeof raw.date === "string" ? raw.date : null;
    const y = minorToMajor(raw.closingMinor);
    if (x === null || y === null) continue;
    all.push({ x, y });
  }
  if (all.length === 0) return null;

  // The trough is the point of the chart (§16) — a line that dips below zero
  // in week three and recovers by week twelve ends healthy and is still a
  // crisis. So this truncates from the END, never the start, and says so.
  const points = all.slice(0, MAX_LINE_POINTS);
  const notes: string[] = [];
  if (points.length < all.length) {
    notes.push(`Showing the first ${points.length} of ${all.length} projected days.`);
  }
  return {
    kind: "line",
    title: "Projected cash balance",
    subtitle: "Closing balance per day (§16)",
    yFormat: "currency",
    source: "get_cash_forecast",
    series: [{ name: "Closing balance", points }],
    ...(notes.length > 0 ? { footnote: notes.join(" ") } : {}),
  };
}

/**
 * The revenue trend, bucketed by day / week / month.
 *
 * The chart founders kept asking for and could not get. Two series where both
 * are visible, because "revenue" and "cash actually received" diverging is the
 * single most useful thing this line can show — and a bucket the bank cannot
 * see yet is dropped from the cash series rather than plotted as zero, since a
 * flat zero beside a rising revenue line reads as "none of this was collected"
 * (§110) instead of "we were not looking".
 */
function revenueTrend(data: unknown): AnswerChart | null {
  if (!isRecord(data) || !Array.isArray(data.series)) return null;

  const revenue: ChartPoint[] = [];
  const cash: ChartPoint[] = [];
  for (const raw of data.series) {
    if (!isRecord(raw)) continue;
    const x = typeof raw.label === "string" ? raw.label : typeof raw.key === "string" ? raw.key : null;
    if (x === null) continue;
    if (raw.ordersVisible !== false) {
      const y = num(raw.netRevenue);
      if (y !== null) revenue.push({ x, y });
    }
    if (raw.cashVisible === true) {
      const y = num(raw.cashReceived);
      if (y !== null) cash.push({ x, y });
    }
  }
  if (revenue.length < 2) return null;

  const window = isRecord(data.window) ? data.window : null;
  const granularity = typeof window?.granularity === "string" ? window.granularity : null;
  const series: ChartSeries[] = [{ name: "Net revenue", points: revenue }];
  const notes: string[] = [];
  // Both series only when the bank covers the SAME buckets. A cash line over
  // half the window, aligned by index against a full revenue line, would put
  // June's cash under August's revenue — toChartRows zips by position.
  if (cash.length === revenue.length) {
    series.push({ name: "Cash received", points: cash });
  } else if (cash.length > 0) {
    notes.push(`Cash received is not plotted: the bank is only visible for ${cash.length} of ${revenue.length} buckets.`);
  }
  return {
    kind: "line",
    title: "Revenue trend",
    subtitle: granularity ? `Net revenue per ${granularity} (§11)` : "Net revenue over time (§11)",
    yFormat: "currency",
    source: "get_revenue_trend",
    series,
    ...(notes.length > 0 ? { footnote: notes.join(" ") } : {}),
  };
}

/** SKUs the calc already ranked as loss-making. Ranking is copied, not redone. */
function lossMakingProducts(data: unknown): AnswerChart | null {
  if (!isRecord(data) || !Array.isArray(data.bottomByMargin)) return null;

  const all: ChartPoint[] = [];
  for (const raw of data.bottomByMargin) {
    if (!isRecord(raw)) continue;
    // costed:false means cm0 is null and this SKU has no measured margin at
    // all. It is not a zero — it is unknown, and unknown does not get a bar.
    if (raw.costed !== true) continue;
    const x = typeof raw.productName === "string" && raw.productName.length > 0
      ? raw.productName
      : typeof raw.sku === "string"
        ? raw.sku
        : null;
    const y = num(raw.cm0) ?? minorToMajor(raw.cm0Minor);
    if (x === null || y === null) continue;
    all.push({ x, y });
  }
  if (all.length === 0) return null;

  const points = all.slice(0, MAX_BARS);
  const notes: string[] = [];
  if (points.length < all.length) {
    notes.push(`The ${points.length} worst of ${all.length} loss-making SKUs returned.`);
  }
  const total = num(data.totalSkuCount) ?? num(data.skuCount);
  if (total !== null) notes.push(`Ranked out of ${total} SKUs.`);
  return {
    kind: "bar",
    title: "Products losing money per order",
    subtitle: "CM0 after product cost (§40)",
    yFormat: "currency",
    source: "get_product_profitability",
    series: [{ name: "CM0", points }],
    ...(notes.length > 0 ? { footnote: notes.join(" ") } : {}),
  };
}

/**
 * A named breakdown a calc module already grouped — refunds byGateway,
 * settlements and ad spend byProvider. One bar per group, the group's own
 * measured total as the height. The grouping, the totals and the sort order
 * are all the calc module's work; this copies them out.
 */
function breakdownBars(opts: {
  arrayKey: string;
  labelKeys: string[];
  valueKey: string;
  minorKey: string;
  title: string;
  subtitle: string;
  source: string;
}): (data: unknown) => AnswerChart | null {
  return (data: unknown): AnswerChart | null => {
    if (!isRecord(data)) return null;
    const rows = data[opts.arrayKey];
    if (!Array.isArray(rows)) return null;

    const all: ChartPoint[] = [];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const label = opts.labelKeys.map((k) => raw[k]).find((v): v is string => typeof v === "string" && v.length > 0);
      const y = num(raw[opts.valueKey]) ?? minorToMajor(raw[opts.minorKey]);
      if (!label || y === null) continue;
      all.push({ x: label, y });
    }
    // One group is a figure, not a chart — a single bar communicates nothing
    // the tile above it did not.
    if (all.length < 2) return null;

    const points = all.slice(0, MAX_BARS);
    return {
      kind: "bar",
      title: opts.title,
      subtitle: opts.subtitle,
      yFormat: "currency",
      source: opts.source,
      series: [{ name: opts.title, points }],
      ...(points.length < all.length ? { footnote: `Showing the largest ${points.length} of ${all.length} groups.` } : {}),
    };
  };
}

// A closed registry, deliberately. Adding a tool here is a decision with a
// test attached, not something a pattern match does on your behalf.
const EXTRACTORS: Record<string, (data: unknown) => AnswerChart | null> = {
  get_revenue_trend: revenueTrend,
  get_contribution_margin: contributionLayers,
  get_cash_forecast: cashForecast,
  run_forecast_scenario: cashForecast,
  get_product_profitability: lossMakingProducts,
  get_refund_analysis: breakdownBars({
    arrayKey: "byGateway",
    labelKeys: ["gateway"],
    valueKey: "refunded",
    minorKey: "refundedPaise",
    title: "Refunds by gateway",
    subtitle: "Dated refund records in the period",
    source: "get_refund_analysis",
  }),
  get_settlement_summary: breakdownBars({
    arrayKey: "byProvider",
    labelKeys: ["provider"],
    valueKey: "netSettled",
    minorKey: "netSettledPaise",
    title: "Settled by provider",
    subtitle: "Net amount that reached the bank, after fees",
    source: "get_settlement_summary",
  }),
  get_ad_spend_analysis: breakdownBars({
    arrayKey: "byProvider",
    labelKeys: ["provider"],
    valueKey: "value",
    minorKey: "valueMinor",
    title: "Ad spend by platform",
    subtitle: "Spend in the period, per platform",
    source: "get_ad_spend_analysis",
  }),
};

/**
 * A stable key for a tool call: the same arguments in a different order are
 * the same call. JSON.stringify alone is not stable across key order, and the
 * model does not emit its arguments in a fixed order.
 */
function callKey(name: string, args: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, norm(val)])
      );
    }
    return v;
  };
  return name + "|" + JSON.stringify(norm(args ?? null));
}

/**
 * Charts for the tools THIS run actually called, in call order.
 *
 * DEDUPLICATED BY CALL, NOT BY TOOL, and the difference is a bug that shipped.
 *
 * A loop that calls get_cash_forecast twice measures the same forecast twice,
 * and two identical lines stacked in one answer read as two findings. That is
 * what the deduplication is for, and keying on the tool NAME appeared to do it.
 *
 * But the same tool called with DIFFERENT arguments answers a different
 * question. Measured on the live deployment, asking "show me net revenue day
 * by day for the last 30 days as a graph" made the model call
 * get_revenue_trend twice — once at its six-month default, then again with
 * granularity=day for the window actually asked about. Name-keyed dedup kept
 * the FIRST, so the answer's prose described 31 daily figures while the chart
 * underneath it drew 6 monthly buckets. A chart that contradicts the answer it
 * is attached to is worse than no chart: nobody audits a line the way they
 * audit a number, so the reader simply believes it.
 *
 * Keying on (name + arguments) keeps the original protection — an identical
 * repeat call still collapses — while letting a genuinely different window
 * through.
 */
export function answerCharts(toolResults: ToolResultRecord[]): AnswerChart[] {
  const charts: AnswerChart[] = [];
  const seen = new Set<string>();
  for (const record of toolResults) {
    const extract = EXTRACTORS[record.name];
    const key = callKey(record.name, record.args);
    if (!extract || seen.has(key)) continue;
    // Tool results are wrapped in the §19 envelope by tools.ts, so the payload
    // is under `data`. Falling back to the record itself keeps this working if
    // a tool is ever changed to return bare data.
    const envelope = isRecord(record.result) ? record.result : null;
    const payload = envelope && "data" in envelope ? envelope.data : record.result;
    const chart = extract(payload);
    if (!chart) continue;
    seen.add(key);
    charts.push(chart);
  }
  return charts;
}
