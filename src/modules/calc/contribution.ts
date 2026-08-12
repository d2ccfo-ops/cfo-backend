import { resolveDateRange, type ResolvedRange, describeRange } from "../../lib/dateRange.js";
import { scopeWhere, type EntityScope } from "../../lib/entityScope.js";
import { prisma } from "../../lib/prisma.js";
import { getOrgSettings } from "../orgs/settings.js";
import { computePackaging, getFreightSplit, getRtoCost, getTransactionFees } from "./fulfilmentCosts.js";
import { paiseToRupees, sumPaise } from "./money.js";
import { getRevenueLadder } from "./revenueLadder.js";

// §36 contribution margin, LAYERED. The spec is emphatic that one blended
// "contribution margin" number is not enough — founders need to see which layer
// destroys the value:
//
//   CM0 = Net Revenue − Product COGS
//   CM1 = CM0 − Packaging − Forward Shipping − Reverse Shipping − RTO Cost
//   CM2 = CM1 − Gateway Fees − COD Fees − Marketplace Fees
//   CM3 = CM2 − Advertising
//
// §37: every percentage uses tax-exclusive Net Revenue as the denominator.
//
// THE HONESTY PROBLEM THIS MODULE IS BUILT AROUND
// -----------------------------------------------
// Most of those cost layers have no data source yet. Returning CM3 = CM0
// because packaging, shipping and fees all happen to be zero would produce a
// number that looks like a healthy margin and is in fact a lie — the most
// dangerous possible output for this product.
//
// So every layer reports `covered` alongside its amount. A layer with no data
// is `covered: false` and contributes zero, and any CM below an uncovered layer
// is marked `reliable: false`. §109: if meaningful inputs are missing, say so
// rather than showing false precision.

export const FORMULA_VERSION = "v1";

interface Layer {
  key: string;
  label: string;
  spec: string;
  amountMinor: string;
  amount: number;
  // Fully measured: every record in this period carries this cost.
  covered: boolean;
  // Whether ANY source exists for this layer. The distinction matters: COGS
  // with 30% of lines costed is partially covered and improving as a founder
  // enters costs, whereas packaging has no source at all and will stay zero
  // until something is built. Lumping the two together told the user to go
  // fix a data-entry problem that was actually a missing feature.
  hasSource: boolean;
  note: string;
  // P6.5. A measured cost that is REPORTED but not subtracted, because the
  // rupees in it are already inside another layer. RTO cost is the only one:
  // the freight on a returned parcel sits in forward and reverse shipping
  // already, so deducting it again as "RTO cost" would charge it twice while
  // keeping §36's formula looking symmetrical. Memo layers are excluded from
  // the CM arithmetic AND from the reliability chain — an unmeasurable memo
  // must not mark CM1 unreliable when every real deduction above it is covered.
  memo?: boolean;
}

