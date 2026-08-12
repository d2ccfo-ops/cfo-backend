import { resolveDateRange, type ResolvedRange, describeRange } from "../../lib/dateRange.js";
import { scopeWhere, type EntityScope } from "../../lib/entityScope.js";
import { prisma } from "../../lib/prisma.js";
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
}

export async function getContributionMargin(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({}),
  // §12.2 (P5.6). Null means the whole organisation, which is what every
  // caller passed before this existed and remains the default.
  scope: EntityScope | null = null
) {
  const [ladder, lineItems, shipments, adSpend, payments] = await Promise.all([
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

  // --- Forward shipping (§24). Shipment.freightAmount, where a connector
  // supplied one. Reverse shipping (§25) and RTO cost (§17) have no source at
  // all — deliberately NOT approximated from forward freight, which would
  // invent a number.
  const freightRows = shipments.filter((s) => s.freightAmount !== null);
  const forwardShipping = sumPaise(freightRows.map((s) => s.freightAmount as bigint));
  const shippingCovered = shipments.length > 0 && freightRows.length === shipments.length;

  // --- Gateway fees (§27). Payment.feeAmount where present.
  const feeRows = payments.filter((p) => p.feeAmount !== null);
  const gatewayFees = sumPaise(feeRows.map((p) => p.feeAmount as bigint));
  const gatewayCovered = payments.length > 0 && feeRows.length === payments.length;

  // --- Advertising (§31). INR only: mixing a USD-billed ad account into a
  // rupee margin would be off by ~85x, the same trap modules/calc/ads.ts guards.
  const inrAds = adSpend.filter((a) => a.currency === "INR");
  const advertising = sumPaise(inrAds.map((a) => a.spendAmount));
  const adsCovered = adSpend.length > 0 && inrAds.length === adSpend.length;

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
      amountMinor: "0",
      amount: 0,
      covered: false,
      hasSource: false,
      note: "No source — needs a per-order/per-item packaging rule, which has no configuration table yet",
    },
    {
      key: "forwardShipping",
      label: "Forward shipping",
      spec: "§24",
      amountMinor: forwardShipping.toString(),
      amount: paiseToRupees(forwardShipping),
      covered: shippingCovered,
      hasSource: freightRows.length > 0,
      note: shipments.length === 0
        ? "No shipments in this period"
        : `${freightRows.length} of ${shipments.length} shipments carry a freight amount`,
    },
    {
      key: "reverseShipping",
      label: "Reverse shipping",
      spec: "§25",
      amountMinor: "0",
      amount: 0,
      covered: false,
      hasSource: false,
      note: "No source — reverse freight is not reported by any connected courier",
    },
    {
      key: "rtoCost",
      label: "RTO cost",
      spec: "§17",
      amountMinor: "0",
      amount: 0,
      covered: false,
      hasSource: false,
      note: "No source — needs forward+reverse freight, packaging and write-off per RTO shipment",
    },
    {
      key: "gatewayFees",
      label: "Gateway fees",
      spec: "§27",
      amountMinor: gatewayFees.toString(),
      amount: paiseToRupees(gatewayFees),
      covered: gatewayCovered,
      hasSource: feeRows.length > 0,
      note: payments.length === 0 ? "No payment records in this period" : `${feeRows.length} of ${payments.length} payments carry a fee`,
    },
    {
      key: "codFees",
      label: "COD fees",
      spec: "§29",
      amountMinor: "0",
      amount: 0,
      covered: false,
      hasSource: false,
      note: "No source — COD collection charges are not reported by any connected courier",
    },
    {
      key: "marketplaceFees",
      label: "Marketplace fees",
      spec: "§30",
      amountMinor: "0",
      amount: 0,
      covered: false,
      hasSource: false,
      note: "No source — needs Amazon/Flipkart settlement ingestion",
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
  const cm1 = cm0 - amt("packaging") - amt("forwardShipping") - amt("reverseShipping") - amt("rtoCost");
  const cm2 = cm1 - amt("gatewayFees") - amt("codFees") - amt("marketplaceFees");
  const cm3 = cm2 - amt("advertising");

  // A CM is only as trustworthy as the least-covered layer above it. This is
  // cumulative on purpose: CM3 can't be reliable if CM1 wasn't.
  const cm0Reliable = cov("cogs");
  const cm1Reliable = cm0Reliable && cov("packaging") && cov("forwardShipping") && cov("reverseShipping") && cov("rtoCost");
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

  const missingLayers = layers.filter((l) => !l.hasSource).map((l) => `${l.label} (${l.spec})`);
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
    10 + // refunds/RTO — refund side is real; RTO cost is not, so half credit
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
