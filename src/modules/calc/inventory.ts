import { prisma } from "../../lib/prisma.js";
import { paiseToRupees, sumPaise } from "./money.js";
import { buildCostResolver } from "./cogs.js";

// Inventory value = sum(variant.price * variant.inventoryQuantity) across
// every Product this org has, as of right now. Unlike revenue/cash-received/
// available-cash, there's deliberately no `priorValue`/`changePct` here:
// Product/ProductVariant are overwritten in place on every sync (see
// modules/connectors/shopify's upsertProduct — Shopify itself only reports
// *current* stock, not a history of it), so there's no 30-days-ago figure to
// compare against without a separate time-series table this MVP doesn't
// have. Showing a fabricated "vs last month" here would be worse than not
// showing one — same reasoning as available-cash's missingOpeningBalance
// handling in modules/calc/cash.ts.

const FORMULA_VERSION = "v2";

// UNITS ABOVE THIS ARE NOT A STOCK LEVEL.
//
// Found by the cash-conversion-cycle work (P6.2), which reported DIO of
// 1,684,116 days for the pilot organisation. The arithmetic was right; the
// input was not. This org's variants include one with 1,000,000 units at ₹1
// and four above 100,000 — the placeholder quantities a merchant sets in
// Shopify so the storefront never blocks a sale on an untracked item. Summed
// at price, they produced an inventory valuation of ₹2,274 crore for a brand
// doing about ₹1 crore of revenue.
//
// That figure has been on the Inventory page all along. It is the most
// dangerous kind of wrong number in this product: not invented, but COMPUTED
// — from real rows, by correct code, at a magnitude nobody sanity-checked.
//
// So variants above the threshold are excluded from the headline and REPORTED,
// with their SKUs. Not silently capped: if 20,000 units really is this
// business's stock level, the founder needs to see that we disagreed and say
// so, rather than find a quietly adjusted number.
const IMPLAUSIBLE_UNITS_PER_VARIANT = 10_000;