export async function getContributionMargin(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({}),
  // §12.2 (P5.6). Null means the whole organisation, which is what every
  // caller passed before this existed and remains the default.
  scope: EntityScope | null = null
) {
  const [ladder, lineItems, shipments, adSpend, payments, settings, freight, fees, orderCount] = await Promise.all([
    getRevenueLadder(organizationId, range, scope),
    prisma.orderLineItem.findMany({
      where: {
        order: {
          ...scopeWhere(organizationId, scope),
          placedAt: { gte: range.from, lte: range.to },
          // §16: a cancelled order recognises neither revenue nor COGS, so its
          // lines must not appear in the cost side either.
          cancelledAt: null,
        },
      },
      select: { cogsAmount: true, totalAmount: true },
    }),
    prisma.shipment.findMany({
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      select: { freightAmount: true, status: true },
    }),
    prisma.adSpend.findMany({
      where: { organizationId, date: { gte: range.from, lte: range.to } },
      select: { spendAmount: true, currency: true },
    }),
    prisma.payment.findMany({
      where: { organizationId, capturedAt: { gte: range.from, lte: range.to } },
      select: { feeAmount: true },
    }),
    getOrgSettings(organizationId),
    getFreightSplit(organizationId, range),
    getTransactionFees(organizationId, range),
    prisma.order.count({
      where: { ...scopeWhere(organizationId, scope), placedAt: { gte: range.from, lte: range.to }, cancelledAt: null },
    }),
  ]);

  const netRevenue = BigInt(ladder.ladder.netRevenue.valueMinor);

  // --- COGS (§19). Only lines with a stamped cost count. The uncosted count is
  // what makes this layer's coverage honest.
  const costedLines = lineItems.filter((l) => l.cogsAmount !== null);
  const cogs = sumPaise(costedLines.map((l) => l.cogsAmount as bigint));
  const uncostedLines = lineItems.length - costedLines.length;
  const cogsCovered = lineItems.length > 0 && uncostedLines === 0;
  // Value coverage, not line coverage — see §53's reasoning.
  const costedValue = sumPaise(costedLines.map((l) => l.totalAmount));
  const totalLineValue = sumPaise(lineItems.map((l) => l.totalAmount));
  const cogsValueCoveragePct =
    totalLineValue === 0n ? 0 : Math.round((Number(costedValue) / Number(totalLineValue)) * 1000) / 10;

  // --- Shipping (§24, §25). Forward is total billed freight MINUS return legs;
  // reverse is the return legs themselves. Derived by subtraction rather than
  // by re-summing forward invoice rows, because Shiprocket writes freightAmount
  // from its API and produces no invoice lines at all — see fulfilmentCosts.ts.
  const forwardShipping = freight.forwardMinor;
  const reverseShipping = freight.reverseMinor;
  const shippingCovered = freight.totalShipments > 0 && freight.billedShipments === freight.totalShipments;

  // --- Packaging (§23). The one layer whose source is a typed rate rather than
  // an ingested record: nothing a brand connects reports what a mailer costs.
  const packaging = computePackaging(settings, orderCount, lineItems.length);

  // --- Transaction fees (§27–§30). Gateway and marketplace are the same column
  // on the same table, split by the provider that produced the payment; COD
  // collection charges come from the remittance statement's fee column.
  const gatewayFees = fees.gatewayMinor;
  const gatewayCovered = fees.gatewayPayments > 0 && fees.gatewayWithFee === fees.gatewayPayments;
  const marketplaceCovered = fees.marketplacePayments > 0 && fees.marketplaceWithFee === fees.marketplacePayments;

  // --- Advertising (§31). INR only: mixing a USD-billed ad account into a
  // rupee margin would be off by ~85x, the same trap modules/calc/ads.ts guards.
  const inrAds = adSpend.filter((a) => a.currency === "INR");
  const advertising = sumPaise(inrAds.map((a) => a.spendAmount));
  const adsCovered = adSpend.length > 0 && inrAds.length === adSpend.length;

  // --- What returns cost (§17). Reported, never deducted — the freight in it
  // is already inside forward and reverse shipping above.
  const rto = await getRtoCost(organizationId, range, packaging);

  const layers: Layer[] = [
    {
      key: "cogs",
      label: "Product COGS",
      spec: "§19",
      amountMinor: cogs.toString(),
      amount: paiseToRupees(cogs),
      covered: cogsCovered,
      hasSource: costedLines.length > 0,
      note: cogsCovered
        ? `All ${costedLines.length} order lines costed`
        : `${uncostedLines} of ${lineItems.length} order lines have no cost (${cogsValueCoveragePct}% of line value covered)`,
    },
    {
      key: "packaging",
      label: "Packaging",
      spec: "§23",
      amountMinor: packaging.amountMinor.toString(),
      amount: paiseToRupees(packaging.amountMinor),
      covered: packaging.configured,
      hasSource: packaging.configured,
      note: packaging.configured
        ? `₹${paiseToRupees(packaging.perOrderPaise)}/order + ₹${paiseToRupees(packaging.perItemPaise)}/item over ${packaging.orders} orders and ${packaging.items} items`
        : "Not configured — set a per-order and per-item packaging rate in Settings. No connected system reports it.",
    },
    {
      key: "forwardShipping",
      label: "Forward shipping",
      spec: "§24",
      amountMinor: forwardShipping.toString(),
      amount: paiseToRupees(forwardShipping),
      covered: shippingCovered,
      hasSource: freight.billedShipments > 0,
      note: freight.totalShipments === 0
        ? "No shipments in this period"
        : `${freight.billedShipments} of ${freight.totalShipments} shipments carry a freight amount` +
          (freight.reverseMinor > 0n ? ", excluding return legs (counted below)" : ""),
    },
    {
      key: "reverseShipping",
      label: "Reverse shipping",
      spec: "§25",
      amountMinor: reverseShipping.toString(),
      amount: paiseToRupees(reverseShipping),
      // Covered once a return-leg source exists. A period with no returns then
      // reports a measured zero rather than an unmeasurable one — which is the
      // distinction a founder needs to tell "no returns" from "we can't see
      // returns".
      covered: freight.hasReverseSource,
      hasSource: freight.hasReverseSource,
      note: freight.hasReverseSource
        ? `${freight.returnedShipments} shipments billed a return leg`
        : "No source — needs a courier freight invoice, which is the only document that states reverse freight",
    },
    {
      key: "rtoCost",
      label: "RTO cost (memo)",
      spec: "§17",
      amountMinor: rto.totalMinor.toString(),
      amount: paiseToRupees(rto.totalMinor),
      covered: rto.measurable,
      hasSource: rto.measurable,
      // The memo flag is what keeps this out of the arithmetic. See Layer.memo.
      memo: true,
      note: rto.measurable
        ? `${rto.rtoShipments} of ${rto.totalShipments} shipments returned (${rto.ratePct}%). Already counted in shipping and packaging above — shown here to answer "what do returns cost", not deducted again.`
        : rto.rtoShipments === 0
          ? "No RTO shipments in this period"
          : `${rto.rtoShipments} RTO shipments, none carrying freight — the count is real, the cost is not measurable`,
    },
    {
      key: "gatewayFees",
      label: "Gateway fees",
      spec: "§27",
      amountMinor: gatewayFees.toString(),
      amount: paiseToRupees(gatewayFees),
      covered: gatewayCovered,
      hasSource: fees.gatewayWithFee > 0,
      note: fees.gatewayPayments === 0
        ? "No gateway payments in this period"
        : `${fees.gatewayWithFee} of ${fees.gatewayPayments} gateway payments carry a fee`,
    },
    {
      key: "codFees",
      label: "COD fees",
      spec: "§29",
      amountMinor: fees.codMinor.toString(),
      amount: paiseToRupees(fees.codMinor),
      // Covered only when THIS PERIOD's COD charges are known — either a
      // remittance statement covers it, or there was no COD to charge for.
      // A period with COD sales and no statement is a gap, not a zero.
      covered: fees.codCovered,
      hasSource: fees.hasCodSource,
      note: fees.codLines > 0
        ? `${fees.codLines} COD remittance lines in this period`
        : fees.codOrders === 0
          ? "No COD orders in this period"
          : `${fees.codOrders} COD orders in this period and no remittance statement covering them — the collection charge on that cash is unknown, not zero`,
    },
    {
      key: "marketplaceFees",
      label: "Marketplace fees",
      spec: "§30",
      amountMinor: fees.marketplaceMinor.toString(),
      amount: paiseToRupees(fees.marketplaceMinor),
      covered: marketplaceCovered,
      hasSource: fees.marketplaceWithFee > 0,
      note: fees.marketplacePayments === 0
        ? "No marketplace settlements in this period"
        : `${fees.marketplaceWithFee} of ${fees.marketplacePayments} marketplace settlements carry a fee (referral + closing + GST)`,
    },
    {
      key: "advertising",
      label: "Advertising",
      spec: "§31",
      amountMinor: advertising.toString(),
      amount: paiseToRupees(advertising),
      covered: adsCovered,
      hasSource: inrAds.length > 0,
      note: adSpend.length === 0 ? "No ad spend recorded in this period" : `${inrAds.length} of ${adSpend.length} ad-spend rows are INR`,
    },
  ];

  const byKey = new Map(layers.map((l) => [l.key, l]));
  const amt = (key: string) => BigInt(byKey.get(key)!.amountMinor);
  const cov = (key: string) => byKey.get(key)!.covered;

  const cm0 = netRevenue - amt("cogs");
  // rtoCost is deliberately absent: it is a memo whose rupees are already in
  // packaging, forward shipping and reverse shipping. §36 lists it as a fourth
  // CM1 deduction, which would charge the same freight twice — see
  // fulfilmentCosts.ts for why the formula is wrong and this is not.
  const cm1 = cm0 - amt("packaging") - amt("forwardShipping") - amt("reverseShipping");
  const cm2 = cm1 - amt("gatewayFees") - amt("codFees") - amt("marketplaceFees");
  const cm3 = cm2 - amt("advertising");

  // A CM is only as trustworthy as the least-covered layer above it. This is
  // cumulative on purpose: CM3 can't be reliable if CM1 wasn't. rtoCost is
  // excluded for the same reason it is not deducted — an unmeasurable memo must
  // not mark CM1 unreliable when every rupee it would have contained is already
  // measured in the layers above it.
  const cm0Reliable = cov("cogs");
  const cm1Reliable = cm0Reliable && cov("packaging") && cov("forwardShipping") && cov("reverseShipping");
  const cm2Reliable = cm1Reliable && cov("gatewayFees") && cov("codFees") && cov("marketplaceFees");
  const cm3Reliable = cm2Reliable && cov("advertising");

  // §37 — always over tax-exclusive net revenue.
  const marginPct = (value: bigint) =>
    netRevenue === 0n ? null : Math.round((Number(value) / Number(netRevenue)) * 1000) / 10;

  const level = (value: bigint, reliable: boolean, label: string, includes: string) => ({
    label,
    includes,
    valueMinor: value.toString(),
    value: paiseToRupees(value),
    marginPct: marginPct(value),
    reliable,
  });

  // Memo layers are excluded: "RTO cost has no source" would be reported as a
  // cost treated as zero, when in fact nothing is missing from the margin — its
  // rupees are counted above. Naming it here sends a founder to fix a gap that
  // is not there.
  const missingLayers = layers.filter((l) => !l.hasSource && !l.memo).map((l) => `${l.label} (${l.spec})`);
  const warnings: string[] = [];
  if (!cogsCovered) {
    warnings.push(
      lineItems.length === 0
        ? "No order lines in this period."
        : `${uncostedLines} of ${lineItems.length} order lines have no product cost — CM0 and everything below it understate cost and therefore overstate margin.`
    );
  }
  if (missingLayers.length > 0) {
    warnings.push(`Cost layers with no data source, treated as zero: ${missingLayers.join(", ")}.`);
  }
  warnings.push(...ladder.warnings);

  // §89 completeness for contribution margin, using the spec's own example
  // weights (Revenue 25, COGS 20, Shipping 15, Gateway 10, Refunds/RTO 10,
  // Ads 20). Revenue and refunds are sourced, so they score; the rest score
  // only when their layer is covered.
  const dataCompleteness =
    25 + // revenue — always available
    // Refunds/RTO. The refund side has always been real; the RTO side became
    // measurable once courier invoices supplied return-leg freight (P6.5), so
    // this scores in full only when that source exists.
    (rto.measurable ? 10 : 5) +
    (cogsCovered ? 20 : Math.round(20 * (cogsValueCoveragePct / 100))) +
    (shippingCovered ? 15 : 0) +
    (gatewayCovered ? 10 : 0) +
    (adsCovered ? 20 : 0);

  return {
    metric: "contribution_margin",
    currency: "INR",
    period: { start: range.from.toISOString(), end: range.to.toISOString() },
    // Both windows, stated as days on the org calendar — a comparison that
    // will not disclose its own boundaries is asking to be trusted blind.
    window: describeRange(range),
    comparison: range.comparison,
    formulaVersion: FORMULA_VERSION,
    lastCalculatedAt: new Date().toISOString(),
    // §90. Can never exceed ESTIMATED while any layer is uncovered, and is
    // INCOMPLETE whenever COGS — the single largest cost line — covers less
    // than nearly all of line value. A margin computed over 31% of costs is not
    // an estimate of the margin, it's a different number wearing its name.
    status: lineItems.length > 0 && cogsValueCoveragePct < 95 ? "INCOMPLETE" : "ESTIMATED",
    dataCompleteness: Math.min(100, dataCompleteness),
    warnings,

    netRevenue: {
      valueMinor: netRevenue.toString(),
      value: paiseToRupees(netRevenue),
      spec: "§11",
    },

    levels: {
      cm0: level(cm0, cm0Reliable, "CM0 — after product cost", "Net revenue − COGS"),
      cm1: level(cm1, cm1Reliable, "CM1 — after fulfilment", "CM0 − packaging, forward/reverse shipping, RTO"),
      cm2: level(cm2, cm2Reliable, "CM2 — after transaction costs", "CM1 − gateway, COD and marketplace fees"),
      cm3: level(cm3, cm3Reliable, "CM3 — after advertising", "CM2 − ad spend"),
    },

    layers,
    cogsCoverage: {
      costedLines: costedLines.length,
      totalLines: lineItems.length,
      valueCoveragePct: cogsValueCoveragePct,
    },
  };
}
