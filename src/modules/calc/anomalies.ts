import type { AnomalySeverity, AnomalyType, Prisma } from "@prisma/client";
import { DEFAULT_TIMEZONE, addZonedDays, resolveDateRange, zonedDayKey, type ResolvedRange } from "../../lib/dateRange.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { getOrgSettings } from "../orgs/settings.js";
import { getAdSpendSummary } from "./ads.js";
import { getAvailableCashSummary } from "./cash.js";
import { paiseToRupees } from "./money.js";
import { getProductProfitability } from "./productProfitability.js";
import { getNetRevenueSummary } from "./revenue.js";
import { getRevenueLadder } from "./revenueLadder.js";
import { getRtoRateSummary } from "./shipments.js";

// §17 anomaly detection — rule-based, per the spec's explicit instruction for
// v1. Every rule here is a pure function of a pre-fetched summary (easy to
// unit-test without a database), fed by a thin gather() wrapper that pulls
// the summary from the SAME calc modules every metric card already calls —
// this module invents no arithmetic of its own, it only decides whether an
// already-computed number crossed a line.
//
// 11 rule FUNCTIONS below (matching the plan's count); REVENUE_DECLINE and
// REVENUE_SPIKE share one function since they're two directions of the same
// comparison, which is why AnomalyType has 12 values.
//
// Deferred (no data source yet, per the plan): gateway-fee increase (needs
// per-fee-line history — P1.4 only just started landing settlement items),
// unusual bank debit (needs a materially fuller bank feed), discount abuse
// (needs per-discount-code data nothing here captures).
//
// Thresholds are ported from cfo-frontend/lib/insights.js's deriveAnomalies
// where that function already defined one (revenue decline ≤-20%,
// cancellation/refund rate ≥5%, any negative-margin SKU) — P2.1d retires
// that client-side heuristic in favour of this endpoint, and a founder
// should not see the alert bar change meaning the day that swap ships.
// Every other threshold (ad spend, RTO, courier cost, product cost) is new
// and reasoned about in its own rule below; none come from the PRD, which
// lists anomaly TYPES but no numbers (§17).

const TRAILING_WINDOW_DAYS = 28;

// Rupee subtraction on two paiseToRupees() results produces float artifacts
// (12345.67 - 12325.67 = 20.000000000000004), and observedValue/expectedValue/
// difference are rendered directly by the Exceptions page. Rounded to paise —
// the smallest unit that exists — so nothing is lost and nothing leaks.
function rupees2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AnomalyCandidate {
  type: AnomalyType;
  severity: AnomalySeverity;
  observedValue: number;
  expectedValue: number;
  difference: number;
  evidence: Prisma.InputJsonValue;
  recommendedInvestigation: string;
}

interface RuleContext {
  organizationId: string;
  range: ResolvedRange;
}

// The trailing 28-day window every period-comparison rule shares, cut on the
// organisation's own calendar (§3) — built the same way resolveDateRange
// builds any other explicit range, just with the two endpoints chosen here
// instead of coming off a request's query string.
async function trailingWindow(organizationId: string, now: Date): Promise<ResolvedRange> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } });
  const timezone = org?.timezone ?? DEFAULT_TIMEZONE;
  const toKey = zonedDayKey(now, timezone);
  const fromKey = addZonedDays(toKey, -(TRAILING_WINDOW_DAYS - 1));
  return resolveDateRange({ from: fromKey, to: toKey }, now, timezone);
}

// (type, organizationId, the org-calendar day the period ended on) — a
// same-day re-run of the nightly job upserts the same row; a new day's run
// is a new fact and gets its own row, which is what lets "since when has
// this been true" be answered by querying history instead of only ever
// seeing today's snapshot. Plain and readable rather than hashed: nothing
// about a dedupe key needs to be opaque, and a readable one is a query
// filter a human can type by hand while investigating.
function dedupeKeyFor(organizationId: string, type: AnomalyType, range: ResolvedRange): string {
  const dayKey = zonedDayKey(range.to, range.timeZone);
  return `${type}:${organizationId}:${dayKey}`;
}

// ---------------------------------------------------------------------------
// 1. Revenue decline / spike (vs trailing 28d)
// ---------------------------------------------------------------------------