export async function getInventoryValueSummary(organizationId: string) {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const variants = await prisma.productVariant.findMany({
    where: { product: { organizationId } },
    select: { sku: true, price: true, inventoryQuantity: true },
  });

  const tracked = variants.filter((v) => v.inventoryQuantity < IMPLAUSIBLE_UNITS_PER_VARIANT);
  const untracked = variants.filter((v) => v.inventoryQuantity >= IMPLAUSIBLE_UNITS_PER_VARIANT);

  // The headline is the defensible figure. The all-variants total is still
  // reported beside it, because hiding the difference would leave someone
  // comparing this page against Shopify's own number with no explanation.
  const valueMinor = sumPaise(tracked.map((v) => v.price * BigInt(v.inventoryQuantity)));

  // ---------------------------------------------------------------------------
  // THE SAME STOCK, VALUED AT COST
  // ---------------------------------------------------------------------------
  // `valueMinor` above is at the SELLING price, which is the right basis for
  // "what is my stock worth" and the wrong one for any ratio against COGS.
  // calc/cashCycle.ts divided this retail figure by a landed-cost COGS to get
  // DIO — numerator at retail, denominator at cost — so DIO came out
  // overstated by the gross-margin multiple (a 60%-margin brand read ~2.5x too
  // many days), and CCC inherited the error while presenting all three terms
  // as measured.
  //
  // Both are returned rather than one replacing the other, because they answer
  // different questions and a caller picking the wrong one should have to say
  // which it wanted.
  const costResolver = await buildCostResolver(
    organizationId,
    tracked.map((v) => v.sku).filter((s): s is string => Boolean(s))
  );
  let costValueMinor = 0n;
  let costedUnits = 0;
  let uncostedUnits = 0;
  for (const v of tracked) {
    const cost = costResolver(v.sku, now);
    if (cost) {
      costValueMinor += cost.landedCost * BigInt(v.inventoryQuantity);
      costedUnits += v.inventoryQuantity;
    } else {
      uncostedUnits += v.inventoryQuantity;
    }
  }
  const unitsOnHand = tracked.reduce((sum, v) => sum + v.inventoryQuantity, 0);
  const allVariantsValueMinor = sumPaise(variants.map((v) => v.price * BigInt(v.inventoryQuantity)));
  const excludedUnits = untracked.reduce((sum, v) => sum + v.inventoryQuantity, 0);

  const warnings: string[] = [];
  if (untracked.length > 0) {
    const worst = [...untracked]
      .sort((a, b) => b.inventoryQuantity - a.inventoryQuantity)
      .slice(0, 5)
      .map((v) => `${v.sku ?? "(no SKU)"} at ${v.inventoryQuantity.toLocaleString("en-IN")} units`);
    warnings.push(
      `${untracked.length} variant(s) report ${excludedUnits.toLocaleString("en-IN")} units between them — at or above ${IMPLAUSIBLE_UNITS_PER_VARIANT.toLocaleString("en-IN")} each — and are EXCLUDED from this valuation. These are the placeholder quantities a store sets so an untracked item never blocks a sale, not counted stock. Largest: ${worst.join(", ")}. Including them would value this inventory at ${paiseToRupees(allVariantsValueMinor).toLocaleString("en-IN")} rupees.`
    );
  }

  const existingSnapshot = await prisma.metricSnapshot.findFirst({
    where: {
      organizationId,
      legalEntityId: null,
      metricKey: "inventory_value",
      granularity: "DAILY",
      periodStart: todayStart,
      formulaVersion: FORMULA_VERSION,
    },
    select: { id: true },
  });
  if (existingSnapshot) {
    await prisma.metricSnapshot.update({
      where: { id: existingSnapshot.id },
      data: { periodEnd: now, valueMinor, computedAt: new Date() },
    });
  } else {
    await prisma.metricSnapshot.create({
      data: {
        organizationId,
        metricKey: "inventory_value",
        granularity: "DAILY",
        periodStart: todayStart,
        periodEnd: now,
        valueMinor,
        formulaVersion: FORMULA_VERSION,
        confidence: "PROVISIONAL",
      },
    });
  }

  return {
    metricKey: "inventory_value",
    currency: "INR",
    valueMinor: valueMinor.toString(),
    value: paiseToRupees(valueMinor),
    /**
     * The same stock at LANDED COST. Use this — never valueMinor — for any
     * ratio against COGS; see the note where it is computed.
     *
     * costedUnits/uncostedUnits report how much of the stock the figure
     * actually covers, because a cost-basis total built from 12% of units is
     * not a smaller inventory, it is an unknown one.
     */
    costValueMinor: costValueMinor.toString(),
    costValue: paiseToRupees(costValueMinor),
    costedUnits,
    uncostedUnits,
    unitsOnHand,
    variantCount: tracked.length,
    // Stated so the difference from Shopify's own figure is explicable rather
    // than mysterious.
    allVariantsValueMinor: allVariantsValueMinor.toString(),
    excludedVariantCount: untracked.length,
    excludedUnits,
    implausibleUnitsThreshold: IMPLAUSIBLE_UNITS_PER_VARIANT,
    warnings,
    asOf: now.toISOString(),
    // Deliberately ignores the dashboard's date filter, and says so rather
    // than silently returning today's figure under a historical heading.
    // ProductVariant.inventoryQuantity holds only the CURRENT level — Shopify
    // sync overwrites it in place and nothing keeps a history — so "inventory
    // value as of 30 June" is unanswerable. Honouring the filter would mean
    // relabelling today's number with a past date, which is worse than not
    // filtering. Real historical values need a daily stock snapshot job.
    periodFiltered: false,
    pointInTime: true,
    formulaVersion: FORMULA_VERSION,
  };
}

// --- Sales velocity + days-of-cover -------------------------------------
// "Days of cover" needs a sales rate, which nothing above computes — it has
// to come from actual order history, correlated to inventory by SKU. This
// is the real formula behind it:
//
//   dailyVelocity = (units of this SKU sold in the trailing window) / windowDays
//   daysOfCover   = currentStock / dailyVelocity          (undefined if dailyVelocity is 0)
//
// A 30-day trailing window (not calendar-month, unlike the MTD metrics
// elsewhere in this app) — inventory decisions aren't naturally tied to
// calendar boundaries, and a rolling window avoids the "it's the 2nd of the
// month, we have basically no data yet" problem MTD metrics have.
const VELOCITY_WINDOW_DAYS = 30;
// Thresholds match the original mock card's own labels ("Within 14 days",
// "90+ days on hand") — reasonable, standard-ish defaults for e-commerce,
// but arbitrary MVP constants, not something derived from this org's data.
// Worth making configurable per-org later if founders want to tune them.
const STOCKOUT_RISK_DAYS_THRESHOLD = 14;
const SLOW_MOVING_DAYS_THRESHOLD = 90;
const COVER_FORMULA_VERSION = "v1";

