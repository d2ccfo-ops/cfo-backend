import { Prisma } from "@prisma/client";
import { DEFAULT_TIMEZONE, resolveDateRange, type ResolvedRange, describeRange } from "../../lib/dateRange.js";
import { scopeWhere, type EntityScope } from "../../lib/entityScope.js";
import {
  MAX_SPAN_DAYS,
  MIN_SPAN_DAYS,
  bucketLabel,
  enumerateBuckets,
  resolveTrendWindow,
  type TrendWindow,
} from "../../lib/trendWindow.js";
import { prisma } from "../../lib/prisma.js";
import { paiseToRupees } from "./money.js";

// The revenue ladder from the CFOOS Backend Finance Engine spec, §5–§11 plus
// the ratios that hang off it (§64 AOV, §66 refund rates, §67 cancellation
// rate, §68 prepaid/COD mix, §69 repeat rate) and the revenue portion of the
// §104 profitability waterfall.
//
// §1 is the reason this module exists at all: there must never be one
// ambiguous field called "revenue". Five different numbers are computed here
// and each is named for exactly what it is:
//
//   GMV               (§5)  line-item value, before discounts, EX-GST
//   Gross Order Value (§6)  GMV + shipping charged to customer
//   Net Order Value   (§7)  GMV − discounts + shipping   [still an ORDER metric]
//   Net Revenue       (§11) less cancellations and refunds
//
// None of these is "cash". Cash Collected (§42), Cash Settled (§43) and Cash
// Received (§44) are separate truths and live in modules/calc/cash.ts.
//
// v3 — GMV AND DISCOUNTS ARE NOW TAX-EXCLUSIVE (§10).
//
// v1/v2 took Shopify's total_line_items_price as GMV directly. This store
// prices tax-inclusive (`taxes_included: true`, as most Indian D2C stores do),
// so that figure carried GST inside it and the "Gross sales" card read 3.05%
// above the identically-named number in Shopify's own reports — measured on
// July 2026: ours ₹22,00,194 against Shopify's ₹21,35,152, which is exactly the
// 3% IGST. §10 requires tax-exclusive, so v1/v2 were also violating the spec.
//
// Net Revenue is UNCHANGED by this: the GST that used to be stripped at a later
// rung is now stripped at the first one, so the ladder simply loses its GST
// step. Per §92 the v1/v2 snapshots stay put rather than being rewritten.
//
// THE ARITHMETIC RUNS IN POSTGRES, NOT IN NODE. This module used to load
// every order row in the window (three scans, ~114k rows per request on the
// live org) and reduce them in a JS loop. The loop is now a set of SQL
// aggregates over the identical per-row expressions — same figures, no row
// transfer. Measured before the change: /metrics/revenue-ladder was 2137ms
// alone and the whole dashboard convoyed to ~7s behind it; the per-row
// formulas below each carry the § of the JS they replaced, and the conversion
// was validated by diffing every output figure against the old code across
// all demo orgs and four date ranges — bit-for-bit identical.
//
// Two SQL functions carry the exactness argument:
//   div(a::numeric * b::numeric, c::numeric)::bigint
//     — div() truncates toward zero for every sign combination, exactly as
//       JS BigInt '/' does. The multiply is promoted to numeric FIRST because
//       bigint*bigint can overflow int8 (a fully-refunded ~₹3 crore order
//       would), while numeric is arbitrary-precision like BigInt.
//   COALESCE(SUM(...), 0)::bigint
//     — SUM over bigint returns numeric (exact for integers; addition is
//       associative so DB order can't change the total), and the ::bigint
//       cast is what keeps Prisma returning JS BigInt rather than Decimal —
//       money must never ride a decimal type. COALESCE matches the JS loop's
//       0n initialisers for an empty window.
export const FORMULA_VERSION = "v3";

// §8: the recognition basis is meant to be per-organisation configuration.
// There is no org-settings table yet, so this is a hard-coded default that is
// ALWAYS reported in the response rather than left implicit — a founder
// looking at a delivered-basis number when the engine computed an
// order-created-basis one is exactly the ambiguity §1 forbids.
//
// DELIVERED is the basis this spec generally assumes (§9), and it is not
// available: it needs order→shipment linkage, and in the live dataset only 65
// of ~24,800 orders carry a Shipment at all. Claiming a delivered basis off
// 0.3% coverage would be worse than being explicit about using ORDER_CREATED.
export type RecognitionBasis =
  | "ORDER_CREATED"
  | "PAID"
  | "SHIPPED"
  | "DELIVERED"
  | "INVOICED"
  | "ACCOUNTING_LEDGER";

