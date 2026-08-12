import type { CostSource } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

// §19 COGS. Two rules, and both matter:
//
//   1. Cost is DATE-EFFECTIVE. The cost applied to an order is the one that was
//      in force when the order was placed, not today's cost. Otherwise
//      renegotiating with a supplier silently rewrites last quarter's margin.
//   2. Cost is SNAPSHOT onto the order line (OrderLineItem.cogsAmount) at
//      ingestion. Rule 1 tells you which rate to use; rule 2 makes the result
//      immutable, so a corrected or back-dated cost row can't retroactively
//      change a period that's already been reported on — unless someone
//      deliberately re-runs the backfill, which is an explicit act (§95).

export const FORMULA_VERSION = "v1";

export function landedCostOf(parts: {
  purchaseCost: bigint;
  inboundFreight?: bigint;
  importDuty?: bigint;
  otherCost?: bigint;
}): bigint {
  return (
    parts.purchaseCost + (parts.inboundFreight ?? 0n) + (parts.importDuty ?? 0n) + (parts.otherCost ?? 0n)
  );
}

export interface ResolvedCost {
  sku: string;
  landedCost: bigint;
  source: CostSource;
  effectiveFrom: Date;
}

/**
 * Builds a per-SKU cost resolver for a set of SKUs, so a caller stamping
 * thousands of order lines does one query rather than one per line.
 *
 * Returns a function of (sku, asOf) giving the cost row in force at that
 * instant — the row with the greatest effectiveFrom that is <= asOf. A SKU with
 * costs only starting AFTER the order date resolves to null rather than
 * falling back to the earliest known cost: pretending we knew a cost we didn't
 * is exactly the false precision §109 warns about.
 */
export async function buildCostResolver(organizationId: string, skus: string[]) {
  const unique = [...new Set(skus.filter((s): s is string => !!s))];
  if (unique.length === 0) return () => null;

  const rows = await prisma.productCost.findMany({
    where: { organizationId, sku: { in: unique } },
    select: { sku: true, landedCost: true, source: true, effectiveFrom: true },
    orderBy: { effectiveFrom: "asc" },
  });

  const bySku = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySku.get(row.sku) ?? [];
    list.push(row);
    bySku.set(row.sku, list);
  }

  return (sku: string | null, asOf: Date): ResolvedCost | null => {
    if (!sku) return null;
    const list = bySku.get(sku);
    if (!list || list.length === 0) return null;
    // Ascending by effectiveFrom, so the last one at or before asOf wins.
    let chosen: (typeof list)[number] | null = null;
    for (const row of list) {
      if (row.effectiveFrom.getTime() <= asOf.getTime()) chosen = row;
      else break;
    }
    if (!chosen) return null;
    return {
      sku: chosen.sku,
      landedCost: chosen.landedCost,
      source: chosen.source,
      effectiveFrom: chosen.effectiveFrom,
    };
  };
}

/**
 * Stamps OrderLineItem.cogsAmount for orders in a window, using the cost in
 * force at each order's placedAt. Returns what it did — including how many
 * lines it could NOT cost, which is the number that drives §89 completeness and
 * decides whether contribution margin is reportable at all.
 *
 * Idempotent: re-running recomputes the same values from the same cost rows.
 */
export async function stampCogs(
  organizationId: string,
  opts: { from?: Date; to?: Date; onlyMissing?: boolean } = {}
) {
  const orders = await prisma.order.findMany({
    where: {
      organizationId,
      ...(opts.from || opts.to
        ? { placedAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
        : {}),
    },
    select: {
      id: true,
      placedAt: true,
      lineItems: { select: { id: true, sku: true, quantity: true, cogsAmount: true } },
    },
  });

  const allSkus = orders.flatMap((o) => o.lineItems.map((li) => li.sku).filter((s): s is string => !!s));
  const resolve = await buildCostResolver(organizationId, allSkus);

  let stamped = 0;
  let uncosted = 0;
  const uncostedSkus = new Set<string>();
  const updates: { id: string; cogsAmount: bigint }[] = [];

  for (const order of orders) {
    for (const line of order.lineItems) {
      if (opts.onlyMissing && line.cogsAmount !== null) continue;
      const cost = resolve(line.sku, order.placedAt);
      if (!cost) {
        uncosted += 1;
        if (line.sku) uncostedSkus.add(line.sku);
        continue;
      }
      updates.push({ id: line.id, cogsAmount: cost.landedCost * BigInt(line.quantity) });
      stamped += 1;
    }
  }

  // Chunked so a large backfill doesn't build one enormous transaction.
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await prisma.$transaction(
      chunk.map((u) =>
        prisma.orderLineItem.update({ where: { id: u.id }, data: { cogsAmount: u.cogsAmount } })
      )
    );
  }

  return {
    ordersConsidered: orders.length,
    linesStamped: stamped,
    linesUncosted: uncosted,
    uncostedSkuCount: uncostedSkus.size,
    uncostedSkus: [...uncostedSkus].slice(0, 50),
  };
}

/**
 * Which SKUs are missing a cost, ranked by how much revenue they represent —
 * so a founder filling in costs starts with the ones that actually move the
 * margin rather than working alphabetically.
 */
export async function getCostCoverage(organizationId: string) {
  const lines = await prisma.orderLineItem.findMany({
    where: { order: { organizationId } },
    select: { sku: true, totalAmount: true, cogsAmount: true, quantity: true },
  });

  let costedLines = 0;
  let costedValue = 0n;
  let totalValue = 0n;
  const missing = new Map<string, { revenue: bigint; units: number; lines: number }>();

  for (const l of lines) {
    totalValue += l.totalAmount;
    if (l.cogsAmount !== null) {
      costedLines += 1;
      costedValue += l.totalAmount;
      continue;
    }
    const key = l.sku ?? "(no SKU)";
    const cur = missing.get(key) ?? { revenue: 0n, units: 0, lines: 0 };
    missing.set(key, {
      revenue: cur.revenue + l.totalAmount,
      units: cur.units + l.quantity,
      lines: cur.lines + 1,
    });
  }

  return {
    totalLines: lines.length,
    costedLines,
    // §53 makes the same point about reconciliation: VALUE coverage is the more
    // meaningful KPI than count coverage, because ten cheap SKUs missing a cost
    // matter far less than one bestseller missing one.
    lineCoveragePct: lines.length === 0 ? 0 : Math.round((costedLines / lines.length) * 1000) / 10,
    valueCoveragePct: totalValue === 0n ? 0 : Math.round((Number(costedValue) / Number(totalValue)) * 1000) / 10,
    // The SKU list itself is NOT returned here any more. It used to be a
    // top-100 slice, which meant 629 of this store's 729 uncosted SKUs were
    // unreachable; it now lives at GET /costs/skus, which is searchable and
    // paged. Keeping a duplicate here would be 8.8 KB of the 9 KB response that
    // nothing reads, and a second definition of the same list to keep in sync.
    // Counts only SKUs that can actually BE costed. Lines with no SKU at all
    // still drag on value coverage above, but there is no key to attach a cost
    // to, so including them here would make the card a countdown that can never
    // reach zero — and it would disagree with the /costs/skus table by one.
    missingSkuCount: [...missing.keys()].filter((k) => k !== "(no SKU)").length,
    uncostableLineCount: missing.get("(no SKU)")?.lines ?? 0,
  };
}
