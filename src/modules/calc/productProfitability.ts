import { resolveDateRange, type ResolvedRange, describeRange } from "../../lib/dateRange.js";
import { scopeWhere, type EntityScope } from "../../lib/entityScope.js";
import { prisma } from "../../lib/prisma.js";
import { paiseToRupees } from "./money.js";

// §40 SKU profitability. The spec's full version wants units, revenue, CM
// amount, CM%, refund%, RTO%, ad spend, CAC and shipping per unit. Per-SKU RTO,
// ads and shipping still need allocation inputs that don't exist, so this
// returns the derivable subset and says which layer it stops at, rather than
// allocating from thin air.
//
// Effectively this is CM0 per SKU (§36: net revenue − product COGS), where
// "net revenue" means the same thing it means on the Revenue page (§11):
// line value, less discount, less tax, LESS REFUNDS. A products table that
// skipped refunds would rank a product by money the business gave back.

export const FORMULA_VERSION = "v2";

// §41 multi-item order allocation, used only where the source system does NOT
// state a line's own figures. An order's discount and tax sit at ORDER level for
// such connectors, but profitability is per SKU, so they have to be pushed down
// to the lines. Revenue-weighted is the spec's stated reasonable fallback and
// the only one available (weight- and unit-based allocation would need per-line
// weights and a policy setting).
//
// Integer maths throughout, and the LAST line absorbs the rounding remainder so
// the allocated parts always sum back to the order total exactly — otherwise
// per-SKU revenue wouldn't add up to the revenue on the Revenue page, which is
// the §1 failure all over again at a smaller scale.
function allocateByRevenue(total: bigint, lineValues: bigint[]): bigint[] {
  const sum = lineValues.reduce((a, v) => a + v, 0n);
  if (sum === 0n || total === 0n) return lineValues.map(() => 0n);
  const out: bigint[] = [];
  let allocated = 0n;
  for (let i = 0; i < lineValues.length; i += 1) {
    if (i === lineValues.length - 1) {
      out.push(total - allocated);
    } else {
      const share = (total * lineValues[i]!) / sum;
      out.push(share);
      allocated += share;
    }
  }
  return out;
}

