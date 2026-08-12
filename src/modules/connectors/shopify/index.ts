import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { env } from "../../../config/env.js";
import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";
// Prepaid-vs-COD classification lives in ./gateways.ts — shipments.ts needs
// the same definition for the COD collectible, without a circular import.
import { classifyPaymentMode } from "./gateways.js";
import { syncShipmentsFromStoredOrders } from "./shipments.js";
import { pullOrderTransactions } from "./transactions.js";

const API_VERSION = "2024-10";
const MAX_PAGES_PER_RUN = 200; // safety cap: 250 orders/page * 200 = 50k orders per backfill/sync call

function toPaise(amount: string | number | null | undefined): bigint {
  return BigInt(Math.round(parseFloat(String(amount ?? "0")) * 100));
}

interface ShopifyDiscountAllocation {
  amount?: string;
}

interface ShopifyTaxLine {
  price?: string;
  rate?: number;
}

interface ShopifyLineItem {
  id?: number | string;
  sku?: string | null;
  title?: string;
  quantity?: number;
  price?: string;
  // Shopify states the discount and tax for each line outright. Allocating them
  // from the order total instead would be estimating something already known.
  discount_allocations?: ShopifyDiscountAllocation[];
  tax_lines?: ShopifyTaxLine[];
}

interface ShopifyMoneySet {
  shop_money?: { amount?: string; currency_code?: string };
}

interface ShopifyRefundTransaction {
  kind?: string;
  status?: string;
  amount?: string;
}

interface ShopifyRefundLineItem {
  line_item_id?: number | string;
  quantity?: number;
  // Tax-INCLUSIVE for a taxes_included store: verified against this store's
  // data, where subtotal equals the refund transaction amount exactly and
  // total_tax is the GST contained within it, not added to it.
  subtotal?: string;
  total_tax?: string;
}

interface ShopifyRefund {
  transactions?: ShopifyRefundTransaction[];
  refund_line_items?: ShopifyRefundLineItem[];
}

interface ShopifyOrder {
  id: number | string;
  name?: string;
  order_number?: number;
  financial_status?: string;
  fulfillment_status?: string | null;
  currency?: string;
  total_price?: string;
  total_discounts?: string;
  total_tax?: string;
  total_line_items_price?: string;
  total_shipping_price_set?: ShopifyMoneySet;
  cancelled_at?: string | null;
  payment_gateway_names?: string[];
  customer?: { id?: number | string | null } | null;
  refunds?: ShopifyRefund[];
  created_at: string;
  line_items?: ShopifyLineItem[];
}

// §13/§14: a refund is a FINANCIAL event. Shopify's refunds[] also carries
// "void" transactions, which cancel an uncaptured authorisation (overwhelmingly
// COD orders here) and move no money at all — the sample in this store's data
// is a void of ₹0.00. Counting those as refunds would inflate the refund rate
// with orders that were never paid for in the first place. Only successful
// transactions of kind "refund" are real money going back to a customer.
function refundedTotal(refunds: ShopifyRefund[] | undefined): bigint {
  if (!refunds) return 0n;
  let total = 0n;
  for (const refund of refunds) {
    for (const txn of refund.transactions ?? []) {
      if (txn.kind !== "refund") continue;
      if (txn.status && txn.status !== "success") continue;
      total += toPaise(txn.amount);
    }
  }
  return total;
}

interface LineRefund {
  amount: bigint; // tax-inclusive
  tax: bigint;
  quantity: number;
}

