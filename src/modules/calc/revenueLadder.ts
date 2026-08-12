import { DEFAULT_TIMEZONE, resolveDateRange, type ResolvedRange, describeRange } from "../../lib/dateRange.js";
import {
  MAX_SPAN_DAYS,
  MIN_SPAN_DAYS,
  bucketKeyFor,
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

interface OrderRow {
  grossAmount: bigint;
  itemsAmount: bigint;
  discountAmount: bigint;
  shippingAmount: bigint;
  taxAmount: bigint;
  refundedAmount: bigint;
  cancelledAt: Date | null;
  paymentMode: string | null;
  customerRef: string | null;
  channel: string;
}

// §5 GMV. itemsAmount is Shopify's total_line_items_price. A small number of
// rows predate raw-payload storage and have no line-item total to backfill
// from, so GMV is reconstructed from the §7 identity instead. Counted and
// surfaced in `warnings` rather than silently defaulted to zero, which would
// understate GMV and make the whole ladder fail to reconcile.
function gmvOf(o: OrderRow): { gmv: bigint; derived: boolean } {
  if (o.itemsAmount > 0n) return { gmv: o.itemsAmount, derived: false };
  return { gmv: o.grossAmount + o.discountAmount - o.shippingAmount, derived: true };
}

// §10. Strips GST out of a tax-inclusive figure using the order's own implied
// rate, so "gross sales" means what it means in Shopify's reports and in the
// spec: the value of goods sold, without the tax collected on the state's
// behalf. GST is levied on the DISCOUNTED value, so the rate is implied from
// that base and then applied to whichever component is being converted —
// dividing the gross figure by the discounted ratio directly would strip too
// much.
//
// The identity that matters: gmvExGst − discountsExGst == (items − discounts) −
// tax exactly, so the ladder still reconciles to the same Net Revenue.
//
// Assumes GST sits on goods rather than on shipping. Shipping is 0.13% of value
// in this dataset (₹3.4 L against ₹23 crore) and is usually zero-rated or free,
// so any shipping GST folded in here is immaterial; the exact split would need
// tax_lines on the shipping line, which isn't stored.
// Strips whatever GST is actually EMBEDDED in the line prices, which is not
// always the whole tax figure.
//
// A store can price either way, and this one has both: 24,740 orders with
// `taxes_included: true` (GST sits inside the price) and 41 with it false (GST
// is added on top). Assuming inclusive pricing for all of them subtracted tax
// that was never in the price on 17 live orders, which is where a ₹1,055
// disagreement with modules/calc/revenue.ts came from.
//
// So the embedded tax is measured rather than assumed: `taxExclusiveSale` is
// derived from grossAmount — the amount the customer actually paid, which is
// authoritative — and whatever the discounted line value exceeds it by is the
// GST that was inside the prices. Inclusive pricing gives the full tax figure,
// exclusive pricing gives zero, and no flag has to be stored or trusted.
function exGstConverter(
  gmvInclusive: bigint,
  discount: bigint,
  taxExclusiveSale: bigint
): (amount: bigint) => bigint {
  const base = gmvInclusive - discount;
  const embeddedTax = base - taxExclusiveSale;
  if (embeddedTax <= 0n || base <= 0n) return (a) => a;
  const num = base - embeddedTax;
  return (amount) => (amount === 0n ? 0n : (amount * num) / base);
}

// The tax-exclusive portion of a refund. §11 reduces revenue by
// "Revenue-Reducing Refunds", and revenue is tax-exclusive (§10) — so refunding
// ₹100 on a GST-inclusive order does not reduce revenue by ₹100, because part
// of that ₹100 was output GST that also reverses.
//
// Shopify's refund_line_items carries an exact split, but it is not stored
// (only the refund total is), so this apportions using the order's own
// effective tax ratio. That is an ESTIMATE and is why this metric can never be
// reported as RECONCILED without the component-level refund data §14 asks for.
function refundExGst(o: OrderRow): bigint {
  if (o.refundedAmount === 0n) return 0n;
  const inclusive = o.grossAmount;
  if (inclusive <= 0n) return o.refundedAmount;
  // bigint arithmetic throughout — no float ever touches a money value.
  const exGstPortion = inclusive - o.taxAmount;
  return (o.refundedAmount * exGstPortion) / inclusive;
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

function summarise(orders: OrderRow[]) {
  let gmv = 0n;
  let gmvInclGst = 0n;
  let discounts = 0n;
  let shipping = 0n;
  let derivedGmvCount = 0;

  // Cancelled orders are carried separately rather than filtered out, because
  // the §104 waterfall has to show cancellations as an explicit step — a
  // founder needs to see the amount that never became revenue, not just its
  // absence.
  let cancelledNetOrderValue = 0n;
  let cancelledCount = 0;

  let recognisedNetOrderValue = 0n;
  let recognisedGst = 0n;
  let recognisedRefunds = 0n;
  let recognisedRefundsExGst = 0n;
  let recognisedCount = 0;
  let ordersWithRefund = 0;

  let codCount = 0;
  let prepaidCount = 0;
  let unknownModeCount = 0;
  let codNetOrderValue = 0n;
  let prepaidNetOrderValue = 0n;

  const byChannel = new Map<string, { orders: number; gmv: bigint; netRevenue: bigint }>();
  const ordersByCustomer = new Map<string, number>();

  for (const o of orders) {
    const { gmv: orderGmvInclusive, derived } = gmvOf(o);
    if (derived) derivedGmvCount += 1;

    // §10 — every order-value component is converted to tax-exclusive here, at
    // the top of the ladder, rather than GST being taken out several rungs down.
    //
    // The tax-exclusive sale value is taken directly, not as the difference of
    // two separately-rounded conversions: bigint division truncates, and two
    // truncations per order across 24,810 orders drifted ₹1,055 away from
    // modules/calc/revenue.ts, which is a §1 disagreement however small.
    // Discounts are then DERIVED from it so the rung arithmetic closes exactly
    // — the rounding lands on the discount line, where a paise matters least,
    // instead of on gross sales or on net revenue.
    // Derived from grossAmount (what the customer paid) rather than from the
    // components, so it holds whether the store prices tax-inclusive or not,
    // and so §11 here is identical by construction to modules/calc/revenue.ts.
    const taxExclusiveSale = o.grossAmount - o.shippingAmount - o.taxAmount;
    const toExGst = exGstConverter(orderGmvInclusive, o.discountAmount, taxExclusiveSale);
    const orderGmv = toExGst(orderGmvInclusive);
    const orderDiscount = orderGmv - taxExclusiveSale;

    // §7 Net Order Value. Computed from components rather than trusting
    // grossAmount, so the ladder stays internally consistent even for the rows
    // where the identity doesn't hold.
    const netOrderValue = taxExclusiveSale + o.shippingAmount;

    gmv += orderGmv;
    gmvInclGst += orderGmvInclusive;
    discounts += orderDiscount;
    shipping += o.shippingAmount;

    if (o.cancelledAt !== null) {
      // §16: cancelled before shipment recognises no revenue and no COGS.
      cancelledNetOrderValue += netOrderValue;
      cancelledCount += 1;
      continue;
    }

    recognisedCount += 1;
    recognisedNetOrderValue += netOrderValue;
    recognisedGst += o.taxAmount;

    const rExGst = refundExGst(o);
    recognisedRefunds += o.refundedAmount;
    recognisedRefundsExGst += rExGst;
    if (o.refundedAmount > 0n) ordersWithRefund += 1;

    // §68 prepaid/COD mix, by count and by value.
    if (o.paymentMode === "COD") {
      codCount += 1;
      codNetOrderValue += netOrderValue;
    } else if (o.paymentMode === "PREPAID") {
      prepaidCount += 1;
      prepaidNetOrderValue += netOrderValue;
    } else {
      unknownModeCount += 1;
    }

    // netOrderValue is already tax-exclusive as of v3, so GST is no longer
    // subtracted a second time here.
    const channelNetRevenue = netOrderValue - rExGst;
    const existing = byChannel.get(o.channel) ?? { orders: 0, gmv: 0n, netRevenue: 0n };
    byChannel.set(o.channel, {
      orders: existing.orders + 1,
      gmv: existing.gmv + orderGmv,
      netRevenue: existing.netRevenue + channelNetRevenue,
    });

    // §69 counts SUCCESSFUL orders only, which is why this sits after the
    // cancelled-order `continue` above.
    if (o.customerRef) {
      ordersByCustomer.set(o.customerRef, (ordersByCustomer.get(o.customerRef) ?? 0) + 1);
    }
  }

  const grossOrderValue = gmv + shipping; // §6
  const netOrderValue = gmv - discounts + shipping; // §7 (all orders)
  // §10 — already tax-exclusive from the first rung as of v3; kept as a named
  // value because the response and the waterfall both refer to it.
  const recognisedExGst = recognisedNetOrderValue;
  const netRevenue = recognisedExGst - recognisedRefundsExGst; // §11

  const customersWithOrders = ordersByCustomer.size;
  const repeatCustomers = [...ordersByCustomer.values()].filter((n) => n >= 2).length;

  return {
    gmv,
    // Kept alongside so the GST-inclusive figure is still available for the
    // cash-side reconciliations, where what the customer actually paid is the
    // relevant number.
    gmvInclGst,
    discounts,
    shipping,
    grossOrderValue,
    netOrderValue,
    cancelledNetOrderValue,
    cancelledCount,
    recognisedNetOrderValue,
    recognisedGst,
    recognisedExGst,
    recognisedRefunds,
    recognisedRefundsExGst,
    netRevenue,
    recognisedCount,
    ordersWithRefund,
    totalCount: orders.length,
    derivedGmvCount,
    codCount,
    prepaidCount,
    unknownModeCount,
    codNetOrderValue,
    prepaidNetOrderValue,
    byChannel,
    customersWithOrders,
    repeatCustomers,
  };
}

const ORDER_SELECT = {
  grossAmount: true,
  itemsAmount: true,
  discountAmount: true,
  shippingAmount: true,
  taxAmount: true,
  refundedAmount: true,
  cancelledAt: true,
  paymentMode: true,
  customerRef: true,
  channel: true,
} as const;

// §89 data completeness, scored on the inputs this ladder actually needs.
// Weights are the spec's example weights renormalised to the revenue-only
// inputs — the full contribution-margin weighting can't be scored here because
// COGS, shipping cost and ads aren't inputs to revenue.
function completeness(s: ReturnType<typeof summarise>) {
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
  range: ResolvedRange = resolveDateRange({})
) {
  const [currentOrders, priorOrders] = await Promise.all([
    prisma.order.findMany({
      where: { organizationId, placedAt: { gte: range.from, lte: range.to } },
      select: ORDER_SELECT,
    }),
    prisma.order.findMany({
      where: { organizationId, placedAt: { gte: range.priorFrom, lte: range.priorTo } },
      select: ORDER_SELECT,
    }),
  ]);

  const current = summarise(currentOrders);
  const prior = summarise(priorOrders);

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
      customers: current.customersWithOrders,
      repeat: current.repeatCustomers,
      ratePct: pct(current.repeatCustomers, current.customersWithOrders),
      scope: "within_selected_period",
      spec: "§69",
    },

    byChannel: [...current.byChannel]
      .map(([channel, v]) => ({
        channel,
        orders: v.orders,
        gmv: money(v.gmv),
        netRevenue: money(v.netRevenue),
        sharePct: pct(v.netRevenue, current.netRevenue),
      }))
      .sort((a, b) => Number(BigInt(b.netRevenue.valueMinor) - BigInt(a.netRevenue.valueMinor))),
  };
}

