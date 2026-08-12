import { Router } from "express";
import { getStateProfitability } from "../modules/calc/geography.js";
import { getCashConversionCycle } from "../modules/calc/cashCycle.js";
import { unsupportedScopeMessage, withEntityScope } from "../lib/entityScope.js";
import { z } from "zod";
import { withDateRange } from "../lib/dateRange.js";
import { withTrendWindow } from "../lib/trendWindow.js";
import { getAdEfficiencySummary, getAdSpendSummary } from "../modules/calc/ads.js";
import { getAvailableCashSummary, getCashReceivedSummary } from "../modules/calc/cash.js";
import { DEFAULT_HORIZON, getCashForecast, isForecastHorizon } from "../modules/calc/cashForecast.js";
import { runCashScenario, type ScenarioParams } from "../modules/calc/cashScenario.js";
import {
  DAILY_SNAPSHOT_METRICS,
  DAILY_SNAPSHOT_VERSION,
  captureDailySnapshot,
  getDailySnapshotDiff,
  getSnapshotHistory,
} from "../modules/calc/dailySnapshot.js";
import { getDataFreshness } from "../modules/calc/freshness.js";
import { getDataStatusMap, FORMULA_VERSION as DATA_STATUS_FORMULA_VERSION } from "../modules/calc/dataStatus.js";
import { getInventoryCoverSummary, getInventoryValueSummary } from "../modules/calc/inventory.js";
import { getNetRevenueSummary } from "../modules/calc/revenue.js";
import { getBurnAndRunway } from "../modules/calc/burn.js";
import { getContributionMargin } from "../modules/calc/contribution.js";
import { getPayablesSummary } from "../modules/calc/payables.js";
import { getProductProfitability } from "../modules/calc/productProfitability.js";
import { getRevenueLadder, getRevenueTrend } from "../modules/calc/revenueLadder.js";
import { getSalesSummary } from "../modules/calc/sales.js";
import { getRtoRateSummary } from "../modules/calc/shipments.js";
import { requireAuth } from "../middleware/auth.js";

export const metricsRouter = Router();

// Every endpoint here takes the same optional `?from=&to=` (ISO YYYY-MM-DD,
// both or neither) through one shared parser, so two cards on the same screen
// can't end up reporting different windows.
//
// withDateRange is SYNC middleware rather than a call inside each async
// handler, and it must stay that way: on Express 4 a throw inside an async
// handler never reaches middleware/errorHandler.ts and hangs the request
// instead of returning 400. Full explanation in lib/dateRange.ts.
//
// It's applied to the point-in-time endpoints too (inventory, freshness) even
// though they ignore the resolved range — so a malformed date is still a clean
// 400 there rather than being silently accepted and disregarded. Those
// endpoints return periodFiltered: false, which is how the UI knows to label
// itself "as of now" instead of implying the filter applied. See the comments
// on each calc module for why they can't be filtered.

// §28 honesty layer — one deterministic status per material metric
// (estimated | provisional | reconciled) with the reasons attached. The same
// map is embedded per-metric in the material endpoints below; this endpoint
// exists so a page can label a figure it derived locally without another
// metric fetch.
metricsRouter.get("/status", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const statuses = await getDataStatusMap(req.auth!.organizationId);
  res.json({
    formulaVersion: DATA_STATUS_FORMULA_VERSION,
    // Statuses describe the pipeline's current verification state, not the
    // picked window — same contract as /freshness.
    periodFiltered: false,
    pointInTime: true,
    computedAt: new Date().toISOString(),
    statuses,
  });
});

metricsRouter.get("/revenue", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const [summary, statuses] = await Promise.all([
    getNetRevenueSummary(req.auth!.organizationId, req.dateRange!, req.entityScope),
    getDataStatusMap(req.auth!.organizationId),
  ]);
  res.json({ ...summary, dataStatus: statuses.revenue });
});

metricsRouter.get("/rto-rate", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const summary = await getRtoRateSummary(req.auth!.organizationId, req.dateRange!, req.entityScope);
  res.json(summary);
});