export type InventoryCoverStatus = "out_of_stock" | "stockout_risk" | "slow_moving" | "unknown" | "healthy";

export interface VariantCoverInfo {
  variantId: string;
  productId: string;
  sku: string | null;
  price: bigint;
  inventoryQuantity: number;
  unitsSoldTrailing: number;
  dailyVelocity: number;
  daysOfCover: number | null; // null whenever a rate can't be established (no SKU to match, or confirmed zero sales)
  status: InventoryCoverStatus;
}

// Sold-units-per-SKU over the trailing window, keyed by SKU string (not
// variant id — that's the only thing that lets us correlate ProductVariant
// against OrderLineItem, since they come from two different Shopify
// endpoints with no shared foreign key). Line items with no SKU can't be
// matched to anything and are excluded rather than guessed at.
async function getSalesVelocityBySku(organizationId: string, windowStart: Date): Promise<Map<string, number>> {
  const lineItems = await prisma.orderLineItem.findMany({
    where: { sku: { not: null }, order: { organizationId, placedAt: { gte: windowStart } } },
    select: { sku: true, quantity: true },
  });
  const bySku = new Map<string, number>();
  for (const li of lineItems) {
    if (!li.sku) continue;
    bySku.set(li.sku, (bySku.get(li.sku) ?? 0) + li.quantity);
  }
  return bySku;
}

// Per-variant (true SKU-level) cover info — the building block for both the
// row-level /inventory listing (routes/inventory.ts) and the aggregated
// card metrics below, so the classification logic lives in exactly one
// place. Status priority, most urgent first:
//   1. out_of_stock   — zero units on hand, regardless of sales history
//   2. unknown        — no SKU on this variant, so it can't be matched
//                        against OrderLineItem.sku at all (a real data-
//                        quality gap, not a business signal — excluded
//                        from the stockout-risk/slow-moving stats below)
//   3. slow_moving    — has a SKU, but confirmed zero sales in the window
//                        while still holding stock (money tied up in
//                        something that isn't turning over at all — the
//                        starkest version of "slow", so it's grouped here
//                        with the "90+ days of cover" case rather than a
//                        separate bucket)
//   4. stockout_risk  — will run out inside STOCKOUT_RISK_DAYS_THRESHOLD
//                        days at the current sales pace
//   5. slow_moving    — will last past SLOW_MOVING_DAYS_THRESHOLD days
//   6. healthy        — everything else
export async function getVariantCoverInfo(organizationId: string): Promise<VariantCoverInfo[]> {
  const windowStart = new Date(Date.now() - VELOCITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [products, velocityBySku] = await Promise.all([
    // Explicit select, not `include: { variants: true }`: that pulled
    // Product.raw for every row — 5.6 MB of stored Shopify payload on this
    // store — into a function that only ever reads ids, skus, prices and
    // quantities, and it was loaded on every inventory request.
    prisma.product.findMany({
      where: { organizationId },
      select: {
        id: true,
        variants: { select: { id: true, sku: true, price: true, inventoryQuantity: true } },
      },
    }),
    getSalesVelocityBySku(organizationId, windowStart),
  ]);

  const result: VariantCoverInfo[] = [];
  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.inventoryQuantity === 0) {
        result.push({
          variantId: variant.id,
          productId: product.id,
          sku: variant.sku,
          price: variant.price,
          inventoryQuantity: 0,
          unitsSoldTrailing: 0,
          dailyVelocity: 0,
          daysOfCover: null,
          status: "out_of_stock",
        });
        continue;
      }

      if (!variant.sku) {
        result.push({
          variantId: variant.id,
          productId: product.id,
          sku: null,
          price: variant.price,
          inventoryQuantity: variant.inventoryQuantity,
          unitsSoldTrailing: 0,
          dailyVelocity: 0,
          daysOfCover: null,
          status: "unknown",
        });
        continue;
      }

      const unitsSoldTrailing = velocityBySku.get(variant.sku) ?? 0;
      const dailyVelocity = unitsSoldTrailing / VELOCITY_WINDOW_DAYS;
      const daysOfCover = dailyVelocity > 0 ? variant.inventoryQuantity / dailyVelocity : null;

      let status: InventoryCoverStatus;
      if (unitsSoldTrailing === 0) {
        status = "slow_moving"; // confirmed zero sales — the clearest "not moving" signal there is
      } else if (daysOfCover !== null && daysOfCover < STOCKOUT_RISK_DAYS_THRESHOLD) {
        status = "stockout_risk";
      } else if (daysOfCover !== null && daysOfCover > SLOW_MOVING_DAYS_THRESHOLD) {
        status = "slow_moving";
      } else {
        status = "healthy";
      }

      result.push({
        variantId: variant.id,
        productId: product.id,
        sku: variant.sku,
        price: variant.price,
        inventoryQuantity: variant.inventoryQuantity,
        unitsSoldTrailing,
        dailyVelocity,
        daysOfCover,
        status,
      });
    }
  }
  return result;
}