export function decideRevenueChange(summary: {
  changePct: number | null;
  value: number;
  priorValue: number;
  valueMinor: string;
  priorValueMinor: string;
}): AnomalyCandidate | null {
  if (summary.changePct == null) return null; // no prior-period revenue to compare against
  if (summary.changePct <= -20) {
    return {
      type: "REVENUE_DECLINE",
      severity: "CRITICAL",
      observedValue: summary.value,
      expectedValue: summary.priorValue,
      difference: rupees2(summary.value - summary.priorValue),
      evidence: { changePct: summary.changePct, valueMinor: summary.valueMinor, priorValueMinor: summary.priorValueMinor },
      recommendedInvestigation: "Check for a channel outage, a paused ad campaign, a stockout on a top SKU, or a checkout/payment failure in the last 28 days.",
    };
  }
  if (summary.changePct >= 50) {
    return {
      type: "REVENUE_SPIKE",
      severity: "INFO",
      observedValue: summary.value,
      expectedValue: summary.priorValue,
      difference: rupees2(summary.value - summary.priorValue),
      evidence: { changePct: summary.changePct, valueMinor: summary.valueMinor, priorValueMinor: summary.priorValueMinor },
      recommendedInvestigation: "Confirm this is real demand (a launch, a sale, a viral moment) and not a duplicate order import or a sync running twice.",
    };
  }
  return null;
}

async function checkRevenue(ctx: RuleContext): Promise<AnomalyCandidate | null> {
  const summary = await getNetRevenueSummary(ctx.organizationId, ctx.range);
  return decideRevenueChange(summary);
}

// ---------------------------------------------------------------------------
// 2. Ad-spend spike
// ---------------------------------------------------------------------------

export function decideAdSpendSpike(summary: {
  changePct: number | null;
  value: number | null;
  priorValue: number | null;
  valueMinor: string | null;
  priorValueMinor: string | null;
  currency: string | null;
}): AnomalyCandidate | null {
  // null changePct also covers the mixed-currency/incomparable case —
  // getAdSpendSummary already refuses to compare across currencies, and this
  // rule refuses along with it rather than comparing apples to dollars.
  if (summary.changePct == null || summary.value == null || summary.priorValue == null) return null;
  if (summary.changePct < 50) return null;
  return {
    type: "AD_SPEND_SPIKE",
    severity: "WARNING",
    observedValue: summary.value,
    expectedValue: summary.priorValue,
    difference: rupees2(summary.value - summary.priorValue),
    evidence: { changePct: summary.changePct, valueMinor: summary.valueMinor, priorValueMinor: summary.priorValueMinor, currency: summary.currency },
    recommendedInvestigation: "Check the ad platform for a budget cap that was raised, a new campaign left on auto-bid, or an accidental duplicate campaign.",
  };
}

async function checkAdSpend(ctx: RuleContext): Promise<AnomalyCandidate | null> {
  const summary = await getAdSpendSummary(ctx.organizationId, ctx.range);
  return decideAdSpendSpike(summary);
}

// ---------------------------------------------------------------------------
// 3. RTO increase
// ---------------------------------------------------------------------------

export function decideRtoIncrease(summary: {
  rtoRatePct: number | null;
  priorRtoRatePct: number | null;
  changePct: number | null;
  dispatchedCount: number;
  rtoCount: number;
}): AnomalyCandidate | null {
  if (summary.changePct == null || summary.rtoRatePct == null || summary.priorRtoRatePct == null) return null;
  // Percentage-POINT change (rtoRatePct is already a rate) — a jump from a 2%
  // RTO rate to a 7% one is the same 5-point move this fires on regardless of
  // how small the base rate was, unlike a relative-% threshold which would
  // fire on tiny bases for noise alone.
  if (summary.changePct < 5) return null;
  return {
    type: "RTO_INCREASE",
    severity: "WARNING",
    observedValue: summary.rtoRatePct,
    expectedValue: summary.priorRtoRatePct,
    difference: summary.changePct,
    evidence: { rtoCount: summary.rtoCount, dispatchedCount: summary.dispatchedCount },
    recommendedInvestigation: "Check for a courier serviceability issue, a pincode with repeated RTOs, or a COD verification gap letting through unconfirmed orders.",
  };
}

async function checkRto(ctx: RuleContext): Promise<AnomalyCandidate | null> {
  const summary = await getRtoRateSummary(ctx.organizationId, ctx.range);
  return decideRtoIncrease(summary);
}