metricsRouter.get("/cash-received", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const [summary, statuses] = await Promise.all([
    getCashReceivedSummary(req.auth!.organizationId, req.dateRange!),
    getDataStatusMap(req.auth!.organizationId),
  ]);
  res.json({ ...summary, dataStatus: statuses.cash_received });
});

// A balance, so the range's END date is what matters — this reports the
// balance as of `to`, not a sum across the window.
metricsRouter.get("/available-cash", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const summary = await getAvailableCashSummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

// Forward-looking, so the date filter is deliberately ignored: a forecast
// always starts from today's balance and runs forward. Filtering it to a past
// window would be asking what we once expected to happen, which no card on
// this page means. Still runs through withDateRange so a malformed date is a
// clean 400 rather than silently disregarded.
//
// ?horizon=7|30|90 (§16). An unrecognised or absent value falls back to 30
// rather than 400ing: the horizon is a view preference, and a stale bookmark
// carrying ?horizon=45 should show the default forecast, not an error page
// where a cash line ought to be. The response always states the horizon it
// actually used, so the caller can tell it was not honoured.
metricsRouter.get("/cash-forecast", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const requested = Number.parseInt(String(req.query.horizon ?? ""), 10);
  const horizon = isForecastHorizon(requested) ? requested : DEFAULT_HORIZON;
  const [forecast, statuses] = await Promise.all([
    getCashForecast(req.auth!.organizationId, req.auth!.timezone, new Date(), horizon),
    getDataStatusMap(req.auth!.organizationId),
  ]);
  res.json({ ...forecast, dataStatus: statuses.cash_forecast });
});

// POST rather than GET, and not because it writes anything — it writes
// nothing. Seven optional levers (one of them an object) do not survive a
// query string legibly, and a scenario URL is not something anyone bookmarks
// or caches. The body IS the question being asked.
//
// Returns BOTH lines from one call. The alternative — the client fetching the
// base separately and diffing — lets the two be computed at different
// instants, so a new order landing between the requests would show up as a
// "scenario effect" the founder never asked for.
const scenarioSchema = z
  .object({
    horizon: z.number().optional(),
    adSpendDeltaPct: z.number().optional(),
    codShareDeltaPct: z.number().optional(),
    rtoDeltaPct: z.number().optional(),
    collectionAccelDays: z.number().optional(),
    inventoryPurchase: z.object({ amountPaise: z.string(), date: z.string() }).optional(),
    vendorPaymentDelayDays: z.number().optional(),
    growthDeltaPct: z.number().optional(),
  })
  .strict();

metricsRouter.post("/cash-forecast/scenario", ...requireAuth, async (req, res, next) => {
  let parsed: z.infer<typeof scenarioSchema>;
  try {
    // Parsed inside try/next(err), not thrown from the async body — on
    // Express 4 a throw here hangs the request instead of returning 400.
    // See lib/dateRange.ts.
    parsed = scenarioSchema.parse(req.body ?? {});
  } catch (err) {
    next(err);
    return;
  }

  const { horizon: requested, ...params } = parsed;
  const horizon = isForecastHorizon(requested) ? requested : DEFAULT_HORIZON;
  const { base, scenario } = await runCashScenario(
    req.auth!.organizationId,
    params as ScenarioParams,
    req.auth!.timezone,
    horizon
  );
  res.json({ base, scenario });
});

// P2.2d snapshot history. Everything else on this router answers "what is this
// number now"; this answers "what has it been", which is a question no other
// endpoint can serve — the six calc modules that persist a MetricSnapshot as a
// side effect all overwrite the current period's row in place, so their history
// is one row deep by construction.
//
// Returns the series AND the overnight diff from one call. A client fetching
// them separately would compute the two at different instants, the same trap
// the scenario endpoint avoids by returning both lines together.
const DEFAULT_HISTORY_DAYS = 30;

