import { Router } from "express";
import { withDateRange } from "../lib/dateRange.js";
import { withTrendWindow } from "../lib/trendWindow.js";
import { getAdEfficiencySummary, getAdSpendSummary } from "../modules/calc/ads.js";
import { getAvailableCashSummary, getCashReceivedSummary } from "../modules/calc/cash.js";
import { getCashForecast } from "../modules/calc/cashForecast.js";
import { getDataFreshness } from "../modules/calc/freshness.js";
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

metricsRouter.get("/revenue", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getNetRevenueSummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

metricsRouter.get("/rto-rate", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getRtoRateSummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

metricsRouter.get("/cash-received", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getCashReceivedSummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

// A balance, so the range's END date is what matters — this reports the
// balance as of `to`, not a sum across the window.
metricsRouter.get("/available-cash", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getAvailableCashSummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

// Forward-looking, so the date filter is deliberately ignored: a forecast
// always starts from today's balance and runs 30 days out. Filtering it to a
// past window would be asking what we once expected to happen, which no card
// on this page means. Still runs through withDateRange so a malformed date is
// a clean 400 rather than silently disregarded.
metricsRouter.get("/cash-forecast", ...requireAuth, withDateRange, async (req, res) => {
  const forecast = await getCashForecast(req.auth!.organizationId, req.auth!.timezone);
  res.json(forecast);
});

// Ignores the resolved range on purpose: only current stock levels exist
// (nothing keeps a history), so this always answers "as of now" and says so
// via periodFiltered: false.
metricsRouter.get("/inventory-value", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getInventoryValueSummary(req.auth!.organizationId);
  res.json(summary);
});

// One endpoint for all three "days of cover" cards, not three separate
// ones like every other metric — they share the exact same underlying
// per-SKU sales-velocity computation (modules/calc/inventory.ts's
// getVariantCoverInfo), so splitting them would mean three round trips
// redoing the same joins.
metricsRouter.get("/inventory-cover", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getInventoryCoverSummary(req.auth!.organizationId);
  res.json(summary);
});

// Meta Ads + Google Ads combined (the AdSpend table is shared, `provider`
// separates them), with a per-platform split in `byProvider`.
metricsRouter.get("/ad-spend", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getAdSpendSummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

// ROAS + blended CAC. Separate from /ad-spend because it additionally reads
// Order/revenue — a page showing only the spend card shouldn't pay for that.
metricsRouter.get("/ad-efficiency", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getAdEfficiencySummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

// Five Overview cards off one Order scan — gross sales, order count, AOV,
// discount rate, refund rate. Bundled for the same reason /inventory-cover
// is: they're ratios of each other, so separate endpoints would re-read the
// identical rows five times to divide them.
metricsRouter.get("/sales", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getSalesSummary(req.auth!.organizationId, req.dateRange!);
  res.json(summary);
});

// The full §5–§11 revenue ladder plus the ratios and waterfall the /revenue
// page renders. Deliberately ONE endpoint rather than a dozen: every figure on
// that page is derived from the same scan of the same orders, and computing
// them separately is how two numbers on one screen end up disagreeing — the
// exact failure §1 of the finance-engine spec exists to prevent.
metricsRouter.get("/revenue-ladder", ...requireAuth, withDateRange, async (req, res) => {
  const [ladder, trend] = await Promise.all([
    getRevenueLadder(req.auth!.organizationId, req.dateRange!),
    // The trend is a trailing-6-month series and ignores the date filter on
    // purpose — it exists to give the selected period context, and a "6-month
    // trend" that shrinks to the picked week would be pointless. It ships with
    // the ladder so the first paint costs one request; zooming then talks to
    // /revenue-trend below instead of recomputing the whole ladder.
    getRevenueTrend(req.auth!.organizationId),
  ]);
  // cashCoverage rides alongside the series rather than inside it: the chart
  // needs to decide whether to draw the cash line AT ALL, which is a property
  // of the whole series, not of any one month.
  res.json({
    ...ladder,
    trend: trend.series,
    trendWindow: trend.window,
    cashCoverage: trend.cashCoverage,
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
metricsRouter.get("/contribution-margin", ...requireAuth, withDateRange, async (req, res) => {
  res.json(await getContributionMargin(req.auth!.organizationId, req.dateRange!));
});

// §40 per-SKU profitability. Stops at CM0 (revenue − product cost) and says so
// — per-SKU shipping/RTO/ads would need allocation inputs that don't exist.
metricsRouter.get("/product-profitability", ...requireAuth, withDateRange, async (req, res) => {
  res.json(await getProductProfitability(req.auth!.organizationId, req.dateRange!));
});

// §55 cash movement + §85 runway. Not date-filtered: burn is a trailing rate by
// definition, and computing it over an arbitrary picked window would make the
// runway swing wildly with the date picker.
metricsRouter.get("/burn-runway", ...requireAuth, withDateRange, async (req, res) => {
  res.json(await getBurnAndRunway(req.auth!.organizationId));
});

// §57 accounts payable + ageing. Not date-filtered: "what do I owe and when is
// it due" is a forward-looking position as of now, not a sum over a past window.
metricsRouter.get("/payables", ...requireAuth, withDateRange, async (req, res) => {
  res.json(await getPayablesSummary(req.auth!.organizationId));
});

// Pipeline state rather than a business number — see the caveat at the top of
// modules/calc/freshness.ts about webhook-fed connectors reading as stale.
metricsRouter.get("/freshness", ...requireAuth, withDateRange, async (req, res) => {
  const summary = await getDataFreshness(req.auth!.organizationId);
  res.json(summary);
});
