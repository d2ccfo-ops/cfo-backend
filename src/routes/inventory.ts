import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { getVariantCoverInfo, type InventoryCoverStatus } from "../modules/calc/inventory.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

export const inventoryRouter = Router();

// Rollup priority when a product's variants disagree on status — most
// urgent wins, so a product with one healthy variant and one about to run
// out still surfaces as "stockout_risk" rather than being averaged away.
const STATUS_PRIORITY: InventoryCoverStatus[] = ["stockout_risk", "out_of_stock", "slow_moving", "unknown", "healthy"];
const VALID_COVER_STATUSES = new Set<string>(STATUS_PRIORITY);

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

function rollupStatus(statuses: InventoryCoverStatus[]): InventoryCoverStatus {
  for (const s of STATUS_PRIORITY) {
    if (statuses.includes(s)) return s;
  }
  return "healthy";
}

function stringParam(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

// Keyset (not offset) pagination. Offset would re-scan and skip N rows on every
// page, getting slower the further you scroll, and — worse for an infinite
// list — a sync landing mid-scroll shifts every subsequent page, so rows get
// silently duplicated or skipped. A cursor anchored to the last row you saw is
// stable under concurrent writes.
//
// The key is (title, id), not id alone: titles are not unique, so ordering by
// title needs a tiebreaker or the boundary between two identically-titled
// products is undefined.
interface Cursor {
  title: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

// Opaque to the client and never trusted: a malformed or hand-edited cursor
// falls back to the first page rather than 500ing.
function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.title !== "string" || typeof parsed?.id !== "string") return null;
    return { title: parsed.title, id: parsed.id };
  } catch {
    return null;
  }
}

// Product+variant listing for the Inventory table — paginated, and filtered
// ENTIRELY server-side:
//   ?search=<substring>       — case-insensitive product title match
//   ?productType=<exact>      — Product.productType (freeform, Shopify-defined)
//   ?shopifyStatus=<exact>    — Shopify's own active/draft/archived, NOT the
//                                computed cover status below
//   ?status=<cover status>    — stockout_risk|out_of_stock|slow_moving|unknown|healthy
//   ?limit=<1..200>           — defaults to 100
//   ?cursor=<opaque>          — from the previous response's nextCursor
//
// Filters are applied BEFORE the page is cut, so infinite scroll walks only the
// matching rows: filtering client-side would mean shipping the whole catalogue
// and then hiding most of it, which is exactly the bandwidth this endpoint
// exists to avoid.
//
// Note what is deliberately NOT selected: Product.raw and ProductVariant.raw,
// the stored Shopify payloads. They accounted for 5.6 MB of a 6.12 MB response
// on this store's 1,601 products and nothing on the page reads them.
inventoryRouter.get("/", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;

  const search = stringParam(req.query.search);
  const productType = stringParam(req.query.productType);
  const shopifyStatus = stringParam(req.query.shopifyStatus);
  const coverStatusParam = stringParam(req.query.status);
  const coverStatus = coverStatusParam && VALID_COVER_STATUSES.has(coverStatusParam) ? coverStatusParam : undefined;

  const rawLimit = Number.parseInt(stringParam(req.query.limit) ?? "", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const cursor = decodeCursor(stringParam(req.query.cursor));

  const where: Prisma.ProductWhereInput = { organizationId };
  if (search) where.title = { contains: search, mode: "insensitive" };
  if (productType) where.productType = productType;
  if (shopifyStatus) where.status = shopifyStatus;

  // Cover status is a computed rollup, not a stored column, so it can't go
  // straight into the `where`. It still has to be resolved BEFORE paging or the
  // page size would be wrong — filtering after the cut would return "up to 100"
  // rows and break the cursor. So the org's cover info (which is computed
  // org-wide regardless, see below) is turned into the set of matching product
  // ids and pushed into the query.
  const coverInfo = await getVariantCoverInfo(organizationId);
  const coverByProductId = new Map<string, typeof coverInfo>();
  for (const info of coverInfo) {
    const list = coverByProductId.get(info.productId) ?? [];
    list.push(info);
    coverByProductId.set(info.productId, list);
  }
  const statusByProductId = new Map<string, InventoryCoverStatus>();
  for (const [productId, infos] of coverByProductId) {
    statusByProductId.set(productId, rollupStatus(infos.map((c) => c.status)));
  }

  if (coverStatus) {
    const matching: string[] = [];
    for (const [productId, status] of statusByProductId) {
      if (status === coverStatus) matching.push(productId);
    }
    where.id = { in: matching };
  }

  // The cursor clause is the keyset comparison spelled out: everything strictly
  // after (title, id) in the sort order.
  const pageWhere: Prisma.ProductWhereInput = cursor
    ? {
        AND: [
          where,
          {
            OR: [
              { title: { gt: cursor.title } },
              { AND: [{ title: cursor.title }, { id: { gt: cursor.id } }] },
            ],
          },
        ],
      }
    : where;

  const [products, total, productTypeRows] = await Promise.all([
    prisma.product.findMany({
      where: pageWhere,
      // One extra row, purely to learn whether another page exists without a
      // second query. It is sliced off before responding.
      take: limit + 1,
      orderBy: [{ title: "asc" }, { id: "asc" }],
      select: {
        id: true,
        title: true,
        productType: true,
        vendor: true,
        status: true,
        externalProductId: true,
        variants: {
          select: { id: true, sku: true, title: true, price: true, inventoryQuantity: true },
        },
      },
    }),
    prisma.product.count({ where }),
    // Powers the "Product type" dropdown. Only sent on the first page — the
    // client already has it by the time it asks for page two, and re-running a
    // DISTINCT scan on every infinite-scroll tick is exactly the waste this
    // endpoint is being reshaped to avoid.
    cursor
      ? Promise.resolve(null)
      : prisma.product.findMany({
          where: { organizationId, productType: { not: null } },
          distinct: ["productType"],
          select: { productType: true },
          orderBy: { productType: "asc" },
        }),
  ]);

  const hasMore = products.length > limit;
  const page = hasMore ? products.slice(0, limit) : products;

  const rows = page.map((p) => {
    const cover = coverByProductId.get(p.id) ?? [];
    const coverableDays = cover.map((c) => c.daysOfCover).filter((d): d is number => d !== null);
    // `p.status` is Shopify's own raw product status (active/draft/archived) —
    // renamed to shopifyStatus so it survives instead of being clobbered by the
    // computed cover `status` below.
    const { status: shopifyProductStatus, ...rest } = p;
    return {
      ...rest,
      shopifyStatus: shopifyProductStatus,
      variants: p.variants.map((v) => ({ ...v, price: v.price.toString() })),
      daysOfCover: coverableDays.length > 0 ? Math.min(...coverableDays) : null,
      unitsSoldTrailing30d: cover.reduce((sum, c) => sum + c.unitsSoldTrailing, 0),
      status: statusByProductId.get(p.id) ?? "healthy",
    };
  });

  const last = page[page.length - 1];
  res.json({
    products: rows,
    // Total MATCHING the active filters, so the UI can say "100 of 412" rather
    // than implying the catalogue is only as big as what has loaded so far.
    total,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ title: last.title, id: last.id }) : null,
    ...(productTypeRows
      ? {
          filters: {
            productTypes: productTypeRows.map((r) => r.productType).filter((t): t is string => t !== null),
            coverStatuses: STATUS_PRIORITY,
          },
        }
      : {}),
  });
});