metricsRouter.get("/snapshot-history", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const requested = Number.parseInt(String(req.query.days ?? ""), 10);
  const days = Number.isFinite(requested) ? requested : DEFAULT_HISTORY_DAYS;
  const [history, diff] = await Promise.all([
    getSnapshotHistory(req.auth!.organizationId, days),
    getDailySnapshotDiff(req.auth!.organizationId),
  ]);
  res.json({
    formulaVersion: DAILY_SNAPSHOT_VERSION,
    // History is a fixed trailing window of captured days, not the dashboard's
    // picked range — the rows only exist for days the nightly job actually ran,
    // and pretending a filter applied would imply days that were never
    // captured are simply outside the selection.
    periodFiltered: false,
    // The full catalogue, not just the metrics with rows. A client rendering
    // "no history yet for X" needs to know X exists; series only carries the
    // ones that have points.
    catalogue: DAILY_SNAPSHOT_METRICS,
    ...history,
    diff,
  });
});

// Manual capture, for the same reason POST /anomalies/run exists: waiting until
// 02:05 tomorrow to find out whether the nightly job produces sane rows is not
// a workable feedback loop. It still cannot write to an arbitrary day —
// captureDailySnapshot derives its target from the clock and takes no date, so
// this can only ever (re)write yesterday.
metricsRouter.post("/snapshot-history/run", ...requireAuth, async (req, res) => {
  const capture = await captureDailySnapshot(req.auth!.organizationId);
  res.json({
    formulaVersion: DAILY_SNAPSHOT_VERSION,
    organizationId: capture.organizationId,
    timeZone: capture.timeZone,
    day: capture.day,
    written: capture.written,
    // Which metrics had no honest value for this org, by name. The interesting
    // half of the answer on a partly-connected account, and the only way to
    // tell "recorded as zero" from "not recorded" without querying the table.
    omitted: capture.omitted,
    rows: capture.rows.map((r) => ({
      metricKey: r.metricKey,
      // paise, as a string. Money never crosses the wire as a JSON number.
      valueMinor: r.valueMinor === null ? null : r.valueMinor.toString(),
      valueNumeric: r.valueNumeric,
      confidence: r.confidence,
    })),
  });
});

// Ignores the resolved range on purpose: only current stock levels exist
// (nothing keeps a history), so this always answers "as of now" and says so
// via periodFiltered: false.
metricsRouter.get("/inventory-value", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const summary = await getInventoryValueSummary(req.auth!.organizationId);
  res.json(summary);
});

// One endpoint for all three "days of cover" cards, not three separate
// ones like every other metric — they share the exact same underlying
// per-SKU sales-velocity computation (modules/calc/inventory.ts's
// getVariantCoverInfo), so splitting them would mean three round trips
// redoing the same joins.
metricsRouter.get("/inventory-cover", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const summary = await getInventoryCoverSummary(req.auth!.organizationId);
  res.json(summary);
});

// Meta Ads + Google Ads combined (the AdSpend table is shared, `provider`
// separates them), with a per-platform split in `byProvider`.
metricsRouter.get("/ad-spend", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const summary = await getAdSpendSummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

// ROAS + blended CAC. Separate from /ad-spend because it additionally reads
// Order/revenue — a page showing only the spend card shouldn't pay for that.
metricsRouter.get("/ad-efficiency", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const summary = await getAdEfficiencySummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

// Five Overview cards off one Order scan — gross sales, order count, AOV,
// discount rate, refund rate. Bundled for the same reason /inventory-cover
// is: they're ratios of each other, so separate endpoints would re-read the
// identical rows five times to divide them.
metricsRouter.get("/sales", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const summary = await getSalesSummary(req.auth!.organizationId, req.dateRange!, req.entityScope);
  res.json(summary);
});

// The full §5–§11 revenue ladder plus the ratios and waterfall the /revenue
// page renders. Deliberately ONE endpoint rather than a dozen: every figure on
// that page is derived from the same scan of the same orders, and computing
// them separately is how two numbers on one screen end up disagreeing — the
// exact failure §1 of the finance-engine spec exists to prevent.
metricsRouter.get("/revenue-ladder", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const [ladder, trend, statuses] = await Promise.all([
    getRevenueLadder(req.auth!.organizationId, req.dateRange!, req.entityScope),
    // The trend is a trailing-6-month series and ignores the date filter on
    // purpose — it exists to give the selected period context, and a "6-month
    // trend" that shrinks to the picked week would be pointless. It ships with
    // the ladder so the first paint costs one request; zooming then talks to
    // /revenue-trend below instead of recomputing the whole ladder.
    getRevenueTrend(req.auth!.organizationId),
    // The revenue page renders from this endpoint, not /revenue — the status
    // label has to travel with the numbers it describes.
    getDataStatusMap(req.auth!.organizationId),
  ]);
  // cashCoverage rides alongside the series rather than inside it: the chart
  // needs to decide whether to draw the cash line AT ALL, which is a property
  // of the whole series, not of any one month.
  res.json({
    ...ladder,
    trend: trend.series,
    trendWindow: trend.window,
    cashCoverage: trend.cashCoverage,
    dataStatus: statuses.revenue,
  });
});

