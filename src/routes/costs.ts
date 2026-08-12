import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { landedCostOf, getCostCoverage, stampCogs } from "../modules/calc/cogs.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

export const costsRouter = Router();

// Product cost entry. This is the missing input that blocks contribution margin
// (§115 names it one of the three numbers that must be right), and there is no
// connector that can supply it for every merchant — Shopify's "Cost per item"
// is optional and frequently blank — so manual and bulk entry are first-class
// paths, not a fallback.

const costEntrySchema = z.object({
  sku: z.string().min(1).max(120),
  // §19 date-effective. Defaults to the epoch rather than today so that a
  // first-time upload costs the ENTIRE order history: defaulting to now would
  // leave every past order uncosted and contribution margin blank, which is
  // the opposite of what someone uploading a cost file expects.
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional(),
  purchaseCost: z.number().nonnegative(),
  inboundFreight: z.number().nonnegative().optional(),
  importDuty: z.number().nonnegative().optional(),
  otherCost: z.number().nonnegative().optional(),
  note: z.string().max(500).optional(),
});

const bulkSchema = z.object({
  costs: z.array(costEntrySchema).min(1).max(5000),
  source: z.enum(["MANUAL", "CSV_IMPORT", "ESTIMATED"]).optional(),
  // Whether to immediately re-stamp order lines. Default true — a founder who
  // just entered costs expects the margin to move, not to have to find a
  // separate "recalculate" button.
  restamp: z.boolean().optional(),
});

// Rupees in the API, paise in the database. The boundary conversion happens
// here and nowhere else — see modules/calc/money.ts on why no float ever
// reaches storage.
function toPaise(rupees: number): bigint {
  return BigInt(Math.round(rupees * 100));
}

const EPOCH = new Date("1970-01-01T00:00:00.000Z");