// Per-line refunds for §40, under the same rule refundedTotal uses: only
// refunds whose transactions actually moved money.
//
// This distinction is not academic here. 1,981 orders in this store carry
// refund records with NO successful refund transaction — voids and restocks
// worth ₹45,778 of line value. Attributing those to SKUs would quietly cut a
// product's revenue for sales that were never refunded, and the biggest of them
// land on high-value gemstone SKUs where one bogus deduction visibly moves the
// ranking.
function refundsByLineId(order: ShopifyOrder): Map<string, LineRefund> {
  const byLineId = new Map<string, LineRefund>();
  for (const refund of order.refunds ?? []) {
    const movedMoney = (refund.transactions ?? []).some(
      (t) => t.kind === "refund" && (!t.status || t.status === "success") && toPaise(t.amount) > 0n
    );
    if (!movedMoney) continue;
    for (const rli of refund.refund_line_items ?? []) {
      if (rli.line_item_id == null) continue;
      const key = String(rli.line_item_id);
      const cur = byLineId.get(key) ?? { amount: 0n, tax: 0n, quantity: 0 };
      cur.amount += toPaise(rli.subtotal);
      cur.tax += toPaise(rli.total_tax);
      cur.quantity += rli.quantity ?? 0;
      byLineId.set(key, cur);
    }
  }

  // A refund's line items can add up to more than the money that actually left
  // the account — 20 orders here, ₹55,309 — when the merchant itemises a return
  // but refunds less than its full value (a discrepancy adjustment, or partial
  // store credit). Scale down so a line can never claim more refund than the
  // order really paid back; the order total is the money that moved and is the
  // authority.
  const attributed = [...byLineId.values()].reduce((a, r) => a + r.amount, 0n);
  const actual = refundedTotal(order.refunds);
  if (attributed > actual && attributed > 0n) {
    for (const [key, r] of byLineId) {
      byLineId.set(key, {
        amount: (r.amount * actual) / attributed,
        tax: (r.tax * actual) / attributed,
        quantity: r.quantity,
      });
    }
  }
  return byLineId;
}

// Exposed for scripts/backfillLineItemFinancials.ts so a backfilled row and a
// freshly-synced one can't drift apart — there is exactly one implementation of
// what a line's discount, tax and refund mean.
export function mapOrderFinancialsForBackfill(raw: unknown) {
  return mapOrder(raw as ShopifyOrder).lineItems;
}

function mapOrder(order: ShopifyOrder) {
  const lineRefunds = refundsByLineId(order);
  return {
    externalOrderId: String(order.id),
    orderNumber: order.name ?? `#${order.order_number ?? order.id}`,
    channel: "shopify",
    status: order.financial_status ?? order.fulfillment_status ?? "unknown",
    currency: order.currency ?? "INR",
    // total_price — what the customer pays. Already net of discounts and
    // (with taxes_included) inclusive of tax. See the schema comment on
    // Order.grossAmount; the name predates the finance-engine spec.
    grossAmount: toPaise(order.total_price),
    discountAmount: toPaise(order.total_discounts),
    taxAmount: toPaise(order.total_tax),
    // §5 GMV: line-item value before discounts.
    itemsAmount: toPaise(order.total_line_items_price),
    // §6/§7 shipping charged to the customer (revenue, not logistics cost).
    shippingAmount: toPaise(order.total_shipping_price_set?.shop_money?.amount),
    refundedAmount: refundedTotal(order.refunds),
    cancelledAt: order.cancelled_at ? new Date(order.cancelled_at) : null,
    paymentMode: classifyPaymentMode(order.payment_gateway_names),
    customerRef: order.customer?.id != null ? String(order.customer.id) : null,
    placedAt: new Date(order.created_at),
    lineItems: (order.line_items ?? []).map((li) => {
      const refund = li.id != null ? lineRefunds.get(String(li.id)) : undefined;
      return {
        sku: li.sku || null,
        productName: li.title ?? "Unknown product",
        quantity: li.quantity ?? 0,
        unitPrice: toPaise(li.price),
        totalAmount: toPaise(li.price) * BigInt(li.quantity ?? 0),
        // Shopify's own per-line figures rather than a share of the order
        // total. discount_allocations covers both line-level and order-level
        // discounts (Shopify spreads the latter itself), and tax_lines carries
        // the line's actual GST — which matters the moment two products in one
        // order sit at different rates, where a pro-rata split is simply wrong.
        discountAmount: (li.discount_allocations ?? []).reduce((a, d) => a + toPaise(d.amount), 0n),
        taxAmount: (li.tax_lines ?? []).reduce((a, t) => a + toPaise(t.price), 0n),
        refundedAmount: refund?.amount ?? 0n,
        refundedTaxAmount: refund?.tax ?? 0n,
        refundedQuantity: refund?.quantity ?? 0,
      };
    }),
  };
}