// The zoom endpoint for that same trend. Split out because zooming changes ONE
// thing — the window the line is bucketed over — and re-running the full ladder,
// its channel breakdown, its waterfall and its prior-period comparison on every
// pinch would be several seconds of work to redraw one series.
//
// The window is the request; the granularity is the response. The client sends
// from/to and the server says which bucket size it used, so a zoom gesture can
// never produce labels that disagree with the buckets underneath them.
metricsRouter.get("/revenue-trend", ...requireAuth, withTrendWindow, async (req, res) => {
  const trend = await getRevenueTrend(req.auth!.organizationId, req.trendWindow!);
  res.json({ trend: trend.series, window: trend.window, cashCoverage: trend.cashCoverage });
});

// §36 layered contribution margin. Every cost layer reports whether it has a
// data source at all — a CM3 computed with packaging, RTO, COD and marketplace
// fees silently absent would read as a healthy margin while being materially
// wrong, so uncovered layers mark the levels below them `reliable: false`.
metricsRouter.get("/contribution-margin", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const [margin, statuses] = await Promise.all([
    getContributionMargin(req.auth!.organizationId, req.dateRange!, req.entityScope),
    getDataStatusMap(req.auth!.organizationId),
  ]);
  res.json({ ...margin, dataStatus: statuses.contribution_margin });
});

// §40 per-SKU profitability. Stops at CM0 (revenue − product cost) and says so
// — per-SKU shipping/RTO/ads would need allocation inputs that don't exist.
metricsRouter.get("/product-profitability", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const [products, statuses] = await Promise.all([
    getProductProfitability(req.auth!.organizationId, req.dateRange!, undefined, req.entityScope),
    getDataStatusMap(req.auth!.organizationId),
  ]);
  res.json({ ...products, dataStatus: statuses.product_profitability });
});

// §55 cash movement + §85 runway. Not date-filtered: burn is a trailing rate by
// definition, and computing it over an arbitrary picked window would make the
// runway swing wildly with the date picker.
metricsRouter.get("/burn-runway", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  res.json(await getBurnAndRunway(req.auth!.organizationId));
});

// §57 accounts payable + ageing. Not date-filtered: "what do I owe and when is
// it due" is a forward-looking position as of now, not a sum over a past window.
metricsRouter.get("/payables", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  res.json(await getPayablesSummary(req.auth!.organizationId));
});

// Pipeline state rather than a business number — see the caveat at the top of
// modules/calc/freshness.ts about webhook-fed connectors reading as stale.
metricsRouter.get("/freshness", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  const summary = await getDataFreshness(req.auth!.organizationId);
  res.json(summary);
});

// §14 state profitability (P6.1). RTO is regional in India — a state at 25%
// and a state at 6% are different businesses sharing a catalogue, and the
// aggregate rate hides both. The state is derived at read time from the raw
// payload and nothing else is: no street, no pincode, no name.
metricsRouter.get("/state-profitability", ...requireAuth, withDateRange, withEntityScope, async (req, res) => {
  res.json(await getStateProfitability(req.auth!.organizationId, req.dateRange!, req.entityScope));
});

// §14 cash conversion cycle (P6.2). The number that explains why a profitable
// month can still leave the bank account emptier. Reported as null when any of
// its three terms cannot be measured — a partial cycle is not a shorter cycle.
metricsRouter.get("/cash-conversion-cycle", ...requireAuth, withDateRange, async (req, res) => {
  res.json(await getCashConversionCycle(req.auth!.organizationId, req.dateRange!));
});