function stringParam(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

costsRouter.post("/bulk", ...requireAuth, async (req, res, next) => {
  let parsed: z.infer<typeof bulkSchema>;
  try {
    // Parsed inside try/next(err) rather than thrown from the async body —
    // on Express 4 a throw here would hang the request instead of returning
    // 400. See the explanation in lib/dateRange.ts.
    parsed = bulkSchema.parse(req.body);
  } catch (err) {
    next(err);
    return;
  }

  const organizationId = req.auth!.organizationId;
  const source = parsed.source ?? "MANUAL";

  const rows = parsed.costs.map((c) => {
    const purchaseCost = toPaise(c.purchaseCost);
    const inboundFreight = toPaise(c.inboundFreight ?? 0);
    const importDuty = toPaise(c.importDuty ?? 0);
    const otherCost = toPaise(c.otherCost ?? 0);
    return {
      organizationId,
      sku: c.sku,
      effectiveFrom: c.effectiveFrom ? new Date(`${c.effectiveFrom}T00:00:00.000Z`) : EPOCH,
      purchaseCost,
      inboundFreight,
      importDuty,
      otherCost,
      landedCost: landedCostOf({ purchaseCost, inboundFreight, importDuty, otherCost }),
      source,
      note: c.note ?? null,
      createdBy: req.auth!.userId,
    };
  });

  // Upsert on (org, sku, effectiveFrom) so re-uploading a corrected file
  // replaces rather than duplicates (§94 idempotency).
  for (const row of rows) {
    await prisma.productCost.upsert({
      where: {
        organizationId_sku_effectiveFrom: {
          organizationId: row.organizationId,
          sku: row.sku,
          effectiveFrom: row.effectiveFrom,
        },
      },
      create: row,
      update: {
        purchaseCost: row.purchaseCost,
        inboundFreight: row.inboundFreight,
        importDuty: row.importDuty,
        otherCost: row.otherCost,
        landedCost: row.landedCost,
        source: row.source,
        note: row.note,
      },
    });
  }

  const stamp = parsed.restamp === false ? null : await stampCogs(organizationId);

  res.json({
    saved: rows.length,
    source,
    stamped: stamp,
    coverage: await getCostCoverage(organizationId),
  });
});

// What's missing, worst-first by revenue — so filling costs in starts where it
// changes the margin most.
// The SKU work-queue behind the cost-entry table: searchable, filterable and
// paginated, all server-side.
//
// This used to be `coverage.missingSkus`, which was a hard `.slice(0, 100)` of
// an in-memory aggregation over every order line. On this store that exposed
// 100 of 729 uncosted SKUs and there was no way to reach the other 629 at all —
// so search here isn't a convenience, it's the only route to most of the
// catalogue.
//
// The aggregation is now a GROUP BY, so the search filter is applied by
// Postgres before any rows come back rather than by loading 26,726 line items
// into memory and filtering them in JS.
//
//   ?search=<substring>   — matches SKU *or* product name, case-insensitive
//   ?status=missing|costed|all   (default missing)
//   ?limit=<1..500>       — default 100
//   ?offset=<n>
//
// Offset rather than a keyset cursor, deliberately: rows are ranked by a
// computed revenue sum, so there is no stable column to anchor a cursor to, and
// this is a bounded work queue someone is typing into — not an endless feed.
costsRouter.get("/skus", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const search = stringParam(req.query.search);
  const statusParam = stringParam(req.query.status) ?? "missing";
  const status = statusParam === "costed" || statusParam === "all" ? statusParam : "missing";

  const rawLimit = Number.parseInt(stringParam(req.query.limit) ?? "", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;
  const rawOffset = Number.parseInt(stringParam(req.query.offset) ?? "", 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  // A SKU counts as costed only when EVERY one of its lines carries a stamped
  // cost. Partially-stamped means some orders predate the cost row, and showing
  // it as done would leave those orders silently out of the margin.
  const havingByStatus = {
    missing: Prisma.sql`HAVING count(li."cogsAmount") < count(*)`,
    costed: Prisma.sql`HAVING count(li."cogsAmount") = count(*)`,
    all: Prisma.empty,
  } as const;

  const searchClause = search
    ? Prisma.sql`AND (li.sku ILIKE ${`%${search}%`} OR li."productName" ILIKE ${`%${search}%`})`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    {
      sku: string;
      product_name: string;
      revenue: bigint;
      units: number;
      lines: number;
      costed_lines: number;
    }[]
  >(Prisma.sql`
    SELECT li.sku,
           min(li."productName") AS product_name,
           sum(li."totalAmount")::bigint AS revenue,
           sum(li.quantity)::int AS units,
           count(*)::int AS lines,
           count(li."cogsAmount")::int AS costed_lines
    FROM order_line_items li
    JOIN orders o ON o.id = li."orderId"
    WHERE o."organizationId" = ${organizationId}
      AND li.sku IS NOT NULL
      ${searchClause}
    GROUP BY li.sku
    ${havingByStatus[status]}
    ORDER BY sum(li."totalAmount") DESC, li.sku ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const totalRows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*) AS count FROM (
      SELECT li.sku
      FROM order_line_items li
      JOIN orders o ON o.id = li."orderId"
      WHERE o."organizationId" = ${organizationId}
        AND li.sku IS NOT NULL
        ${searchClause}
      GROUP BY li.sku
      ${havingByStatus[status]}
    ) t
  `);
  const total = Number(totalRows[0]?.count ?? 0n);

  // The cost already on file, so an existing entry can be found and corrected
  // rather than only ever added — the whole reason `status=costed` exists.
  const existing = rows.length
    ? await prisma.productCost.findMany({
        where: { organizationId, sku: { in: rows.map((r) => r.sku) } },
        orderBy: { effectiveFrom: "desc" },
        select: { sku: true, landedCost: true, effectiveFrom: true, source: true },
      })
    : [];
  const latestBySku = new Map<string, (typeof existing)[number]>();
  for (const c of existing) if (!latestBySku.has(c.sku)) latestBySku.set(c.sku, c);

  res.json({
    skus: rows.map((r) => {
      const cost = latestBySku.get(r.sku);
      return {
        sku: r.sku,
        productName: r.product_name,
        revenue: Number(r.revenue) / 100,
        units: r.units,
        lines: r.lines,
        costedLines: r.costed_lines,
        costed: r.costed_lines === r.lines,
        landedCost: cost ? Number(cost.landedCost) / 100 : null,
        effectiveFrom: cost?.effectiveFrom.toISOString().slice(0, 10) ?? null,
        costSource: cost?.source ?? null,
      };
    }),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
    status,
  });
});

costsRouter.get("/coverage", ...requireAuth, async (req, res) => {
  res.json(await getCostCoverage(req.auth!.organizationId));
});

costsRouter.get("/", ...requireAuth, async (req, res) => {
  const costs = await prisma.productCost.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: [{ sku: "asc" }, { effectiveFrom: "desc" }],
    take: 1000,
  });
  res.json({
    costs: costs.map((c) => ({
      id: c.id,
      sku: c.sku,
      effectiveFrom: c.effectiveFrom.toISOString().slice(0, 10),
      purchaseCost: Number(c.purchaseCost) / 100,
      inboundFreight: Number(c.inboundFreight) / 100,
      importDuty: Number(c.importDuty) / 100,
      otherCost: Number(c.otherCost) / 100,
      landedCost: Number(c.landedCost) / 100,
      currency: c.currency,
      source: c.source,
      note: c.note,
    })),
  });
});

// Re-stamp without changing any cost — for after a bulk sync, or to pick up
// orders that arrived before their SKU had a cost.
costsRouter.post("/restamp", ...requireAuth, async (req, res) => {
  const result = await stampCogs(req.auth!.organizationId);
  res.json({ stamped: result, coverage: await getCostCoverage(req.auth!.organizationId) });
});