// ---------------------------------------------------------------------------
// 4. Refund increase & 10. Cancellation increase — both read off one
// getRevenueLadder() call, so a single gather feeds two rules rather than
// loading every order in the window twice.
// ---------------------------------------------------------------------------

export function decideRefundIncrease(refunds: {
  revenueRefundRatePct: number | null;
  priorRevenueRefundRatePct: number | null;
  ordersWithRefund: number;
  value: number;
}): AnomalyCandidate | null {
  if (refunds.revenueRefundRatePct == null) return null;
  if (refunds.revenueRefundRatePct < 5) return null;
  return {
    type: "REFUND_INCREASE",
    severity: "WARNING",
    observedValue: refunds.revenueRefundRatePct,
    expectedValue: 5,
    difference: refunds.revenueRefundRatePct - 5,
    evidence: { ordersWithRefund: refunds.ordersWithRefund, refundValue: refunds.value, priorRatePct: refunds.priorRevenueRefundRatePct },
    recommendedInvestigation: "Check for a product quality issue, a sizing/description mismatch, or a single high-value order skewing the rate.",
  };
}

export function decideCancellationIncrease(cancellations: {
  ratePct: number | null;
  priorRatePct: number | null;
  count: number;
  value: number;
}): AnomalyCandidate | null {
  if (cancellations.ratePct == null) return null;
  if (cancellations.ratePct < 5) return null;
  return {
    type: "CANCELLATION_INCREASE",
    severity: "WARNING",
    observedValue: cancellations.ratePct,
    expectedValue: 5,
    difference: cancellations.ratePct - 5,
    evidence: { cancelledCount: cancellations.count, cancelledValue: cancellations.value, priorRatePct: cancellations.priorRatePct },
    recommendedInvestigation: "Check for a COD confirmation-call gap, a payment-failure loop, or a stock promise the checkout couldn't actually keep.",
  };
}

async function checkRefundsAndCancellations(ctx: RuleContext): Promise<AnomalyCandidate[]> {
  const ladder = await getRevenueLadder(ctx.organizationId, ctx.range);
  const out: AnomalyCandidate[] = [];
  const refund = decideRefundIncrease(ladder.refunds);
  if (refund) out.push(refund);
  const cancellation = decideCancellationIncrease(ladder.cancellations);
  if (cancellation) out.push(cancellation);
  return out;
}

// ---------------------------------------------------------------------------
// 5. Courier-cost increase
// ---------------------------------------------------------------------------

export function decideCourierCostIncrease(input: {
  currentPaise: bigint;
  priorPaise: bigint;
  currentLines: number;
  priorLines: number;
}): AnomalyCandidate | null {
  // Both windows need real coverage — a window with zero invoiced lines isn't
  // "courier cost fell to zero", it's "no invoice has been imported for this
  // window yet", and treating that as a 100% decline would be a false alarm
  // manufactured by an ingestion gap, not a real cost change.
  if (input.priorLines === 0 || input.currentLines === 0) return null;
  if (input.priorPaise === 0n) return null;
  const changePct = (Number(input.currentPaise - input.priorPaise) / Number(input.priorPaise)) * 100;
  if (changePct < 20) return null;
  const current = paiseToRupees(input.currentPaise);
  const prior = paiseToRupees(input.priorPaise);
  return {
    type: "COURIER_COST_INCREASE",
    severity: "WARNING",
    observedValue: current,
    expectedValue: prior,
    difference: rupees2(current - prior),
    evidence: {
      changePct: Math.round(changePct * 10) / 10,
      currentPaise: input.currentPaise.toString(),
      priorPaise: input.priorPaise.toString(),
      currentLines: input.currentLines,
      priorLines: input.priorLines,
    },
    recommendedInvestigation: "Check for a courier rate-card change, a shift toward heavier/farther shipments, or an increase in RTO freight (billed twice — outbound and return).",
  };
}