export const RECOGNITION_BASIS: RecognitionBasis = "ORDER_CREATED";

// Per-row derived columns, shared by every aggregate in this module. Each is
// the SQL form of a rung the JS loop used to compute per order:
//
//   gmv_incl  §5 GMV, tax-inclusive. itemsAmount is Shopify's
//             total_line_items_price; a small number of rows predate
//             raw-payload storage and have no line-item total, so GMV is
//             reconstructed from the §7 identity instead — counted via
//             itemsAmount <= 0 and surfaced in `warnings`, never silently
//             defaulted to zero.
//   tex       the tax-exclusive sale value, derived from grossAmount (what
//             the customer actually paid, which is authoritative) rather than
//             from the components — this is what makes §11 here identical by
//             construction to modules/calc/revenue.ts whether the store
//             prices tax-inclusive or not.
//   gmv_ex    §10. Strips the GST actually EMBEDDED in the line prices using
//             the order's own implied rate. GST is levied on the DISCOUNTED
//             value, so the rate is implied from that base (gmv_incl −
//             discount) and applied to the component being converted. When
//             the embedded tax or the base is <= 0 the row is identity —
//             exclusive pricing gives zero embedded tax and no conversion.
//   refund_ex §11/§66. The tax-exclusive portion of a refund, apportioned
//             from the order's own effective tax ratio (refund line items are
//             not stored, which is why this metric can never be RECONCILED
//             without §14's component-level data). Zero refund short-circuits
//             to zero; a non-positive gross falls back to the full refund.
function orderCalcRows(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT r."grossAmount", r."taxAmount", r."shippingAmount", r."refundedAmount",
           r."itemsAmount", r."cancelledAt", r."paymentMode", r.channel, r."placedAt",
           r.gmv_incl, r.tex,
           CASE
             WHEN (r.gmv_incl - r."discountAmount") <= 0
               OR ((r.gmv_incl - r."discountAmount") - r.tex) <= 0 THEN r.gmv_incl
             ELSE div(r.gmv_incl::numeric * r.tex::numeric, (r.gmv_incl - r."discountAmount")::numeric)::bigint
           END AS gmv_ex,
           CASE
             WHEN r."refundedAmount" = 0 THEN 0::bigint
             WHEN r."grossAmount" <= 0 THEN r."refundedAmount"
             ELSE div(r."refundedAmount"::numeric * (r."grossAmount" - r."taxAmount")::numeric, r."grossAmount"::numeric)::bigint
           END AS refund_ex
    FROM (
      SELECT o."grossAmount", o."taxAmount", o."shippingAmount", o."discountAmount",
             o."refundedAmount", o."itemsAmount", o."cancelledAt", o."paymentMode",
             o.channel, o."placedAt",
             CASE WHEN o."itemsAmount" > 0 THEN o."itemsAmount"
                  ELSE o."grossAmount" + o."discountAmount" - o."shippingAmount" END AS gmv_incl,
             o."grossAmount" - o."shippingAmount" - o."taxAmount" AS tex
      FROM orders o
      WHERE ${where}
    ) r`;
}

// The where-clause every scan in this module shares. The entity fragment is
// derived from scopeWhere()'s OUTPUT — present key → filter, absent → nothing
// — so the single-entity no-op shortcut keeps living in lib/entityScope.ts
// rather than being re-derived here.
function orderWhere(organizationId: string, scope: EntityScope | null, from: Date, to: Date): Prisma.Sql {
  const w = scopeWhere(organizationId, scope);
  const entity = w.legalEntityId ? Prisma.sql` AND o."legalEntityId" = ${w.legalEntityId}` : Prisma.empty;
  return Prisma.sql`o."organizationId" = ${organizationId}${entity} AND o."placedAt" >= ${from} AND o."placedAt" <= ${to}`;
}

// One row of window totals — everything the old summarise() reduced a window's
// orders into, except the channel and repeat-customer breakdowns (their own
// queries below, current window only, because the response never reads them
// for the prior window).
interface TotalsRow {
  total_count: number;
  derived_gmv_count: number;
  gmv: bigint;
  gmv_incl_gst: bigint;
  discounts: bigint;
  shipping: bigint;
  cancelled_count: number;
  cancelled_nov: bigint;
  recognised_count: number;
  recognised_nov: bigint;
  recognised_gst: bigint;
  recognised_refunds: bigint;
  recognised_refunds_ex: bigint;
  orders_with_refund: number;
  cod_count: number;
  prepaid_count: number;
  unknown_mode_count: number;
  cod_nov: bigint;
  prepaid_nov: bigint;
}

// Cancelled orders are carried in the same scan rather than filtered out,
// split by FILTER clauses — the §104 waterfall has to show cancellations as an
// explicit step, so a founder sees the amount that never became revenue, not
// just its absence. Per-row net order value (§7) reduces to grossAmount −
// taxAmount exactly (tex + shipping), which is what the NOV sums use.
// Discounts are DERIVED (gmv_ex − tex) so the rung arithmetic closes exactly —
// the rounding lands on the discount line, where a paise matters least.
async function windowTotals(where: Prisma.Sql): Promise<TotalsRow> {
  const rows = await prisma.$queryRaw<TotalsRow[]>(Prisma.sql`
    SELECT count(*)::int AS total_count,
           count(*) FILTER (WHERE x."itemsAmount" <= 0)::int AS derived_gmv_count,
           COALESCE(SUM(x.gmv_ex), 0)::bigint AS gmv,
           COALESCE(SUM(x.gmv_incl), 0)::bigint AS gmv_incl_gst,
           COALESCE(SUM(x.gmv_ex - x.tex), 0)::bigint AS discounts,
           COALESCE(SUM(x."shippingAmount"), 0)::bigint AS shipping,
           count(*) FILTER (WHERE x."cancelledAt" IS NOT NULL)::int AS cancelled_count,
           COALESCE(SUM(x."grossAmount" - x."taxAmount") FILTER (WHERE x."cancelledAt" IS NOT NULL), 0)::bigint AS cancelled_nov,
           count(*) FILTER (WHERE x."cancelledAt" IS NULL)::int AS recognised_count,
           COALESCE(SUM(x."grossAmount" - x."taxAmount") FILTER (WHERE x."cancelledAt" IS NULL), 0)::bigint AS recognised_nov,
           COALESCE(SUM(x."taxAmount") FILTER (WHERE x."cancelledAt" IS NULL), 0)::bigint AS recognised_gst,
           COALESCE(SUM(x."refundedAmount") FILTER (WHERE x."cancelledAt" IS NULL), 0)::bigint AS recognised_refunds,
           COALESCE(SUM(x.refund_ex) FILTER (WHERE x."cancelledAt" IS NULL), 0)::bigint AS recognised_refunds_ex,
           count(*) FILTER (WHERE x."cancelledAt" IS NULL AND x."refundedAmount" > 0)::int AS orders_with_refund,
           count(*) FILTER (WHERE x."cancelledAt" IS NULL AND x."paymentMode" = 'COD')::int AS cod_count,
           count(*) FILTER (WHERE x."cancelledAt" IS NULL AND x."paymentMode" = 'PREPAID')::int AS prepaid_count,
           count(*) FILTER (WHERE x."cancelledAt" IS NULL AND (x."paymentMode" IS NULL OR x."paymentMode" NOT IN ('COD', 'PREPAID')))::int AS unknown_mode_count,
           COALESCE(SUM(x."grossAmount" - x."taxAmount") FILTER (WHERE x."cancelledAt" IS NULL AND x."paymentMode" = 'COD'), 0)::bigint AS cod_nov,
           COALESCE(SUM(x."grossAmount" - x."taxAmount") FILTER (WHERE x."cancelledAt" IS NULL AND x."paymentMode" = 'PREPAID'), 0)::bigint AS prepaid_nov
    FROM (${orderCalcRows(where)}) x`);
  return rows[0]!;
}

// The derived rungs the response reads, computed from the totals row with the
// same end-of-loop arithmetic summarise() used (§6 gross order value, §7 net
// order value, §11 net revenue).
function windowStats(t: TotalsRow) {
  const grossOrderValue = t.gmv + t.shipping; // §6
  const netOrderValue = t.gmv - t.discounts + t.shipping; // §7 (all orders)
  // §10 — already tax-exclusive from the first rung as of v3; kept as a named
  // value because the response and the waterfall both refer to it.
  const recognisedExGst = t.recognised_nov;
  const netRevenue = recognisedExGst - t.recognised_refunds_ex; // §11
  return {
    gmv: t.gmv,
    // Kept alongside so the GST-inclusive figure is still available for the
    // cash-side reconciliations, where what the customer actually paid is the
    // relevant number.
    gmvInclGst: t.gmv_incl_gst,
    discounts: t.discounts,
    shipping: t.shipping,
    grossOrderValue,
    netOrderValue,
    cancelledNetOrderValue: t.cancelled_nov,
    cancelledCount: t.cancelled_count,
    recognisedNetOrderValue: t.recognised_nov,
    recognisedGst: t.recognised_gst,
    recognisedExGst,
    recognisedRefunds: t.recognised_refunds,
    recognisedRefundsExGst: t.recognised_refunds_ex,
    netRevenue,
    recognisedCount: t.recognised_count,
    ordersWithRefund: t.orders_with_refund,
    totalCount: t.total_count,
    derivedGmvCount: t.derived_gmv_count,
    codCount: t.cod_count,
    prepaidCount: t.prepaid_count,
    unknownModeCount: t.unknown_mode_count,
    codNetOrderValue: t.cod_nov,
    prepaidNetOrderValue: t.prepaid_nov,
  };
}

function pct(numerator: bigint | number, denominator: bigint | number): number | null {
  const n = Number(numerator);
  const d = Number(denominator);
  if (d === 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

function changePct(current: bigint, prior: bigint): number | null {
  if (prior === 0n) return null;
  return Math.round((Number(current - prior) / Number(prior)) * 1000) / 10;
}

// §89 data completeness, scored on the inputs this ladder actually needs.
// Weights are the spec's example weights renormalised to the revenue-only
// inputs — the full contribution-margin weighting can't be scored here because
// COGS, shipping cost and ads aren't inputs to revenue.
function completeness(s: {
  totalCount: number;
  derivedGmvCount: number;
  recognisedCount: number;
  unknownModeCount: number;
}) {
  if (s.totalCount === 0) return 0;
  const gmvKnown = (s.totalCount - s.derivedGmvCount) / s.totalCount;
  const paymentModeKnown = s.recognisedCount === 0 ? 1 : (s.recognisedCount - s.unknownModeCount) / s.recognisedCount;
  // Tax and discounts are non-null columns with defaults, so their presence is
  // structural rather than measured; they're not scored to avoid inflating the
  // number with something that can never fail.
  return Math.round((gmvKnown * 0.7 + paymentModeKnown * 0.3) * 100);
}

export async function getRevenueLadder(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({}),
  // §12.2 (P5.6). Null means the whole organisation, which is what every
  // caller passed before this existed and remains the default.
  scope: EntityScope | null = null
) {
  const currentWhere = orderWhere(organizationId, scope, range.from, range.to);

  const [currentTotals, priorTotals, channelRows, repeatRows] = await Promise.all([
    windowTotals(currentWhere),
    windowTotals(orderWhere(organizationId, scope, range.priorFrom, range.priorTo)),
    // Channel breakdown, recognised orders only (the JS loop only reached the
    // channel map after the cancelled `continue`). Current window only — the
    // prior window's breakdown was computed and discarded before.
    prisma.$queryRaw<{ channel: string; orders: number; gmv: bigint; net_revenue: bigint }[]>(Prisma.sql`
      SELECT x.channel, count(*)::int AS orders,
             COALESCE(SUM(x.gmv_ex), 0)::bigint AS gmv,
             COALESCE(SUM((x."grossAmount" - x."taxAmount") - x.refund_ex), 0)::bigint AS net_revenue
      FROM (${orderCalcRows(currentWhere)}) x
      WHERE x."cancelledAt" IS NULL
      GROUP BY x.channel`),
    // §69 repeat rate — a per-customer dedup and threshold count, done with a
    // GROUP BY subquery. The `<> ''` clause is load-bearing: the JS check was
    // `if (o.customerRef)`, which skips empty strings as well as nulls.
    prisma.$queryRaw<{ customers: number; repeat: number }[]>(Prisma.sql`
      SELECT count(*)::int AS customers,
             count(*) FILTER (WHERE t.n >= 2)::int AS repeat
      FROM (
        SELECT o."customerRef", count(*) AS n
        FROM orders o
        WHERE ${currentWhere} AND o."cancelledAt" IS NULL
          AND o."customerRef" IS NOT NULL AND o."customerRef" <> ''
        GROUP BY o."customerRef"
      ) t`),
  ]);

  const current = windowStats(currentTotals);
  const prior = windowStats(priorTotals);
  const repeat = repeatRows[0] ?? { customers: 0, repeat: 0 };

  const warnings: string[] = [];
  warnings.push(
    `Revenue recognised on ${RECOGNITION_BASIS} basis (§8). DELIVERED basis is unavailable — order-to-shipment linkage is missing for almost all orders.`
  );
  if (current.derivedGmvCount > 0) {
    warnings.push(
      `${current.derivedGmvCount} of ${current.totalCount} orders have no stored line-item total; GMV for those is derived from the §7 identity.`
    );
  }
  if (current.recognisedRefunds > 0n) {
    warnings.push(
      "Refund tax split is apportioned from each order's effective tax ratio, not from refund line items (§14) — net revenue is an estimate to that extent."
    );
  }
  if (current.unknownModeCount > 0) {
    warnings.push(`${current.unknownModeCount} recognised orders have no payment gateway recorded; excluded from the prepaid/COD mix (§68).`);
  }

  const money = (v: bigint) => ({ valueMinor: v.toString(), value: paiseToRupees(v) });

  return {
    metric: "revenue_ladder",
    currency: "INR",
    recognitionBasis: RECOGNITION_BASIS,
    period: { start: range.from.toISOString(), end: range.to.toISOString() },
    // Both windows, stated as days on the org calendar — a comparison that
    // will not disclose its own boundaries is asking to be trusted blind.
    window: describeRange(range),
    comparison: range.comparison,
    // §90 finality. Never better than ESTIMATED today: nothing here is
    // reconciled against a settlement or a bank credit, and the refund tax
    // split is apportioned.
    status: "ESTIMATED",
    dataCompleteness: completeness(current),
    formulaVersion: FORMULA_VERSION,
    lastCalculatedAt: new Date().toISOString(),
    warnings,

    // §12. Exposed as a first-class figure, not just a waterfall step, because
    // the discount rate is a metric founders steer on. Funder attribution
    // (BRAND / MARKETPLACE / GATEWAY) is not available — Shopify reports a
    // single total — so every discount here is implicitly brand-funded, which
    // is the conservative assumption.
    discounts: {
      ...money(current.discounts),
      prior: money(prior.discounts),
      ratePct: pct(current.discounts, current.grossOrderValue),
      priorRatePct: pct(prior.discounts, prior.grossOrderValue),
      funderAttribution: "unavailable_assumed_brand_funded",
      spec: "§12",
    },

    // The ladder itself — each rung named for the spec section that defines it.
    ladder: {
      gmv: { ...money(current.gmv), prior: money(prior.gmv), changePct: changePct(current.gmv, prior.gmv), spec: "§5" },
      grossOrderValue: { ...money(current.grossOrderValue), prior: money(prior.grossOrderValue), changePct: changePct(current.grossOrderValue, prior.grossOrderValue), spec: "§6" },
      netOrderValue: { ...money(current.netOrderValue), prior: money(prior.netOrderValue), changePct: changePct(current.netOrderValue, prior.netOrderValue), spec: "§7" },
      outputGst: { ...money(current.recognisedGst), prior: money(prior.recognisedGst), changePct: changePct(current.recognisedGst, prior.recognisedGst), spec: "§10" },
      netRevenue: { ...money(current.netRevenue), prior: money(prior.netRevenue), changePct: changePct(current.netRevenue, prior.netRevenue), spec: "§11" },
    },

    // §104 waterfall, revenue portion. Steps subtract to the final figure
    // exactly — each `amount` is the deduction applied at that step.
    // The same three figures Shopify's "Sales over time" report shows, named as
    // Shopify names them, so a founder can tie this screen to that one without
    // having to know which of our rungs corresponds to which of its columns.
    //
    // These are NOT new arithmetic — they are relabelings of rungs already
    // computed above, which is the point: verified against the live store for
    // 7 and 8 Aug 2026, gross sales agrees to 1 paisa and net sales and total
    // sales agree EXACTLY. §1 still holds because each carries the rung it is.
    //
    //   Shopify "Gross sales" = §5 GMV, ex GST
    //   Shopify "Net sales"   = §11 Net revenue (cancellations and returns out)
    //   Shopify "Total sales" = Net revenue + shipping charged + output GST
    shopifyEquivalent: {
      note: "Matches Shopify's Sales over time report. Cut on the organisation's timezone, so the day boundaries line up too.",
      grossSales: { ...money(current.gmv), maps_to: "§5 GMV (ex GST)" },
      netSales: { ...money(current.netRevenue), maps_to: "§11 Net revenue" },
      totalSales: {
        ...money(current.netRevenue + current.shipping + current.recognisedGst),
        maps_to: "§11 Net revenue + shipping + output GST",
      },
      orders: current.totalCount,
    },

    // No GST rung as of v3 — it is stripped at the first one, so showing it
    // again here would deduct the same tax twice.
    waterfall: [
      { label: "Gross order value (ex GST)", ...money(current.grossOrderValue), kind: "start", spec: "§6" },
      { label: "Discounts", ...money(-current.discounts), kind: "deduction", spec: "§12" },
      { label: "Cancellations", ...money(-current.cancelledNetOrderValue), kind: "deduction", spec: "§16" },
      { label: "Refunds (ex GST)", ...money(-current.recognisedRefundsExGst), kind: "deduction", spec: "§11" },
      { label: "Net revenue", ...money(current.netRevenue), kind: "total", spec: "§11" },
    ],

    orders: {
      total: current.totalCount,
      priorTotal: prior.totalCount,
      changePctTotal:
        prior.totalCount === 0
          ? null
          : Math.round(((current.totalCount - prior.totalCount) / prior.totalCount) * 1000) / 10,
      recognised: current.recognisedCount,
      cancelled: current.cancelledCount,
      priorRecognised: prior.recognisedCount,
      changePct:
        prior.recognisedCount === 0
          ? null
          : Math.round(((current.recognisedCount - prior.recognisedCount) / prior.recognisedCount) * 1000) / 10,
    },

    // §64. Ordered AOV, explicitly — Delivered AOV needs the delivery linkage
    // we don't have, so it is reported as null rather than quietly substituting
    // the ordered figure under a delivered label.
    //
    // Two denominators, because the choice moves the number by ~5% and leaving
    // it implicit is the §1 failure:
    //   `ordered`      §16 basis — cancelled orders recognise nothing, so they
    //                  are out of the denominator too.
    //   `allPlaced`    every order placed in the window, which is what Shopify's
    //                  sales report counts. Smaller AOV, because ~6% of this
    //                  store's orders cancel.
    aov: {
      ordered: current.recognisedCount === 0 ? null : Math.round(paiseToRupees(current.recognisedNetOrderValue) / current.recognisedCount),
      orderedPrior: prior.recognisedCount === 0 ? null : Math.round(paiseToRupees(prior.recognisedNetOrderValue) / prior.recognisedCount),
      allPlaced: current.totalCount === 0 ? null : Math.round(paiseToRupees(current.netOrderValue) / current.totalCount),
      allPlacedPrior: prior.totalCount === 0 ? null : Math.round(paiseToRupees(prior.netOrderValue) / prior.totalCount),
      delivered: null,
      spec: "§64",
    },

    // §66. Both the order-count and value versions the spec asks for. The
    // denominator is recognised (non-cancelled) orders rather than DELIVERED
    // orders, for the same missing-linkage reason — stated here so the
    // deviation travels with the number.
    refunds: {
      ...money(current.recognisedRefunds),
      exGst: money(current.recognisedRefundsExGst),
      orderRefundRatePct: pct(current.ordersWithRefund, current.recognisedCount),
      revenueRefundRatePct: pct(current.recognisedRefundsExGst, current.recognisedExGst),
      // The same rates for the comparison period. Without these the UI has
      // only a level, and a level cannot say whether things are getting better
      // — colouring any non-zero refund rate red makes 0.5% look exactly as
      // alarming as 40%. A rate is judged by its MOVEMENT, in percentage
      // points, which is what these make computable.
      priorOrderRefundRatePct: pct(prior.ordersWithRefund, prior.recognisedCount),
      priorRevenueRefundRatePct: pct(prior.recognisedRefundsExGst, prior.recognisedExGst),
      ordersWithRefund: current.ordersWithRefund,
      denominator: "recognised_orders",
      denominatorDeviation: "Spec §66 specifies delivered orders; delivery data is unavailable.",
      spec: "§66",
    },

    // §67
    cancellations: {
      ...money(current.cancelledNetOrderValue),
      count: current.cancelledCount,
      ratePct: pct(current.cancelledCount, current.totalCount),
      valueRatePct: pct(current.cancelledNetOrderValue, current.netOrderValue),
      priorRatePct: pct(prior.cancelledCount, prior.totalCount),
      priorValueRatePct: pct(prior.cancelledNetOrderValue, prior.netOrderValue),
      spec: "§67",
    },

    // §68
    paymentMix: {
      codCount: current.codCount,
      prepaidCount: current.prepaidCount,
      unknownCount: current.unknownModeCount,
      codPct: pct(current.codCount, current.codCount + current.prepaidCount),
      prepaidPct: pct(current.prepaidCount, current.codCount + current.prepaidCount),
      codValue: money(current.codNetOrderValue),
      prepaidValue: money(current.prepaidNetOrderValue),
      codValuePct: pct(current.codNetOrderValue, current.codNetOrderValue + current.prepaidNetOrderValue),
      // Returned rather than left for the UI to derive as `100 − codValuePct`.
      // That subtraction turns a null (no orders at all, so no denominator)
      // into a confident "100% prepaid", which is a fabricated number — and
      // §106 puts the arithmetic here regardless.
      prepaidValuePct: pct(current.prepaidNetOrderValue, current.codNetOrderValue + current.prepaidNetOrderValue),
      // §16: a cancelled order never ships, so it carries neither RTO risk nor
      // remittance lag — the two things this mix exists to describe. Stated
      // because §1 forbids leaving a denominator implicit.
      denominator: "recognised_orders",
      spec: "§68",
    },

    // §69, scoped to the selected period rather than all time — "repeat" here
    // means a customer who ordered more than once WITHIN this window.
    repeatCustomers: {
      customers: repeat.customers,
      repeat: repeat.repeat,
      ratePct: pct(repeat.repeat, repeat.customers),
      scope: "within_selected_period",
      spec: "§69",
    },

    byChannel: channelRows
      .map((c) => ({
        channel: c.channel,
        orders: c.orders,
        gmv: money(c.gmv),
        netRevenue: money(c.net_revenue),
        sharePct: pct(c.net_revenue, current.netRevenue),
      }))
      .sort((a, b) => Number(BigInt(b.netRevenue.valueMinor) - BigInt(a.netRevenue.valueMinor))),
  };
}

// Bucketed net-revenue trend for the chart. Uses the same per-order ladder
// expressions as everything above rather than a second, subtly different SQL
// sum — a trend line that disagrees with the card above it is worse than no
// trend line.
//
// The bucket size comes from the window (lib/trendWindow.ts) rather than being
// fixed at a month, because the chart is zoomable: pinching in re-buckets the
// same orders by week and then by day. Re-bucketing on the server, through this
// one function, is what stops a zoomed-in day from summing differently to the
// month that contains it.
//
// BUCKET BOUNDARIES ARE COMPUTED IN JS AND HANDED TO SQL AS INSTANTS — the
// calendar logic (org timezone, Monday weeks, month keys) stays in
// lib/trendWindow.ts exactly as before, and SQL only answers "which range does
// this timestamp fall in" via width_bucket over the precomputed UTC starts.
// Re-deriving the timezone arithmetic in SQL (AT TIME ZONE) would mean two
// implementations of the merchant's calendar that could disagree wherever
// Node's ICU and Postgres's tzdata differ; comparing millisecond epochs
// cannot. enumerateBuckets tiles the window contiguously, so the range test
// and the old per-row bucketKeyFor answer identically for every in-window row.
export async function getRevenueTrend(organizationId: string, window?: TrendWindow, scope: EntityScope | null = null) {
  const w = window ?? resolveTrendWindow({}, new Date(), DEFAULT_TIMEZONE);
  const { from, to, granularity } = w;

  const layout = enumerateBuckets(w);
  // Bucket start instants as epoch milliseconds. Sent as text and cast —
  // element-wise — to bigint[]; extract(epoch) * 1000 is exact for
  // timestamp(3) columns, so the comparison is integer-exact on both sides.
  const bucketStarts = layout.map((b) => String(b.start.getTime()));
  const where = orderWhere(organizationId, scope, from, to);

  const [orderBuckets, cashBuckets, bankConnections, earliestCredit, earliestOrder] = await Promise.all([
    prisma.$queryRaw<{ idx: number; recognised_count: number; gross_order_value: bigint; net_revenue: bigint }[]>(Prisma.sql`
      SELECT width_bucket((extract(epoch FROM x."placedAt") * 1000)::bigint, ${bucketStarts}::text[]::bigint[])::int AS idx,
             count(*) FILTER (WHERE x."cancelledAt" IS NULL)::int AS recognised_count,
             COALESCE(SUM(x.gmv_ex + x."shippingAmount"), 0)::bigint AS gross_order_value,
             COALESCE(SUM((x."grossAmount" - x."taxAmount") - x.refund_ex) FILTER (WHERE x."cancelledAt" IS NULL), 0)::bigint AS net_revenue
      FROM (${orderCalcRows(where)}) x
      GROUP BY 1`),
    prisma.$queryRaw<{ idx: number; cash: bigint }[]>(Prisma.sql`
      SELECT width_bucket((extract(epoch FROM b."valueDate") * 1000)::bigint, ${bucketStarts}::text[]::bigint[])::int AS idx,
             COALESCE(SUM(b.amount), 0)::bigint AS cash
      FROM bank_transactions b
      WHERE b."organizationId" = ${organizationId} AND b.direction = 'CREDIT'
        AND b."valueDate" >= ${from} AND b."valueDate" <= ${to}
      GROUP BY 1`),
    // How far back we can SEE the bank, which is a different question from how
    // much money arrived. Without this the chart plots ₹0 for every month
    // before a bank was connected, and a flat zero line next to a rising
    // revenue line reads as "none of this was ever collected" — a far worse
    // claim than "we have no visibility here" (§110).
    prisma.connection.findMany({
      where: { organizationId, provider: { in: ["BANK", "BANK_AA"] }, status: "ACTIVE" },
      select: { openingBalanceDate: true },
    }),
    prisma.bankTransaction.findFirst({
      where: { organizationId },
      orderBy: { valueDate: "asc" },
      select: { valueDate: true },
    }),
    // The same argument as cash visibility, applied to revenue. Zooming out now
    // reaches windows that begin before this organisation had any orders at
    // all, and a run of ₹0 months before the first order is a claim that the
    // business sold nothing — not that we were not yet looking.
    prisma.order.findFirst({
      where: { organizationId },
      orderBy: { placedAt: "asc" },
      select: { placedAt: true },
    }),
  ]);

  // Visibility begins at the earliest thing we actually hold: an opening
  // balance anchor, or the first transaction we ever received.
  const anchors: Date[] = [];
  for (const c of bankConnections) if (c.openingBalanceDate) anchors.push(c.openingBalanceDate);
  if (earliestCredit?.valueDate) anchors.push(earliestCredit.valueDate);
  const cashVisibleFrom =
    bankConnections.length === 0 || anchors.length === 0
      ? null
      : new Date(Math.min(...anchors.map((d) => d.getTime())));
  const ordersVisibleFrom = earliestOrder?.placedAt ?? null;

  // width_bucket is 1-based: idx i means the bucket starting at
  // bucketStarts[i-1]. Every in-window instant lands in 1..layout.length by
  // construction (the first bucket opens at or before `from`).
  const ordersByIdx = new Map(orderBuckets.map((r) => [r.idx, r]));
  const cashByIdx = new Map(cashBuckets.map((r) => [r.idx, r.cash]));

  // Only add the year to labels when the window actually spans one, so a
  // six-month chart keeps the bare "Mar Apr May" it has always had.
  const crossesYears = layout.length > 0 && layout[0]!.key.slice(0, 4) !== layout[layout.length - 1]!.key.slice(0, 4);

  const series = layout.map((b, i) => {
    // A bucket with no rows gets the zeros the old summarise([]) produced.
    const ob = ordersByIdx.get(i + 1);
    const netRevenue = ob?.net_revenue ?? 0n;
    const grossOrderValue = ob?.gross_order_value ?? 0n;
    const recognisedCount = ob?.recognised_count ?? 0;
    const cash = cashByIdx.get(i + 1) ?? 0n;

    // null, not 0. Recharts leaves a gap for a null point (connectNulls
    // defaults to false), so a bucket we could not see renders as absent rather
    // than as one in which nothing happened.
    const cashVisible = cashVisibleFrom !== null && b.end > cashVisibleFrom;
    const ordersVisible = ordersVisibleFrom !== null && b.end >= ordersVisibleFrom;

    return {
      // `month` kept under its original name for the callers that read it; it
      // is the bucket key, which is a month only at monthly granularity.
      month: b.key,
      key: b.key,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      label: bucketLabel(b.key, granularity, crossesYears),
      netRevenue: ordersVisible ? paiseToRupees(netRevenue) : null,
      grossOrderValue: ordersVisible ? paiseToRupees(grossOrderValue) : null,
      cashReceived: cashVisible ? paiseToRupees(cash) : null,
      cashVisible,
      ordersVisible,
      orders: recognisedCount,
    };
  });

  const total = series.length;
  const covered = series.filter((m) => m.cashVisible).length;
  const unit = granularity === "day" ? "days" : granularity === "week" ? "weeks" : "months";

  return {
    series,
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      granularityWasAuto: w.granularityWasAuto,
      isDefault: w.isDefault,
      buckets: total,
      // What the chart is allowed to zoom to. Sent rather than hard-coded in
      // the client so the two can never disagree about what a valid window is.
      minSpanDays: MIN_SPAN_DAYS,
      maxSpanDays: MAX_SPAN_DAYS,
      // Nothing exists before this, so zooming out past it only adds blank
      // buckets — the control uses it to stop.
      dataFrom: ordersVisibleFrom?.toISOString() ?? null,
    },
    cashCoverage: {
      hasBankConnection: bankConnections.length > 0,
      visibleFrom: cashVisibleFrom?.toISOString() ?? null,
      coveredMonths: covered,
      totalMonths: total,
      note:
        bankConnections.length === 0
          ? "No bank account is connected, so cash received cannot be shown at all — the revenue line here has no counterpart to be compared against."
          : covered < total
            ? `Bank data only goes back to ${cashVisibleFrom?.toISOString().slice(0, 10)}, so ${total - covered} of the ${total} ${unit} have no cash figure rather than a zero.`
            : "Bank data covers the full window.",
    },
  };
}
