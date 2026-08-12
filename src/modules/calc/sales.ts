import { resolveDateRange, shouldPersistSnapshot, type ResolvedRange } from "../../lib/dateRange.js";
import { scopeWhere, type EntityScope } from "../../lib/entityScope.js";
import { getRevenueLadder } from "./revenueLadder.js";
import { persistSnapshot } from "./snapshots.js";

// Top-of-funnel order metrics for the Overview page: gross sales, order count,
// AOV, discount rate and refund rate.
//
// v2 — THIS MODULE NO LONGER COMPUTES ANYTHING. It projects
// modules/calc/revenueLadder.ts.
//
// v1 did its own arithmetic over the same Order rows, and once the ladder
// landed the two disagreed on the same period — measured on July 2026:
//
//   "gross sales"  ₹21,57,366 here vs GMV ₹22,77,287 in the ladder. v1 summed
//                  grossAmount, which is Shopify's total_price: already net of
//                  discounts. That is the spec's Net Order Value (§7), not
//                  gross sales — the card was labelled with the wrong rung.
//   orders         1,358 vs 1,276. v1 counted cancelled orders, which §16 says
//                  recognise nothing at all.
//   refund rate    0.7% vs 1.1%. v1 inferred refunds from the financial_status
//                  string and could only see FULLY refunded orders; the ladder
//                  reads the actual refunded amounts now stored on the order.
//   AOV            ₹1,589 vs ₹1,594, following from the order-count difference.
//
// Two screens showing different values for the same word is exactly the failure
// §1 of the finance engine spec exists to prevent, so rather than fixing four
// formulas to match a second implementation — which would drift again the next
// time either side changed — this delegates. Agreement is now structural.
//
// The endpoint and response shape are kept so the Overview page's fetch
// contract doesn't change; only the numbers behind them get correct.
//
// v3 follows the ladder's v3: gross sales is now tax-exclusive (§10), and the
// order count and AOV moved to an all-orders-placed denominator so the cards
// cross-check against Shopify's own sales report. Verified against it for July
// 2026 and 1–8 Aug 2026: gross sales and discounts agree to the rupee, order
// count exactly, AOV to 0.02% in August.

const FORMULA_VERSION = "v3";

export async function getSalesSummary(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({}),
  // §12.2 (P5.6). Null means the whole organisation, which is what every
  // caller passed before this existed and remains the default.
  scope: EntityScope | null = null
) {
  const ladder = await getRevenueLadder(organizationId, range, scope);

  const gmv = ladder.ladder.gmv;
  const orders = ladder.orders;
  const aov = ladder.aov;
  const discounts = ladder.discounts;
  const refunds = ladder.refunds;

  // Persisted under the metric key the Overview card has always used, but at
  // formulaVersion v2 — per §92 the v1 rows stay put rather than being
  // rewritten, so the step change in the number is attributable.
  if (shouldPersistSnapshot(range)) {
    await persistSnapshot({
      organizationId,
      metricKey: "gross_sales_mtd",
      periodStart: range.from,
      periodEnd: range.to,
      valueMinor: BigInt(gmv.valueMinor),
      formulaVersion: FORMULA_VERSION,
    });
  }

  return {
    currency: ladder.currency,
    periodStart: ladder.period.start,
    periodEnd: ladder.period.end,
    periodFiltered: true,
    comparison: ladder.comparison,
    formulaVersion: FORMULA_VERSION,
    // §110 trust layer, carried through from the ladder so the Overview cards
    // can show the same finality and completeness the Revenue page does.
    status: ladder.status,
    dataCompleteness: ladder.dataCompleteness,
    warnings: ladder.warnings,

    // §5. Genuinely gross now — line-item value before discounts — which is
    // what a card labelled "Gross sales" should show.
    grossSales: {
      metricKey: "gross_sales_mtd",
      valueMinor: gmv.valueMinor,
      value: gmv.value,
      priorValueMinor: gmv.prior.valueMinor,
      priorValue: gmv.prior.value,
      changePct: gmv.changePct,
      spec: "§5",
    },

    // Every order placed in the window, which is what Shopify's sales report
    // counts and therefore what a founder cross-checking this card against
    // Shopify will be comparing against. The recognised (§16) count is carried
    // alongside rather than dropped, because it is the one revenue is built on.
    orders: {
      metricKey: "order_count_mtd",
      value: orders.total,
      priorValue: orders.priorTotal,
      changePct: orders.changePctTotal,
      recognised: orders.recognised,
      cancelledExcluded: orders.cancelled,
      spec: "§16",
      basis: "all orders placed",
    },

    // §64 Ordered AOV over all orders placed, matching the order count above —
    // an AOV whose denominator disagreed with the order count shown next to it
    // would be indefensible. Delivered AOV stays null rather than being faked.
    averageOrderValue: {
      metricKey: "aov_mtd",
      value: aov.allPlaced,
      priorValue: aov.allPlacedPrior,
      changePct:
        aov.allPlaced == null || aov.allPlacedPrior == null || aov.allPlacedPrior === 0
          ? null
          : Math.round(((aov.allPlaced - aov.allPlacedPrior) / aov.allPlacedPrior) * 1000) / 10,
      recognisedBasis: aov.ordered,
      delivered: aov.delivered,
      spec: "§64",
      basis: "all orders placed",
    },

    // §12
    discounts: {
      metricKey: "discount_rate_mtd",
      valueMinor: discounts.valueMinor,
      value: discounts.value,
      ratePct: discounts.ratePct,
      priorRatePct: discounts.priorRatePct,
      spec: "§12",
    },

    // §66. Both versions the spec asks for, from real refund amounts rather
    // than inferred from a status string. The old partiallyRefundedOrderCount /
    // refundStatusUnknownCount fields are gone: they existed only to describe
    // what the status-string approach couldn't see, and it no longer applies.
    refunds: {
      metricKey: "refund_rate_mtd",
      refundedValueMinor: refunds.valueMinor,
      refundedValue: refunds.value,
      refundedExGstMinor: refunds.exGst.valueMinor,
      refundedExGst: refunds.exGst.value,
      ratePct: refunds.revenueRefundRatePct,
      orderRatePct: refunds.orderRefundRatePct,
      ordersWithRefund: refunds.ordersWithRefund,
      denominator: refunds.denominator,
      denominatorDeviation: refunds.denominatorDeviation,
      spec: "§66",
    },
  };
}
