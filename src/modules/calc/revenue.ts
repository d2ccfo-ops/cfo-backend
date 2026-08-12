import { resolveDateRange, shouldPersistSnapshot, type ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { paiseToRupees, sumPaise } from "./money.js";

// Net revenue for the period. This is the one calculation this endpoint exists
// to prove: the number always comes from this function (or one like it), never
// from the AI CFO doing arithmetic, and never recomputed ad hoc in a route
// handler.
//
// v2 — CORRECTS A DOUBLE-SUBTRACTED DISCOUNT.
//
// v1 computed `grossAmount - discountAmount - taxAmount`, on the assumption
// that grossAmount was a pre-discount figure. It isn't: the Shopify connector
// maps Shopify's `total_price` into it, and total_price is what the customer
// actually pays — already net of discounts (verified against the stored raw
// payloads: total_line_items_price − total_discounts = subtotal_price =
// total_price when shipping is zero). Subtracting discountAmount again removed
// the discount twice.
//
// Measured on the live dataset, v1 understated net revenue by ₹16,75,328 —
// 6.64% — which tracks the ~5–6% discount rate exactly as the bug predicts.
//
// v2 = grossAmount − taxAmount − refunds(ex GST), restricted to non-cancelled
// orders, which is the spec's §11 Net Revenue on an ORDER_CREATED basis (§8).
// Tax is still subtracted because these stores run taxes_included = true, so
// total_price is GST-inclusive and §10 requires a tax-exclusive base.
//
// Per §92 this is a NEW VERSION rather than an edit: v1 snapshots stay in
// MetricSnapshot under formulaVersion "v1" and are not rewritten, so the
// change in the number is attributable instead of mysterious.
//
// modules/calc/revenueLadder.ts computes this same figure as part of the full
// §5–§11 ladder; this function is the narrow single-number version kept for the
// /metrics/revenue endpoint the Overview card already uses.

const FORMULA_VERSION = "v2";

interface RevenueOrder {
  grossAmount: bigint;
  taxAmount: bigint;
  refundedAmount: bigint;
  cancelledAt: Date | null;
}

// The tax-exclusive share of a refund — see the fuller explanation on
// refundExGst in modules/calc/revenueLadder.ts. Refunding a GST-inclusive
// amount reverses output GST too, so the revenue reduction is smaller than the
// cash refunded.
function refundExGst(o: RevenueOrder): bigint {
  if (o.refundedAmount === 0n || o.grossAmount <= 0n) return o.refundedAmount;
  return (o.refundedAmount * (o.grossAmount - o.taxAmount)) / o.grossAmount;
}

function netRevenueOf(orders: RevenueOrder[]) {
  // §16: a cancelled order recognises no revenue at all, rather than
  // recognising revenue and then reversing it.
  const recognised = orders.filter((o) => o.cancelledAt === null);
  return sumPaise(recognised.map((o) => o.grossAmount - o.taxAmount - refundExGst(o)));
}

export async function getNetRevenueSummary(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({})
) {
  const now = new Date();
  const periodStart = range.from;
  const periodEnd = range.to;

  const [currentOrders, priorOrders] = await Promise.all([
    prisma.order.findMany({
      where: { organizationId, placedAt: { gte: periodStart, lte: periodEnd } },
      select: { grossAmount: true, taxAmount: true, refundedAmount: true, cancelledAt: true },
    }),
    prisma.order.findMany({
      where: { organizationId, placedAt: { gte: range.priorFrom, lte: range.priorTo } },
      select: { grossAmount: true, taxAmount: true, refundedAmount: true, cancelledAt: true },
    }),
  ]);

  const current = netRevenueOf(currentOrders);
  const prior = netRevenueOf(priorOrders);
  const changePct = prior === 0n ? null : Math.round((Number(current - prior) / Number(prior)) * 1000) / 10;

  // Persisted so the number is reproducible and versioned, not just computed
  // on the fly — this is what MetricSnapshot.formulaVersion is for. Can't use
  // .upsert() on the compound unique here: Prisma's compound-key input type
  // requires legalEntityId to be a non-null string even though the column is
  // nullable, since SQL NULL doesn't participate in uniqueness the same way —
  // so this does the lookup manually instead. Skipped entirely for a custom
  // date range — see shouldPersistSnapshot in lib/dateRange.ts for why ad-hoc
  // ranges must not write rows into a table that means "the canonical value of
  // this metric for this period".
  if (shouldPersistSnapshot(range)) {
    const existingSnapshot = await prisma.metricSnapshot.findFirst({
      where: {
        organizationId,
        legalEntityId: null,
        metricKey: "net_revenue_mtd",
        granularity: "MONTHLY",
        periodStart,
        formulaVersion: FORMULA_VERSION,
      },
      select: { id: true },
    });
    if (existingSnapshot) {
      await prisma.metricSnapshot.update({
        where: { id: existingSnapshot.id },
        data: { periodEnd: now, valueMinor: current, computedAt: new Date() },
      });
    } else {
      await prisma.metricSnapshot.create({
        data: {
          organizationId,
          metricKey: "net_revenue_mtd",
          granularity: "MONTHLY",
          periodStart,
          periodEnd: now,
          valueMinor: current,
          formulaVersion: FORMULA_VERSION,
          confidence: "ESTIMATED",
        },
      });
    }
  }

  return {
    metricKey: "net_revenue_mtd",
    currency: "INR",
    valueMinor: current.toString(),
    value: paiseToRupees(current),
    priorValueMinor: prior.toString(),
    priorValue: paiseToRupees(prior),
    changePct,
    orderCount: currentOrders.filter((o) => o.cancelledAt === null).length,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    periodFiltered: true,
    comparison: range.comparison,
    formulaVersion: FORMULA_VERSION,
  };
}