async function checkCourierCost(ctx: RuleContext): Promise<AnomalyCandidate | null> {
  const [current, prior] = await Promise.all([
    prisma.freightInvoiceLine.aggregate({
      where: { organizationId: ctx.organizationId, shipDate: { gte: ctx.range.from, lte: ctx.range.to } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.freightInvoiceLine.aggregate({
      where: { organizationId: ctx.organizationId, shipDate: { gte: ctx.range.priorFrom, lte: ctx.range.priorTo } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);
  return decideCourierCostIncrease({
    currentPaise: current._sum.amount ?? 0n,
    priorPaise: prior._sum.amount ?? 0n,
    currentLines: current._count._all,
    priorLines: prior._count._all,
  });
}

// ---------------------------------------------------------------------------
// 6. Negative-margin SKU
// ---------------------------------------------------------------------------

export function decideNegativeMarginSkus(
  bottomByMargin: Array<{ sku: string; productName: string; cm0: number | null; cm0Pct: number | null; netRevenue: number }>
): AnomalyCandidate | null {
  const negative = bottomByMargin.filter((p) => (p.cm0 ?? 0) < 0);
  if (negative.length === 0) return null;
  const totalNegativeCm0 = negative.reduce((sum, p) => sum + (p.cm0 ?? 0), 0);
  const worst = negative[0]!; // already sorted worst-first by getProductProfitability
  return {
    type: "NEGATIVE_MARGIN_SKU",
    severity: "CRITICAL",
    observedValue: negative.length,
    expectedValue: 0,
    difference: negative.length,
    evidence: {
      skus: negative.map((p) => ({ sku: p.sku, productName: p.productName, cm0: p.cm0, cm0Pct: p.cm0Pct, netRevenue: p.netRevenue })),
      totalNegativeCm0: rupees2(totalNegativeCm0),
      worst: { sku: worst.sku, productName: worst.productName, cm0Pct: worst.cm0Pct },
    },
    recommendedInvestigation: `Review pricing or landed cost for ${worst.productName} (${worst.sku}) first — it has the worst margin of ${negative.length} product${negative.length === 1 ? "" : "s"} currently selling below cost.`,
  };
}

async function checkNegativeMarginSkus(ctx: RuleContext): Promise<AnomalyCandidate | null> {
  const products = await getProductProfitability(ctx.organizationId, ctx.range, 50);
  if (!products.canRankByMargin) return null; // no costed SKUs — nothing to judge margin on
  return decideNegativeMarginSkus(products.bottomByMargin);
}

// ---------------------------------------------------------------------------
// 7. Missing settlement (payout gap vs statement cadence)
// ---------------------------------------------------------------------------

export function decideMissingSettlement(input: {
  connectionId: string;
  label: string;
  gapDays: number;
  baselineGapDays: number;
  daysSinceLast: number;
}): AnomalyCandidate | null {
  // A floor under the baseline itself: a connection whose historical payouts
  // land every few hours would otherwise trip this on ordinary end-of-day
  // jitter once the multiplier is applied to a near-zero baseline.
  const baseline = Math.max(input.baselineGapDays, 1);
  if (input.daysSinceLast < baseline * 2) return null;
  // Rounded for STORAGE, not just for the sentence: these two are what the
  // Exceptions page renders as observed-vs-expected, and a card reading
  // "5.770833321759259 days" is the kind of raw-float leak that makes a
  // number look computed-at rather than reported.
  const observed = Math.round(input.daysSinceLast * 10) / 10;
  const expected = Math.round(baseline * 10) / 10;
  return {
    type: "MISSING_SETTLEMENT",
    severity: "WARNING",
    observedValue: observed,
    expectedValue: expected,
    difference: Math.round((input.daysSinceLast - baseline) * 10) / 10,
    evidence: { connectionId: input.connectionId, label: input.label, baselineGapDays: expected },
    recommendedInvestigation: `${input.label} has gone ${observed} days without a settlement, against a typical gap of ${expected} — check the gateway dashboard for a payout hold, a KYC flag, or a bank-account mismatch.`,
  };
}

async function checkMissingSettlement(ctx: RuleContext): Promise<AnomalyCandidate | null> {
  const connections = await prisma.settlement.groupBy({
    by: ["connectionId"],
    where: { organizationId: ctx.organizationId, kind: "GATEWAY" },
    _count: { _all: true },
  });
  // At least a few historical payouts are needed to know what "normal" looks
  // like for this connection — one or two settlements is not a cadence, it's
  // a single data point, and flagging against it would be a guess dressed up
  // as a baseline.
  const candidates: AnomalyCandidate[] = [];
  for (const c of connections) {
    if (c._count._all < 3) continue;
    const settlements = await prisma.settlement.findMany({
      where: { organizationId: ctx.organizationId, connectionId: c.connectionId, kind: "GATEWAY", settledAt: { not: null } },
      select: { settledAt: true },
      orderBy: { settledAt: "asc" },
    });
    if (settlements.length < 3) continue;
    const dates = settlements.map((s) => s.settledAt!.getTime());
    const gapsDays: number[] = [];
    for (let i = 1; i < dates.length; i += 1) gapsDays.push((dates[i]! - dates[i - 1]!) / 86_400_000);
    const baselineGapDays = gapsDays.reduce((a, b) => a + b, 0) / gapsDays.length;
    const lastSettledAt = dates[dates.length - 1]!;
    const daysSinceLast = (ctx.range.to.getTime() - lastSettledAt) / 86_400_000;

    const connection = await prisma.connection.findUnique({
      where: { id: c.connectionId },
      select: { provider: true, externalAccountId: true },
    });
    const label = connection ? `${connection.provider}${connection.externalAccountId ? ` (${connection.externalAccountId})` : ""}` : c.connectionId;

    const candidate = decideMissingSettlement({ connectionId: c.connectionId, label, gapDays: gapsDays[gapsDays.length - 1] ?? 0, baselineGapDays, daysSinceLast });
    if (candidate) candidates.push(candidate);
  }
  // One connection's gap is one anomaly worth reading in detail; several at
  // once is unlikely (they'd share a root cause) but if it happens, the worst
  // gap is the one worth a human's first look — same "surface the sharpest
  // single fact" choice as decideNegativeMarginSkus's `worst`.
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.observedValue - a.observedValue)[0]!;
}

// ---------------------------------------------------------------------------
// 8. Duplicate payment
// ---------------------------------------------------------------------------

export function decideDuplicatePayments(
  groups: Array<{ orderId: string; amount: bigint; paymentIds: string[] }>
): AnomalyCandidate | null {
  if (groups.length === 0) return null;
  const totalDuplicatedPaise = groups.reduce((sum, g) => sum + g.amount * BigInt(g.paymentIds.length - 1), 0n);
  return {
    type: "DUPLICATE_PAYMENT",
    severity: "CRITICAL",
    observedValue: groups.length,
    expectedValue: 0,
    difference: groups.length,
    evidence: {
      orders: groups.map((g) => ({ orderId: g.orderId, amountPaise: g.amount.toString(), paymentIds: g.paymentIds })),
      totalDuplicatedPaise: totalDuplicatedPaise.toString(),
      totalDuplicated: paiseToRupees(totalDuplicatedPaise),
    },
    recommendedInvestigation: `${groups.length} order${groups.length === 1 ? " has" : "s have"} more than one captured payment of the identical amount — check for a double-charge (retry after a slow gateway response) and consider a refund.`,
  };
}

async function checkDuplicatePayments(ctx: RuleContext): Promise<AnomalyCandidate | null> {
  const payments = await prisma.payment.findMany({
    where: { organizationId: ctx.organizationId, status: "captured", orderId: { not: null }, capturedAt: { gte: ctx.range.from, lte: ctx.range.to } },
    select: { id: true, orderId: true, amount: true },
  });
  const byOrder = new Map<string, typeof payments>();
  for (const p of payments) {
    const key = p.orderId!;
    const list = byOrder.get(key) ?? [];
    list.push(p);
    byOrder.set(key, list);
  }
  const groups: Array<{ orderId: string; amount: bigint; paymentIds: string[] }> = [];
  for (const [orderId, list] of byOrder) {
    if (list.length < 2) continue;
    const byAmount = new Map<string, typeof list>();
    for (const p of list) {
      const key = p.amount.toString();
      const l = byAmount.get(key) ?? [];
      l.push(p);
      byAmount.set(key, l);
    }
    for (const [amountStr, same] of byAmount) {
      if (same.length >= 2) groups.push({ orderId, amount: BigInt(amountStr), paymentIds: same.map((p) => p.id) });
    }
  }
  return decideDuplicatePayments(groups);
}

// ---------------------------------------------------------------------------
// 9. Product-cost increase
// ---------------------------------------------------------------------------

export function decideProductCostIncrease(
  increases: Array<{ sku: string; landedCost: bigint; priorLandedCost: bigint; effectiveFrom: Date }>
): AnomalyCandidate | null {
  if (increases.length === 0) return null;
  const worst = [...increases].sort((a, b) => {
    const pctA = Number(a.landedCost - a.priorLandedCost) / Number(a.priorLandedCost);
    const pctB = Number(b.landedCost - b.priorLandedCost) / Number(b.priorLandedCost);
    return pctB - pctA;
  })[0]!;
  const worstPct = (Number(worst.landedCost - worst.priorLandedCost) / Number(worst.priorLandedCost)) * 100;
  return {
    type: "PRODUCT_COST_INCREASE",
    severity: "WARNING",
    observedValue: increases.length,
    expectedValue: 0,
    difference: increases.length,
    evidence: {
      skus: increases.map((i) => ({
        sku: i.sku,
        landedCostPaise: i.landedCost.toString(),
        priorLandedCostPaise: i.priorLandedCost.toString(),
        effectiveFrom: i.effectiveFrom.toISOString(),
      })),
      worst: { sku: worst.sku, changePct: Math.round(worstPct * 10) / 10 },
    },
    recommendedInvestigation: `${worst.sku}'s landed cost rose ${Math.round(worstPct)}% — confirm this against the supplier invoice and re-check pricing/margin on that SKU before it sells more at the old margin assumption.`,
  };
}

// A row is a cost increase if it is at least 15% above the immediately
// preceding row FOR THE SAME SKU, and became effective inside the window
// being checked — an old cost change re-surfacing every run because it's
// still the "latest" row would make this fire once and then never clear.
const PRODUCT_COST_INCREASE_THRESHOLD = 1.15;

async function checkProductCostIncreases(ctx: RuleContext): Promise<AnomalyCandidate | null> {
  const rows = await prisma.productCost.findMany({
    where: { organizationId: ctx.organizationId },
    select: { sku: true, landedCost: true, effectiveFrom: true },
    orderBy: [{ sku: "asc" }, { effectiveFrom: "asc" }],
  });
  const bySku = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySku.get(r.sku) ?? [];
    list.push(r);
    bySku.set(r.sku, list);
  }
  const increases: Array<{ sku: string; landedCost: bigint; priorLandedCost: bigint; effectiveFrom: Date }> = [];
  for (const [sku, list] of bySku) {
    if (list.length < 2) continue;
    const latest = list[list.length - 1]!;
    const prior = list[list.length - 2]!;
    if (latest.effectiveFrom < ctx.range.from || latest.effectiveFrom > ctx.range.to) continue;
    if (prior.landedCost <= 0n) continue;
    if (Number(latest.landedCost) / Number(prior.landedCost) < PRODUCT_COST_INCREASE_THRESHOLD) continue;
    increases.push({ sku, landedCost: latest.landedCost, priorLandedCost: prior.landedCost, effectiveFrom: latest.effectiveFrom });
  }
  return decideProductCostIncrease(increases);
}

// ---------------------------------------------------------------------------
// 11. Cash below threshold
// ---------------------------------------------------------------------------

export function decideCashBelowThreshold(input: {
  currentPaise: bigint;
  thresholdPaise: bigint | null;
}): AnomalyCandidate | null {
  if (input.thresholdPaise == null) return null; // not configured for this org — see modules/orgs/settings.ts
  if (input.currentPaise >= input.thresholdPaise) return null;
  const current = paiseToRupees(input.currentPaise);
  const threshold = paiseToRupees(input.thresholdPaise);
  return {
    type: "CASH_BELOW_THRESHOLD",
    severity: "CRITICAL",
    observedValue: current,
    expectedValue: threshold,
    difference: rupees2(current - threshold),
    evidence: { currentPaise: input.currentPaise.toString(), thresholdPaise: input.thresholdPaise.toString() },
    recommendedInvestigation: "Review the cash forecast for upcoming outflows (vendor bills, payroll, ad spend) against expected inflows before committing to new spend.",
  };
}

async function checkCashBelowThreshold(ctx: RuleContext): Promise<AnomalyCandidate | null> {
  const settings = await getOrgSettings(ctx.organizationId);
  if (settings.cashThresholdPaise == null) return null;
  const cash = await getAvailableCashSummary(ctx.organizationId, ctx.range);
  return decideCashBelowThreshold({ currentPaise: BigInt(cash.valueMinor), thresholdPaise: BigInt(settings.cashThresholdPaise) });
}

// ---------------------------------------------------------------------------
// Registry + runner
// ---------------------------------------------------------------------------

// Each entry gathers its own data and returns 0-1 candidates, except the
// combined refund/cancellation check, which shares one getRevenueLadder()
// call across 2 rules and can return up to 2 — so 10 registry entries cover
// the plan's 11 named rules (revenue decline/spike is also one entry
// covering two AnomalyType values, which is the other half of that count).
const RULES: Array<(ctx: RuleContext) => Promise<AnomalyCandidate | AnomalyCandidate[] | null>> = [
  checkRevenue,
  checkAdSpend,
  checkRto,
  checkRefundsAndCancellations,
  checkCourierCost,
  checkNegativeMarginSkus,
  checkMissingSettlement,
  checkDuplicatePayments,
  checkProductCostIncreases,
  checkCashBelowThreshold,
];

export interface AnomalyRunResult {
  organizationId: string;
  ranAt: Date;
  periodStart: Date;
  periodEnd: Date;
  created: number;
  updated: number;
  candidates: AnomalyCandidate[];
}

export async function runAnomalyRules(organizationId: string, now: Date = new Date()): Promise<AnomalyRunResult> {
  const range = await trailingWindow(organizationId, now);
  const ctx: RuleContext = { organizationId, range };

  const results = await Promise.all(RULES.map((rule) => rule(ctx)));
  const candidates = results.flat().filter((c): c is AnomalyCandidate => c !== null);

  let created = 0;
  let updated = 0;
  for (const candidate of candidates) {
    const dedupeKey = dedupeKeyFor(organizationId, candidate.type, range);
    const existing = await prisma.anomaly.findUnique({ where: { dedupeKey }, select: { id: true } });
    await prisma.anomaly.upsert({
      where: { dedupeKey },
      create: {
        organizationId,
        type: candidate.type,
        severity: candidate.severity,
        observedValue: candidate.observedValue,
        expectedValue: candidate.expectedValue,
        difference: candidate.difference,
        periodStart: range.from,
        periodEnd: range.to,
        evidence: candidate.evidence,
        recommendedInvestigation: candidate.recommendedInvestigation,
        dedupeKey,
      },
      // status/ownerId are NOT touched on update — a human's triage of a
      // still-firing anomaly must survive the nightly job re-running and
      // refreshing its numbers, not get silently reset to OPEN every night.
      update: {
        severity: candidate.severity,
        observedValue: candidate.observedValue,
        expectedValue: candidate.expectedValue,
        difference: candidate.difference,
        periodEnd: range.to,
        evidence: candidate.evidence,
        recommendedInvestigation: candidate.recommendedInvestigation,
      },
    });
    if (existing) updated += 1;
    else created += 1;
  }

  return { organizationId, ranAt: now, periodStart: range.from, periodEnd: range.to, created, updated, candidates };
}

// ---------------------------------------------------------------------------
// The all-organisations sweep the nightly job runs
// ---------------------------------------------------------------------------
//
// Lives HERE, not in modules/queue/anomalyScheduler.ts beside the job that
// calls it, for the reason syncCadence.ts's header already spells out: the
// scheduler constructs a BullMQ Queue at module scope, so importing it to
// reach this function opens a Redis connection and keeps the process alive
// forever. A check script that only wants to run the sweep and exit would
// hang — verified directly, which is how this ended up in the right place.
// Same split, same reason: logic that can be imported and reasoned about
// without infrastructure stays out of the module that owns infrastructure.

export interface AnomalySweepResult {
  organizations: number;
  ran: number;
  failed: number;
  created: number;
  updated: number;
}

export async function runAnomalySweep(now: Date = new Date()): Promise<AnomalySweepResult> {
  const organizations = await prisma.organization.findMany({ select: { id: true } });

  const result: AnomalySweepResult = {
    organizations: organizations.length,
    ran: 0,
    failed: 0,
    created: 0,
    updated: 0,
  };

  for (const org of organizations) {
    try {
      const run = await runAnomalyRules(org.id, now);
      result.ran += 1;
      result.created += run.created;
      result.updated += run.updated;
    } catch (err) {
      // One organisation's failure must not abandon the rest of the sweep —
      // the whole point is that this runs unattended, and a single org with
      // malformed data should not cost every other org its nightly check.
      result.failed += 1;
      logger.error({ err, organizationId: org.id }, "anomaly_sweep_org_failed");
    }
  }

  return result;
}