interface ShopifyVariant {
  id: number | string;
  sku?: string | null;
  title?: string;
  price?: string;
  // Total across every location Shopify's REST Admin API still returns this
  // aggregated field for — this MVP doesn't model per-location inventory
  // (see modules/calc/inventory.ts).
  inventory_quantity?: number;
}

interface ShopifyProduct {
  id: number | string;
  title: string;
  product_type?: string;
  vendor?: string;
  status?: string;
  variants?: ShopifyVariant[];
}

function mapProduct(product: ShopifyProduct) {
  return {
    externalProductId: String(product.id),
    title: product.title,
    productType: product.product_type || null,
    vendor: product.vendor || null,
    status: product.status ?? "active",
    variants: (product.variants ?? []).map((v) => ({
      externalVariantId: String(v.id),
      sku: v.sku || null,
      title: v.title ?? "Default",
      price: toPaise(v.price),
      inventoryQuantity: v.inventory_quantity ?? 0,
    })),
  };
}

function parseNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const nextLink = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  if (!nextLink) return null;
  const match = nextLink.match(/<([^>]+)>/);
  if (!match?.[1]) return null;
  return new URL(match[1]).searchParams.get("page_info");
}

async function fetchOrdersPage(
  shop: string,
  accessToken: string,
  pageInfo: string | null,
  updatedAtMin: string | null
): Promise<{ orders: ShopifyOrder[]; nextPageInfo: string | null }> {
  const url = new URL(`https://${shop}/admin/api/${API_VERSION}/orders.json`);
  url.searchParams.set("limit", "250");
  if (pageInfo) {
    // Per Shopify's cursor pagination rules, page_info replaces all other
    // filters — status/updated_at_min must NOT be set alongside it, or
    // Shopify rejects the request outright with a 400. This used to set
    // `status=any` unconditionally above; real-world discovery (first store
    // with more than one page of orders) surfaced Shopify's actual error:
    // "status cannot be passed when page_info is present."
    url.searchParams.set("page_info", pageInfo);
  } else {
    url.searchParams.set("status", "any");
    if (updatedAtMin) url.searchParams.set("updated_at_min", updatedAtMin);
  }

  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
  if (!res.ok) {
    throw new Error(`Shopify orders fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { orders: ShopifyOrder[] };
  return { orders: data.orders, nextPageInfo: parseNextPageInfo(res.headers.get("link")) };
}

// Generic across orders/products pages — a RawEvent row per record, bulk
// upserted in one round trip instead of one `prisma.rawEvent.upsert()` per
// record. This (and batchUpsertOrders/batchUpsertProducts below) is what
// actually fixes the real throughput problem found live: the old per-record
// loop did up to 4 sequential DB round trips *per record* (RawEvent upsert,
// Order/Product upsert, line-item delete, line-item insert) — measured at
// ~58 records/sec against a real 26k-record store. Batching a full page
// (250 records) into a handful of multi-row statements turns "4 round trips
// × 250 records" into "4 round trips × 1 page." `processEvent` below is left
// completely untouched — it's still the single-record path webhooks use
// (routes/webhooks/shopify.ts), where records genuinely arrive one at a
// time and batching wouldn't apply.
interface RawEventInput {
  externalEventId: string;
  eventType: string;
  payload: unknown;
}

async function batchUpsertRawEvents(tx: Prisma.TransactionClient, ctx: ConnectorContext, events: RawEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const now = new Date();
  const rows = events.map(
    (e) =>
      Prisma.sql`(${crypto.randomUUID()}, ${ctx.organizationId}, ${ctx.connectionId}, 'SHOPIFY'::"Provider", ${e.externalEventId}, ${e.eventType}, ${JSON.stringify(e.payload)}::jsonb, ${now}, ${now}, 'PROCESSED'::"ProcessingStatus")`
  );
  await tx.$executeRaw`
    INSERT INTO raw_events (id, "organizationId", "connectionId", provider, "externalEventId", "eventType", payload, "receivedAt", "processedAt", "processingStatus")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("connectionId", "externalEventId") DO UPDATE SET
      payload = EXCLUDED.payload,
      "processedAt" = EXCLUDED."processedAt",
      "processingStatus" = EXCLUDED."processingStatus"
  `;
}

// One page's worth of orders, in a single transaction: bulk upsert RawEvent
// + Order (RETURNING the real row id, since ON CONFLICT means some of these
// are updates reusing an existing id, not always a fresh insert), then bulk
// delete + bulk recreate OrderLineItems for exactly those orders — same
// wholesale-replace idempotency approach the old per-record path used, just
// batched. Wrapped in a transaction so a mid-page failure can't leave a page
// half-written (a real improvement over the old code, which had no such
// guarantee either, just less surface for it to matter).
async function batchUpsertOrders(ctx: ConnectorContext, orders: ShopifyOrder[]): Promise<void> {
  if (orders.length === 0) return;
  const mapped = orders.map((raw) => ({ raw, m: mapOrder(raw) }));
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await batchUpsertRawEvents(
      tx,
      ctx,
      mapped.map(({ raw }) => ({ externalEventId: `order_${raw.id}`, eventType: "orders/sync", payload: raw }))
    );

    const orderRows = mapped.map(
      ({ raw, m }) =>
        Prisma.sql`(${crypto.randomUUID()}, ${ctx.organizationId}, ${ctx.legalEntityId}, ${ctx.connectionId}, ${m.externalOrderId}, ${m.orderNumber}, ${m.channel}, ${m.status}, ${m.currency}, ${m.grossAmount}, ${m.discountAmount}, ${m.taxAmount}, ${m.itemsAmount}, ${m.shippingAmount}, ${m.refundedAmount}, ${m.cancelledAt}, ${m.paymentMode}, ${m.customerRef}, ${m.placedAt}, ${JSON.stringify(raw)}::jsonb, ${now}, ${now})`
    );
    const upserted = await tx.$queryRaw<{ id: string; externalOrderId: string }[]>`
      INSERT INTO orders (id, "organizationId", "legalEntityId", "connectionId", "externalOrderId", "orderNumber", channel, status, currency, "grossAmount", "discountAmount", "taxAmount", "itemsAmount", "shippingAmount", "refundedAmount", "cancelledAt", "paymentMode", "customerRef", "placedAt", raw, "createdAt", "updatedAt")
      VALUES ${Prisma.join(orderRows)}
      ON CONFLICT ("connectionId", "externalOrderId") DO UPDATE SET
        status = EXCLUDED.status,
        "grossAmount" = EXCLUDED."grossAmount",
        "discountAmount" = EXCLUDED."discountAmount",
        "taxAmount" = EXCLUDED."taxAmount",
        "itemsAmount" = EXCLUDED."itemsAmount",
        "shippingAmount" = EXCLUDED."shippingAmount",
        "refundedAmount" = EXCLUDED."refundedAmount",
        "cancelledAt" = EXCLUDED."cancelledAt",
        "paymentMode" = EXCLUDED."paymentMode",
        "customerRef" = EXCLUDED."customerRef",
        raw = EXCLUDED.raw,
        "updatedAt" = EXCLUDED."updatedAt"
      RETURNING id, "externalOrderId"
    `;

    const orderIdByExternalId = new Map(upserted.map((r) => [r.externalOrderId, r.id]));
    await tx.orderLineItem.deleteMany({ where: { orderId: { in: upserted.map((r) => r.id) } } });

    const lineItemRows = mapped.flatMap(({ m }) => {
      const orderId = orderIdByExternalId.get(m.externalOrderId);
      if (!orderId) return [];
      return m.lineItems.map(
        (li) => Prisma.sql`(${crypto.randomUUID()}, ${orderId}, ${li.sku}, ${li.productName}, ${li.quantity}, ${li.unitPrice}, ${li.totalAmount}, ${li.discountAmount}, ${li.taxAmount}, ${li.refundedAmount}, ${li.refundedTaxAmount}, ${li.refundedQuantity})`
      );
    });
    if (lineItemRows.length > 0) {
      await tx.$executeRaw`
        INSERT INTO order_line_items (id, "orderId", sku, "productName", quantity, "unitPrice", "totalAmount", "discountAmount", "taxAmount", "refundedAmount", "refundedTaxAmount", "refundedQuantity")
        VALUES ${Prisma.join(lineItemRows)}
      `;
    }
  });
}

async function pullOrders(
  ctx: ConnectorContext,
  updatedAtMin: string | null,
  onPage: (fetchedSoFarInThisResource: number) => void
): Promise<number> {
  if (!ctx.externalAccountId) throw new Error("Shopify connector requires a shop domain (externalAccountId)");
  const accessToken = decryptSecret(ctx.credentialsRef);
  const shop = ctx.externalAccountId;

  let pageInfo: string | null = null;
  let recordsFetched = 0;
  let pages = 0;

  do {
    const { orders, nextPageInfo } = await fetchOrdersPage(shop, accessToken, pageInfo, pageInfo ? null : updatedAtMin);
    // Dev/testing cap only — see env.ts's SHOPIFY_BACKFILL_MAX_RECORDS. Sliced
    // before batching (not checked per-record anymore) so the cap is still
    // respected exactly, not just "roughly, rounded up to the next page."
    const toProcess = env.SHOPIFY_BACKFILL_MAX_RECORDS
      ? orders.slice(0, Math.max(0, env.SHOPIFY_BACKFILL_MAX_RECORDS - recordsFetched))
      : orders;
    await batchUpsertOrders(ctx, toProcess);
    recordsFetched += toProcess.length;
    if (env.SHOPIFY_BACKFILL_MAX_RECORDS && recordsFetched >= env.SHOPIFY_BACKFILL_MAX_RECORDS) return recordsFetched;

    pageInfo = nextPageInfo;
    pages++;
    // Reported once per page (~every 250 records), not per record — a
    // progress update on every single row would just recreate the
    // resource-exhaustion problem the whole sync queue exists to avoid
    // (see cfo-docs/PROGRESS.md's "Background sync queue" section).
    onPage(recordsFetched);
  } while (pageInfo && pages < MAX_PAGES_PER_RUN);

  return recordsFetched;
}

async function fetchProductsPage(
  shop: string,
  accessToken: string,
  pageInfo: string | null,
  updatedAtMin: string | null
): Promise<{ products: ShopifyProduct[]; nextPageInfo: string | null }> {
  const url = new URL(`https://${shop}/admin/api/${API_VERSION}/products.json`);
  url.searchParams.set("limit", "250");
  if (pageInfo) {
    url.searchParams.set("page_info", pageInfo);
  } else if (updatedAtMin) {
    url.searchParams.set("updated_at_min", updatedAtMin);
  }

  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
  if (!res.ok) {
    throw new Error(`Shopify products fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { products: ShopifyProduct[] };
  return { products: data.products, nextPageInfo: parseNextPageInfo(res.headers.get("link")) };
}

// Same shape/reasoning as batchUpsertOrders above — one page, one
// transaction: bulk upsert RawEvent + Product (RETURNING id), bulk delete +
// bulk recreate ProductVariants for exactly those products.
async function batchUpsertProducts(ctx: ConnectorContext, products: ShopifyProduct[]): Promise<void> {
  if (products.length === 0) return;
  const mapped = products.map((raw) => ({ raw, m: mapProduct(raw) }));
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await batchUpsertRawEvents(
      tx,
      ctx,
      mapped.map(({ raw }) => ({ externalEventId: `product_${raw.id}`, eventType: "products/sync", payload: raw }))
    );

    const productRows = mapped.map(
      ({ raw, m }) =>
        Prisma.sql`(${crypto.randomUUID()}, ${ctx.organizationId}, ${ctx.legalEntityId}, ${ctx.connectionId}, ${m.externalProductId}, ${m.title}, ${m.productType}, ${m.vendor}, ${m.status}, ${JSON.stringify(raw)}::jsonb, ${now}, ${now})`
    );
    const upserted = await tx.$queryRaw<{ id: string; externalProductId: string }[]>`
      INSERT INTO products (id, "organizationId", "legalEntityId", "connectionId", "externalProductId", title, "productType", vendor, status, raw, "createdAt", "updatedAt")
      VALUES ${Prisma.join(productRows)}
      ON CONFLICT ("connectionId", "externalProductId") DO UPDATE SET
        title = EXCLUDED.title,
        "productType" = EXCLUDED."productType",
        vendor = EXCLUDED.vendor,
        status = EXCLUDED.status,
        raw = EXCLUDED.raw,
        "updatedAt" = EXCLUDED."updatedAt"
      RETURNING id, "externalProductId"
    `;

    const productIdByExternalId = new Map(upserted.map((r) => [r.externalProductId, r.id]));
    await tx.productVariant.deleteMany({ where: { productId: { in: upserted.map((r) => r.id) } } });

    const variantRows = mapped.flatMap(({ m }) => {
      const productId = productIdByExternalId.get(m.externalProductId);
      if (!productId) return [];
      return m.variants.map(
        (v) =>
          Prisma.sql`(${crypto.randomUUID()}, ${productId}, ${v.externalVariantId}, ${v.sku}, ${v.title}, ${v.price}, ${v.inventoryQuantity}, ${now})`
      );
    });
    if (variantRows.length > 0) {
      // Unlike orders/products/raw_events, product_variants has no DB-level
      // DEFAULT on "updatedAt" (only "createdAt" gets CURRENT_TIMESTAMP —
      // see the migration SQL) — Prisma's @updatedAt is purely a
      // client-side/query-engine behavior, so raw SQL has to supply it
      // explicitly or hit a NOT NULL violation. Caught by the small-scale
      // correctness test below before this ever touched the full dataset.
      await tx.$executeRaw`
        INSERT INTO product_variants (id, "productId", "externalVariantId", sku, title, price, "inventoryQuantity", "updatedAt")
        VALUES ${Prisma.join(variantRows)}
      `;
    }
  });
}

async function pullProducts(
  ctx: ConnectorContext,
  updatedAtMin: string | null,
  onPage: (fetchedSoFarInThisResource: number) => void
): Promise<number> {
  if (!ctx.externalAccountId) throw new Error("Shopify connector requires a shop domain (externalAccountId)");
  const accessToken = decryptSecret(ctx.credentialsRef);
  const shop = ctx.externalAccountId;

  let pageInfo: string | null = null;
  let recordsFetched = 0;
  let pages = 0;

  do {
    const { products, nextPageInfo } = await fetchProductsPage(shop, accessToken, pageInfo, pageInfo ? null : updatedAtMin);
    const toProcess = env.SHOPIFY_BACKFILL_MAX_RECORDS
      ? products.slice(0, Math.max(0, env.SHOPIFY_BACKFILL_MAX_RECORDS - recordsFetched))
      : products;
    await batchUpsertProducts(ctx, toProcess);
    recordsFetched += toProcess.length;
    if (env.SHOPIFY_BACKFILL_MAX_RECORDS && recordsFetched >= env.SHOPIFY_BACKFILL_MAX_RECORDS) return recordsFetched;

    pageInfo = nextPageInfo;
    pages++;
    onPage(recordsFetched);
  } while (pageInfo && pages < MAX_PAGES_PER_RUN);

  return recordsFetched;
}

// Shopify's count endpoints are cheap (a single request, no pagination) and
// give a real denominator for progress reporting — without this, "syncing"
// would just be a spinner with no way to say how much is left. Best-effort:
// a failed/unsupported count call just means no ETA for this run, not a
// reason to fail the whole sync (see the `.catch(() => null)` below).
async function fetchCount(shop: string, accessToken: string, resource: "orders" | "products", updatedAtMin: string | null): Promise<number | null> {
  const url = new URL(`https://${shop}/admin/api/${API_VERSION}/${resource}/count.json`);
  if (resource === "orders") url.searchParams.set("status", "any");
  if (updatedAtMin) url.searchParams.set("updated_at_min", updatedAtMin);
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
  if (!res.ok) return null;
  const data = (await res.json()) as { count: number };
  return typeof data.count === "number" ? data.count : null;
}

// Pulls both orders and products/inventory on every backfill/sync run —
// deliberately folded into the same SyncResult rather than a second
// Connector method, since the interface only has one backfill/sync pair per
// provider. `recordsFetched` is the sum of both; `cursor` is shared too
// (both `updated_at_min` filters use the same "now" timestamp) since
// there's no real cost to re-checking products slightly more often than
// strictly necessary, unlike orders where volume matters more.
async function pull(ctx: ConnectorContext, updatedAtMin: string | null): Promise<SyncResult> {
  if (!ctx.externalAccountId) throw new Error("Shopify connector requires a shop domain (externalAccountId)");
  const accessToken = decryptSecret(ctx.credentialsRef);
  const shop = ctx.externalAccountId;
  // Margin absorbs clock skew between this process and Postgres `now()` — the
  // shipments pass below selects orders by OUR updatedAt column.
  const runStart = new Date(Date.now() - 60_000);

  const [orderTotal, productTotal] = await Promise.all([
    fetchCount(shop, accessToken, "orders", updatedAtMin).catch(() => null),
    fetchCount(shop, accessToken, "products", updatedAtMin).catch(() => null),
  ]);
  // Null (not 0) whenever either count call failed — a real "we don't know"
  // that the UI should render as "Syncing…" with no ETA, not a false "0 of 0".
  const total = orderTotal !== null && productTotal !== null ? orderTotal + productTotal : null;
  await ctx.reportProgress?.(0, total);

  let doneSoFar = 0;
  const orderCount = await pullOrders(ctx, updatedAtMin, (ordersDone) => {
    doneSoFar = ordersDone;
    void ctx.reportProgress?.(doneSoFar, total);
  });
  const productCount = await pullProducts(ctx, updatedAtMin, (productsDone) => {
    void ctx.reportProgress?.(orderCount + productsDone, total);
  });

  // Order-level transactions → Payment rows (reconciliation's ORDER_PAYMENT
  // leg). Runs AFTER orders so every payment can carry its order FK, and
  // BEFORE shipments so a PPCOD order's collectible can subtract what was
  // already captured online. Not part of the progress total — count.json
  // can't predict a bulk export's size, and a bar that jumps past 100% is
  // worse than one that finishes slightly early.
  const transactions = await pullOrderTransactions(ctx, updatedAtMin);

  // Shipment rows from the fulfillments embedded in the orders just written.
  // Incremental runs only rescan orders this run touched; a full backfill
  // rescans everything (see shipments.ts on why this reads our DB, not the
  // API).
  const shipments = await syncShipmentsFromStoredOrders(ctx.connectionId, updatedAtMin ? runStart : null);

  return {
    recordsFetched: orderCount + productCount + transactions.paymentsUpserted + shipments.shipmentsUpserted,
    cursor: new Date().toISOString(),
  };
}

async function upsertProduct(ctx: ConnectorContext, payload: ShopifyProduct): Promise<void> {
  const mapped = mapProduct(payload);

  const product = await prisma.product.upsert({
    where: {
      connectionId_externalProductId: { connectionId: ctx.connectionId, externalProductId: mapped.externalProductId },
    },
    create: {
      organizationId: ctx.organizationId,
      legalEntityId: ctx.legalEntityId,
      connectionId: ctx.connectionId,
      externalProductId: mapped.externalProductId,
      title: mapped.title,
      productType: mapped.productType,
      vendor: mapped.vendor,
      status: mapped.status,
      raw: payload as object,
    },
    update: {
      title: mapped.title,
      productType: mapped.productType,
      vendor: mapped.vendor,
      status: mapped.status,
      raw: payload as object,
    },
  });

  // Same wholesale-replace approach as order line items — a variant
  // discontinued or added on Shopify's side is naturally reflected this
  // way (deleteMany then recreate) without needing to diff old vs. new.
  await prisma.productVariant.deleteMany({ where: { productId: product.id } });
  if (mapped.variants.length > 0) {
    await prisma.productVariant.createMany({
      data: mapped.variants.map((v) => ({ ...v, productId: product.id })),
    });
  }
}

export const shopifyConnector: Connector = {
  provider: "SHOPIFY",

  async backfill(ctx: ConnectorContext): Promise<SyncResult> {
    return pull(ctx, null);
  },

  async sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult> {
    return pull(ctx, sinceCursor);
  },

  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): WebhookVerificationResult {
    const hmac = headers["x-shopify-hmac-sha256"];
    const secret = env.SHOPIFY_WEBHOOK_SECRET ?? "";
    const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    const digestBuf = Buffer.from(digest);
    const hmacBuf = Buffer.from(hmac ?? "");
    const valid = Boolean(hmac) && digestBuf.length === hmacBuf.length && crypto.timingSafeEqual(digestBuf, hmacBuf);

    return {
      valid,
      externalEventId: headers["x-shopify-webhook-id"] ?? "",
      eventType: headers["x-shopify-topic"] ?? "unknown",
    };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, eventType: string): Promise<void> {
    if (eventType.startsWith("products/")) {
      await upsertProduct(ctx, payload as ShopifyProduct);
      return;
    }
    if (!eventType.startsWith("orders/")) return;
    const mapped = mapOrder(payload as ShopifyOrder);

    const order = await prisma.order.upsert({
      where: { connectionId_externalOrderId: { connectionId: ctx.connectionId, externalOrderId: mapped.externalOrderId } },
      create: {
        organizationId: ctx.organizationId,
        legalEntityId: ctx.legalEntityId,
        connectionId: ctx.connectionId,
        externalOrderId: mapped.externalOrderId,
        orderNumber: mapped.orderNumber,
        channel: mapped.channel,
        status: mapped.status,
        currency: mapped.currency,
        grossAmount: mapped.grossAmount,
        discountAmount: mapped.discountAmount,
        taxAmount: mapped.taxAmount,
        itemsAmount: mapped.itemsAmount,
        shippingAmount: mapped.shippingAmount,
        refundedAmount: mapped.refundedAmount,
        cancelledAt: mapped.cancelledAt,
        paymentMode: mapped.paymentMode,
        customerRef: mapped.customerRef,
        placedAt: mapped.placedAt,
        raw: payload as object,
      },
      // A refund or cancellation arrives as an orders/updated webhook on the
      // SAME order, so every one of these has to be in the update branch too —
      // leaving refundedAmount/cancelledAt out would mean an order could only
      // ever be refunded if the refund existed at first ingestion.
      update: {
        status: mapped.status,
        grossAmount: mapped.grossAmount,
        discountAmount: mapped.discountAmount,
        taxAmount: mapped.taxAmount,
        itemsAmount: mapped.itemsAmount,
        shippingAmount: mapped.shippingAmount,
        refundedAmount: mapped.refundedAmount,
        cancelledAt: mapped.cancelledAt,
        paymentMode: mapped.paymentMode,
        customerRef: mapped.customerRef,
        raw: payload as object,
      },
    });

    // Simplest correct approach for idempotency: replace line items wholesale
    // rather than diffing — order edit frequency doesn't justify the complexity.
    await prisma.orderLineItem.deleteMany({ where: { orderId: order.id } });
    if (mapped.lineItems.length > 0) {
      await prisma.orderLineItem.createMany({
        data: mapped.lineItems.map((li) => ({ ...li, orderId: order.id })),
      });
    }

    // Fulfillment changes (dispatched, delivered, RTO) arrive as
    // orders/updated on the same order, so its Shipment rows are refreshed
    // here too. The 2-minute window covers exactly the row just upserted —
    // same one-code-path rule as the sync (see shipments.ts). Payments are
    // NOT fetched per webhook: order webhook payloads don't carry
    // transactions, and the next scheduled sync's lookback window picks them
    // up (see transactions.ts).
    await syncShipmentsFromStoredOrders(ctx.connectionId, new Date(Date.now() - 2 * 60_000));
  },
};