export async function getProductProfitability(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({}),
  limit = 10,
  // §12.2 (P5.6). Null means the whole organisation.
  scope: EntityScope | null = null
) {
  const orders = await prisma.order.findMany({
    where: {
      ...scopeWhere(organizationId, scope),
      placedAt: { gte: range.from, lte: range.to },
      // §16 — cancelled orders contribute neither revenue nor cost.
      cancelledAt: null,
    },
    select: {
      discountAmount: true,
      taxAmount: true,
      grossAmount: true,
      shippingAmount: true,
      refundedAmount: true,
      lineItems: {
        select: {
          sku: true,
          productName: true,
          quantity: true,
          totalAmount: true,
          cogsAmount: true,
          discountAmount: true,
          taxAmount: true,
          refundedAmount: true,
          refundedTaxAmount: true,
          refundedQuantity: true,
        },
      },
    },
  });

  interface Agg {
    sku: string;
    productName: string;
    units: number;
    unitsRefunded: number;
    // What customers were actually charged, GST and all, before any deduction.
    // Carried so the UI can show how the billed figure becomes the revenue
    // figure: "3 x ₹899 = ₹2,697" is the number a founder has in their head,
    // and a card showing ₹2,618 with no bridge to it reads as a bug.
    billed: bigint;
    discounts: bigint;
    gst: bigint;
    grossRevenue: bigint;
    refunds: bigint;
    netRevenue: bigint;
    cogs: bigint;
    costedLines: number;
    lines: number;
  }
  const bySku = new Map<string, Agg>();

  // §53/§110 — how much of this table is measured versus inferred, weighted by
  // value rather than by row count, so one big allocated order can't hide behind
  // a hundred small measured ones.
  let measuredValue = 0n;
  let allocatedValue = 0n;
  let refundsMeasured = 0n;
  let refundsAllocated = 0n;

  for (const order of orders) {
    const lines = order.lineItems;
    if (lines.length === 0) continue;
    const lineValues = lines.map((l) => l.totalAmount);
    const orderValue = lineValues.reduce((a, v) => a + v, 0n);

    // Use the source system's own per-line figures when it supplied them for
    // every line; fall back to allocation only when it didn't. Mixing the two
    // within one order would double-count, since the order-level total already
    // includes whatever the lines state.
    const measured = lines.every((l) => l.discountAmount !== null && l.taxAmount !== null);
    const discounts = measured
      ? lines.map((l) => l.discountAmount!)
      : allocateByRevenue(order.discountAmount, lineValues);
    // §10 — subtract tax only where it is actually INSIDE the line price. A
    // store can price either way and this one does both: on the 17 orders here
    // with `taxes_included: false` the tax is added on top, so deducting it from
    // the line value would understate those SKUs and put the table ₹1,069 out of
    // step with the Revenue page. Measured the same way the ladder measures it —
    // against grossAmount, which is what the customer actually paid.
    const taxExclusiveSale = order.grossAmount - order.shippingAmount - order.taxAmount;
    const taxInclusivePricing = orderValue - order.discountAmount > taxExclusiveSale;
    const taxes = !taxInclusivePricing
      ? lines.map(() => 0n)
      : measured
        ? lines.map((l) => l.taxAmount!)
        : allocateByRevenue(order.taxAmount, lineValues);
    if (measured) measuredValue += orderValue;
    else allocatedValue += orderValue;

    // Refunds. Lines carry what the source system itemised; anything refunded
    // beyond that is a lump sum against the order (Shopify calls it a refund
    // discrepancy) which names no SKU, so §41 allocation is the only option.
    // 12% of this store's refund value arrives that way.
    const lineRefunds = lines.map((l) => l.refundedAmount ?? 0n);
    const attributed = lineRefunds.reduce((a, v) => a + v, 0n);
    const residual = order.refundedAmount - attributed;
    const residualShares =
      residual > 0n ? allocateByRevenue(residual, lineValues) : lines.map(() => 0n);
    refundsMeasured += attributed;
    if (residual > 0n) refundsAllocated += residual;

    // §10 — refunds are recorded tax-inclusive, but net revenue is
    // tax-exclusive, so only the ex-GST portion may be deducted from it. The
    // order's own gross/tax ratio is the right divisor for the unitemised part.
    const exGstRatioNum = order.grossAmount - order.taxAmount;
    const exGstRatioDen = order.grossAmount;

    lines.forEach((line, i) => {
      const key = line.sku || `(no SKU) ${line.productName}`;
      const measuredRefund = lineRefunds[i]!;
      const measuredRefundTax = line.refundedTaxAmount ?? 0n;
      const residualShare = residualShares[i]!;
      const residualExGst =
        exGstRatioDen > 0n ? (residualShare * exGstRatioNum) / exGstRatioDen : residualShare;
      const refundExGst = measuredRefund - measuredRefundTax + residualExGst;

      // Line net revenue, tax-exclusive and net of returns, consistent with
      // §10/§11 at order level.
      const grossRevenue = line.totalAmount - discounts[i]! - taxes[i]!;
      const netRevenue = grossRevenue - refundExGst;

      const cur =
        bySku.get(key) ??
        ({
          sku: key,
          productName: line.productName,
          units: 0,
          unitsRefunded: 0,
          billed: 0n,
          discounts: 0n,
          gst: 0n,
          grossRevenue: 0n,
          refunds: 0n,
          netRevenue: 0n,
          cogs: 0n,
          costedLines: 0,
          lines: 0,
        } as Agg);
      cur.units += line.quantity;
      cur.unitsRefunded += line.refundedQuantity ?? 0;
      cur.billed += line.totalAmount;
      cur.discounts += discounts[i]!;
      cur.gst += taxes[i]!;
      cur.grossRevenue += grossRevenue;
      cur.refunds += refundExGst;
      cur.netRevenue += netRevenue;
      cur.lines += 1;
      if (line.cogsAmount !== null) {
        cur.cogs += line.cogsAmount;
        cur.costedLines += 1;
      }
      bySku.set(key, cur);
    });
  }

  const products = [...bySku.values()].map((a) => {
    // A SKU is only profitable-or-not if EVERY one of its lines is costed.
    // Partially-costed SKUs would show inflated margin, which is exactly how a
    // loss-making product ends up in a "most profitable" table.
    const fullyCosted = a.lines > 0 && a.costedLines === a.lines;
    const cm0 = fullyCosted ? a.netRevenue - a.cogs : null;
    // §13 — units net of returns, so a product returned as often as it sells
    // doesn't read as a bestseller.
    const unitsNet = a.units - a.unitsRefunded;
    return {
      sku: a.sku,
      productName: a.productName,
      units: unitsNet,
      unitsSold: a.units,
      unitsRefunded: a.unitsRefunded,
      billedMinor: a.billed.toString(),
      billed: paiseToRupees(a.billed),
      discountsMinor: a.discounts.toString(),
      discounts: paiseToRupees(a.discounts),
      gstMinor: a.gst.toString(),
      gst: paiseToRupees(a.gst),
      grossRevenueMinor: a.grossRevenue.toString(),
      grossRevenue: paiseToRupees(a.grossRevenue),
      refundsMinor: a.refunds.toString(),
      refunds: paiseToRupees(a.refunds),
      refundRatePct:
        a.grossRevenue === 0n
          ? null
          : Math.round((Number(a.refunds) / Number(a.grossRevenue)) * 1000) / 10,
      netRevenueMinor: a.netRevenue.toString(),
      netRevenue: paiseToRupees(a.netRevenue),
      cogsMinor: fullyCosted ? a.cogs.toString() : null,
      cogs: fullyCosted ? paiseToRupees(a.cogs) : null,
      cm0Minor: cm0?.toString() ?? null,
      cm0: cm0 === null ? null : paiseToRupees(cm0),
      cm0Pct:
        cm0 === null || a.netRevenue === 0n
          ? null
          : Math.round((Number(cm0) / Number(a.netRevenue)) * 1000) / 10,
      costed: fullyCosted,
      costedLines: a.costedLines,
      lines: a.lines,
    };
  });

  const costed = products.filter((p) => p.costed);
  const byMargin = [...costed].sort((a, b) => (b.cm0 ?? 0) - (a.cm0 ?? 0));
  const byRevenue = [...products].sort((a, b) => b.netRevenue - a.netRevenue);

  const totalValue = measuredValue + allocatedValue;
  const totalRefunds = refundsMeasured + refundsAllocated;
  // Rounded once and reused, so the headline percentage and the warning that
  // explains it can never disagree by a rounding step.
  const measuredValuePct =
    totalValue === 0n ? null : Math.round(Number((measuredValue * 1000n) / totalValue)) / 10;
  const refundsMeasuredPct =
    totalRefunds === 0n ? null : Math.round(Number((refundsMeasured * 1000n) / totalRefunds)) / 10;

  const warnings: string[] = [];
  if (measuredValuePct !== null && measuredValuePct < 100) {
    warnings.push(
      `${(100 - measuredValuePct).toFixed(1)}% of line value comes from a source that reports discount and tax only at order level; those lines are split by revenue weight (§41).`
    );
  }
  if (refundsMeasuredPct !== null && refundsMeasuredPct < 100) {
    warnings.push(
      `${(100 - refundsMeasuredPct).toFixed(1)}% of refund value was issued against the order rather than a named product, and is split by revenue weight (§41).`
    );
  }

  return {
    metric: "product_profitability",
    currency: "INR",
    period: { start: range.from.toISOString(), end: range.to.toISOString() },
    // Both windows, stated as days on the org calendar — a comparison that
    // will not disclose its own boundaries is asking to be trusted blind.
    window: describeRange(range),
    formulaVersion: FORMULA_VERSION,
    lastCalculatedAt: new Date().toISOString(),
    // §90 — profitability without complete COGS is not an estimate of profit.
    status: costed.length === 0 ? "INCOMPLETE" : "ESTIMATED",
    // Tells the UI which table it can honestly render: profitability rankings
    // need costs, revenue rankings don't.
    canRankByMargin: costed.length > 0,
    skuCount: products.length,
    costedSkuCount: costed.length,
    stopsAt: "CM0",
    stopsAtNote:
      "Per-SKU shipping, RTO and ad spend need allocation inputs that don't exist yet (§40 asks for them; §41 would allocate them).",
    // §110 trust layer: revenue is measured per line, not inferred, wherever
    // this is 100.
    measuredValuePct,
    refundsMeasuredPct,
    topByMargin: byMargin.slice(0, limit),
    bottomByMargin: byMargin.filter((p) => (p.cm0 ?? 0) < 0).slice(-limit).reverse(),
    topByRevenue: byRevenue.slice(0, limit),
    warnings,
  };
}