// Bucketed net-revenue trend for the chart. Uses the same per-order ladder as
// everything above rather than a second, subtly different SQL sum — a trend
// line that disagrees with the card above it is worse than no trend line.
//
// The bucket size comes from the window (lib/trendWindow.ts) rather than being
// fixed at a month, because the chart is zoomable: pinching in re-buckets the
// same orders by week and then by day. Re-bucketing on the server, through this
// one function, is what stops a zoomed-in day from summing differently to the
// month that contains it.
export async function getRevenueTrend(organizationId: string, window?: TrendWindow) {
  const w = window ?? resolveTrendWindow({}, new Date(), DEFAULT_TIMEZONE);
  const { from, to, granularity, timeZone } = w;

  const [orders, credits, bankConnections, earliestCredit, earliestOrder] = await Promise.all([
    prisma.order.findMany({
      where: { organizationId, placedAt: { gte: from, lte: to } },
      select: { ...ORDER_SELECT, placedAt: true },
    }),
    prisma.bankTransaction.findMany({
      where: { organizationId, direction: "CREDIT", valueDate: { gte: from, lte: to } },
      select: { amount: true, valueDate: true },
    }),
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

  const layout = enumerateBuckets(w);
  const buckets = new Map<string, { orders: OrderRow[]; cash: bigint }>();
  for (const b of layout) buckets.set(b.key, { orders: [], cash: 0n });

  for (const o of orders) {
    buckets.get(bucketKeyFor(o.placedAt, granularity, timeZone))?.orders.push(o);
  }
  for (const c of credits) {
    const bucket = buckets.get(bucketKeyFor(c.valueDate, granularity, timeZone));
    if (bucket) bucket.cash += c.amount;
  }

  // Only add the year to labels when the window actually spans one, so a
  // six-month chart keeps the bare "Mar Apr May" it has always had.
  const crossesYears = layout.length > 0 && layout[0]!.key.slice(0, 4) !== layout[layout.length - 1]!.key.slice(0, 4);

  const series = layout.map((b) => {
    const bucket = buckets.get(b.key)!;
    const s = summarise(bucket.orders);

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
      netRevenue: ordersVisible ? paiseToRupees(s.netRevenue) : null,
      grossOrderValue: ordersVisible ? paiseToRupees(s.grossOrderValue) : null,
      cashReceived: cashVisible ? paiseToRupees(bucket.cash) : null,
      cashVisible,
      ordersVisible,
      orders: s.recognisedCount,
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