export async function getInventoryCoverSummary(organizationId: string) {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const variants = await getVariantCoverInfo(organizationId);

  // Value-weighted, not a plain average of days-of-cover across SKUs — an
  // unweighted average lets one high-count, low-value SKU (e.g. a ₹50
  // keychain with 5,000 units) dominate the figure just as much as a SKU
  // that actually represents real capital. Only SKUs with a computable
  // (non-null) daysOfCover contribute — out_of_stock/unknown/zero-sales
  // SKUs have no rate to average in.
  const coverable = variants.filter((v) => v.daysOfCover !== null);
  const totalCoverableValue = coverable.reduce((sum, v) => sum + Number(v.price) * v.inventoryQuantity, 0);
  const avgDaysOfCover =
    totalCoverableValue > 0
      ? coverable.reduce((sum, v) => sum + (v.daysOfCover as number) * Number(v.price) * v.inventoryQuantity, 0) / totalCoverableValue
      : null;

  const stockoutRiskVariants = variants.filter((v) => v.status === "stockout_risk");
  const slowMovingVariants = variants.filter((v) => v.status === "slow_moving");
  const slowMovingValueMinor = sumPaise(slowMovingVariants.map((v) => v.price * BigInt(v.inventoryQuantity)));

  const snapshots: Array<{ metricKey: string; valueMinor?: bigint; valueNumeric?: number }> = [
    { metricKey: "inventory_avg_days_of_cover", valueNumeric: avgDaysOfCover ?? undefined },
    { metricKey: "inventory_skus_at_stockout_risk", valueNumeric: stockoutRiskVariants.length },
    { metricKey: "inventory_slow_moving_value", valueMinor: slowMovingValueMinor },
  ];
  for (const snap of snapshots) {
    if (snap.valueNumeric === undefined && snap.valueMinor === undefined) continue; // avgDaysOfCover with no coverable SKUs at all
    const existing = await prisma.metricSnapshot.findFirst({
      where: {
        organizationId,
        legalEntityId: null,
        metricKey: snap.metricKey,
        granularity: "DAILY",
        periodStart: todayStart,
        formulaVersion: COVER_FORMULA_VERSION,
      },
      select: { id: true },
    });
    const data = {
      periodEnd: now,
      valueMinor: snap.valueMinor ?? null,
      valueNumeric: snap.valueNumeric ?? null,
      computedAt: new Date(),
    };
    if (existing) {
      await prisma.metricSnapshot.update({ where: { id: existing.id }, data });
    } else {
      await prisma.metricSnapshot.create({
        data: {
          organizationId,
          metricKey: snap.metricKey,
          granularity: "DAILY",
          periodStart: todayStart,
          formulaVersion: COVER_FORMULA_VERSION,
          confidence: "ESTIMATED", // sales velocity from a 30-day window is inherently an estimate, not a reconciled figure
          ...data,
        },
      });
    }
  }

  return {
    avgDaysOfCover,
    skusAtStockoutRisk: {
      count: stockoutRiskVariants.length,
      items: stockoutRiskVariants.map((v) => ({ variantId: v.variantId, sku: v.sku, daysOfCover: v.daysOfCover })),
    },
    slowMovingStockValue: {
      valueMinor: slowMovingValueMinor.toString(),
      value: paiseToRupees(slowMovingValueMinor),
      count: slowMovingVariants.length,
    },
    windowDays: VELOCITY_WINDOW_DAYS,
    asOf: now.toISOString(),
    // Also outside the date filter, for two reasons: it reads current stock
    // (same no-history problem as inventory value above), and its lookback is
    // part of the formula rather than a period the user picks — days-of-cover
    // means "at the last VELOCITY_WINDOW_DAYS of sales velocity", so letting a
    // filter shrink that to, say, one day would produce a wildly unstable
    // number that looks like the same metric.
    periodFiltered: false,
    pointInTime: true,
    formulaVersion: COVER_FORMULA_VERSION,
  };
}
