import { env } from "../../../config/env.js";
import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import { rupeesToPaise } from "../../calc/money.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";

// Amazon SP-API is OAuth like Shopify (platform app, browser redirect), with
// real differences worth knowing before touching this file:
//  - Auth used to require AWS SigV4 request signing on top of OAuth. Amazon
//    dropped that requirement in 2023 — this connector only does LWA OAuth
//    (a bearer access token from a refresh token), same shape as Google
//    Ads's getAccessToken(). No AWS credentials anywhere in this file.
//  - India is NOT its own SP-API region. It's served by the EU endpoint
//    (sellingpartnerapi-eu.amazon.com), alongside Europe/Middle East — a
//    real, easy-to-get-wrong assumption (confirmed against Amazon's SP-API
//    endpoints doc before writing this). Marketplace ID A21TJRUUN4KGV.
//  - Orders: built against the Orders API v2026-01-01 (searchOrders),
//    deliberately not the older v0 (getOrders/getOrderItems/
//    getOrderItemsBuyerInfo as three separate calls). v0 remains callable
//    until 27 Mar 2027 per Amazon's migration guide, but v2026-01-01 returns
//    order + line items in one call via `includedData`, which is both fewer
//    requests against SP-API's rate limits and less to keep in sync — the
//    same "build against the current version, not the legacy one" call made
//    for Google Ads (which was pinned to a version that had already sunset).
//  - Settlements/fees: the Finances API v2024-06-19's listTransactions,
//    matched back to an order via `relatedIdentifiers`. This is genuinely
//    the highest-value data this connector pulls — referral fees, FBA fees,
//    and payout timing are exactly what feeds contribution margin and
//    reconciliation, which plain order totals can't. Landed in `Payment`
//    (amount = net proceeds, feeAmount = fees withheld), not a new table.
//  - NOT yet verified against a real seller account — the exact field names
//    below (especially transaction `relatedIdentifiers`/`breakdowns` casing)
//    are best-effort from Amazon's documentation, which describes the shape
//    but was not confirmed against a live payload. The raw payload is always
//    stored (RawEvent.payload, Order.raw, Payment.raw), so nothing is lost
//    if a field needs correcting once this runs for real.

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const SP_API_BASE = "https://sellingpartnerapi-eu.amazon.com"; // EU region serves India
export const INDIA_MARKETPLACE_ID = "A21TJRUUN4KGV";
const ORDERS_API_VERSION = "2026-01-01";
const FINANCES_API_VERSION = "2024-06-19";
const MAX_PAGES_PER_RUN = 100;
const USER_AGENT = "CFOOS/1.0 (Language=TypeScript)"; // required header, per SP-API's connection guide

export interface AmazonCredentials {
  refreshToken: string;
  sellingPartnerId?: string;
}

export function encodeCredentials(creds: AmazonCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): AmazonCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as AmazonCredentials;
}

function requireAppConfig(): { clientId: string; clientSecret: string } {
  if (!env.AMAZON_LWA_CLIENT_ID || !env.AMAZON_LWA_CLIENT_SECRET) throw new Error("amazon_not_configured");
  return { clientId: env.AMAZON_LWA_CLIENT_ID, clientSecret: env.AMAZON_LWA_CLIENT_SECRET };
}

export function getAuthorizeUrl(state: string, redirectUri: string): string {
  if (!env.AMAZON_APP_ID) throw new Error("amazon_not_configured");
  // Website Authorization Workflow — the seller is redirected to their own
  // Seller Central, not a generic Amazon login, since the consent screen is
  // scoped to their marketplace. version=beta is required while the SP-API
  // app is in Draft status (the normal state before Amazon's app-review call).
  const url = new URL("https://sellercentral.amazon.in/apps/authorize/consent");
  url.searchParams.set("application_id", env.AMAZON_APP_ID);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  if (env.AMAZON_APP_DRAFT === "true") url.searchParams.set("version", "beta");
  return url.toString();
}

export async function exchangeCodeForRefreshToken(code: string): Promise<{ refreshToken: string; accessToken: string }> {
  const { clientId, clientSecret } = requireAppConfig();
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`amazon_token_exchange_failed_${res.status}_${await res.text()}`);
  const data = (await res.json()) as { refresh_token: string; access_token: string };
  return { refreshToken: data.refresh_token, accessToken: data.access_token };
}

// Exported separately, same reason as Google Ads's getAccessToken — every
// SP-API call needs a fresh ~1hr access token, fetched at call time rather
// than cached and persisted.
export async function getAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = requireAppConfig();
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`amazon_refresh_failed_${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function spApiHeaders(accessToken: string): Record<string, string> {
  return { "x-amz-access-token": accessToken, "user-agent": USER_AGENT, "content-type": "application/json" };
}

function toPaise(amount: string | number | null | undefined): bigint {
  return rupeesToPaise(parseFloat(String(amount ?? "0")) || 0);
}

// --- Orders (v2026-01-01) -------------------------------------------------

interface AmazonMoney {
  amount?: string;
  currencyCode?: string;
}

interface AmazonProceedsBreakdown {
  type?: "ITEM" | "SHIPPING" | "DISCOUNT" | "TAX" | string;
  subtotal?: AmazonMoney;
}

interface AmazonOrderItem {
  orderItemId?: string;
  product?: { asin?: string; sellerSku?: string; title?: string; price?: { unitPrice?: AmazonMoney } };
  quantityOrdered?: number;
  proceeds?: { breakdowns?: AmazonProceedsBreakdown[] };
}

interface AmazonOrder {
  orderId: string;
  createdTime: string;
  fulfillment?: { fulfillmentStatus?: string; fulfilledBy?: string };
  orderItems?: AmazonOrderItem[];
}

interface SearchOrdersResponse {
  orders?: AmazonOrder[];
  paginationToken?: string;
}

function sumBreakdown(items: AmazonOrderItem[], types: string[]): bigint {
  let total = 0n;
  for (const item of items) {
    for (const b of item.proceeds?.breakdowns ?? []) {
      if (b.type && types.includes(b.type)) total += toPaise(b.subtotal?.amount);
    }
  }
  return total;
}

function mapOrder(order: AmazonOrder) {
  const items = order.orderItems ?? [];
  const itemTotal = sumBreakdown(items, ["ITEM", "SHIPPING"]);
  const discountTotal = sumBreakdown(items, ["DISCOUNT"]);
  const taxTotal = sumBreakdown(items, ["TAX"]);
  return {
    externalOrderId: order.orderId,
    orderNumber: order.orderId,
    channel: "amazon",
    status: order.fulfillment?.fulfillmentStatus ?? "unknown",
    currency: "INR",
    // Gross is item+shipping+tax, matching what a buyer actually paid;
    // discountTotal is subtracted the same way Shopify's total_discounts is.
    grossAmount: itemTotal + taxTotal,
    discountAmount: discountTotal,
    taxAmount: taxTotal,
    placedAt: new Date(order.createdTime),
    lineItems: items.map((li) => {
      const qty = li.quantityOrdered ?? 0;
      const unitPrice = toPaise(li.product?.price?.unitPrice?.amount);
      return {
        sku: li.product?.sellerSku || null,
        productName: li.product?.title ?? "Unknown product",
        quantity: qty,
        unitPrice,
        totalAmount: unitPrice * BigInt(qty),
      };
    }),
  };
}

async function upsertOrder(ctx: ConnectorContext, order: AmazonOrder) {
  const mapped = mapOrder(order);
  const row = await prisma.order.upsert({
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
      placedAt: mapped.placedAt,
      raw: order as unknown as object,
    },
    update: {
      status: mapped.status,
      grossAmount: mapped.grossAmount,
      discountAmount: mapped.discountAmount,
      taxAmount: mapped.taxAmount,
      raw: order as unknown as object,
    },
  });

  // Same "replace wholesale, don't diff" idempotency pattern as Shopify's
  // upsertOrder — order-edit frequency doesn't justify diffing line items.
  await prisma.orderLineItem.deleteMany({ where: { orderId: row.id } });
  if (mapped.lineItems.length > 0) {
    await prisma.orderLineItem.createMany({
      data: mapped.lineItems.map((li) => ({ orderId: row.id, ...li })),
    });
  }
}

async function pullOrders(ctx: ConnectorContext, sinceIso: string | null): Promise<number> {
  const creds = decodeCredentials(ctx.credentialsRef);
  const accessToken = await getAccessToken(creds.refreshToken);

  let paginationToken: string | undefined;
  let pages = 0;
  let total = 0;

  do {
    const url = new URL(`${SP_API_BASE}/orders/${ORDERS_API_VERSION}/orders`);
    url.searchParams.set("marketplaceIds", INDIA_MARKETPLACE_ID);
    url.searchParams.set("includedData", "items");
    if (sinceIso) url.searchParams.set("createdAfter", sinceIso);
    if (paginationToken) url.searchParams.set("paginationToken", paginationToken);

    const res = await fetch(url, { headers: spApiHeaders(accessToken) });
    if (!res.ok) throw new Error(`amazon_search_orders_failed_${res.status}_${await res.text()}`);
    const data = (await res.json()) as SearchOrdersResponse;

    for (const order of data.orders ?? []) {
      const externalEventId = `order_${order.orderId}`;
      await prisma.rawEvent.upsert({
        where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
        create: {
          organizationId: ctx.organizationId,
          connectionId: ctx.connectionId,
          provider: "AMAZON",
          externalEventId,
          eventType: "order.sync",
          payload: order as unknown as object,
          processedAt: new Date(),
          processingStatus: "PROCESSED",
        },
        update: { payload: order as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
      });
      await upsertOrder(ctx, order);
      total++;
    }

    // paginationToken expires after 24h per Amazon's migration guide — fine
    // here since a single backfill/sync run completes well within that.
    paginationToken = data.paginationToken;
    pages++;
    ctx.reportProgress?.(total, null); // SP-API gives no cheap upfront count, same as most connectors here
  } while (paginationToken && pages < MAX_PAGES_PER_RUN);

  return total;
}

// --- Finances (v2024-06-19) — fees/settlement data, landed as Payment -----

interface AmazonTransactionRelatedIdentifier {
  relatedIdentifierName?: string; // e.g. "ORDER_ID"
  relatedIdentifierValue?: string;
}

interface AmazonTransactionBreakdown {
  breakdownType?: string;
  breakdownAmount?: AmazonMoney;
}

interface AmazonTransaction {
  transactionId?: string;
  transactionType?: string;
  transactionStatus?: string;
  postedDate?: string;
  totalAmount?: AmazonMoney;
  relatedIdentifiers?: AmazonTransactionRelatedIdentifier[];
  items?: { breakdowns?: AmazonTransactionBreakdown[] }[];
}

interface ListTransactionsResponse {
  payload?: { transactions?: AmazonTransaction[]; nextToken?: string };
}

// Fee-type breakdowns are negative deductions from the order total in
// Amazon's model — summed as a positive "fee withheld" figure for Payment.feeAmount,
// matching how Shopify/Razorpay's feeAmount is recorded (always positive).
const FEE_BREAKDOWN_TYPES = ["COMMISSION", "REFERRAL_FEE", "FBA_FEE", "FBA_FEES", "SELLING_FEE", "SHIPPING_FEE"];

function sumFees(txn: AmazonTransaction): bigint {
  let total = 0n;
  for (const item of txn.items ?? []) {
    for (const b of item.breakdowns ?? []) {
      if (b.breakdownType && FEE_BREAKDOWN_TYPES.some((t) => b.breakdownType?.toUpperCase().includes(t))) {
        total += toPaise(b.breakdownAmount?.amount);
      }
    }
  }
  return total;
}

function relatedOrderId(txn: AmazonTransaction): string | null {
  const rel = txn.relatedIdentifiers?.find((r) => r.relatedIdentifierName === "ORDER_ID");
  return rel?.relatedIdentifierValue ?? null;
}

async function processTransaction(ctx: ConnectorContext, txn: AmazonTransaction) {
  if (!txn.transactionId) return;
  const externalOrderId = relatedOrderId(txn);
  const order = externalOrderId
    ? await prisma.order.findFirst({ where: { connectionId: ctx.connectionId, externalOrderId }, select: { id: true } })
    : null;

  const amount = toPaise(txn.totalAmount?.amount);
  const feeAmount = sumFees(txn);

  await prisma.payment.upsert({
    where: { connectionId_externalPaymentId: { connectionId: ctx.connectionId, externalPaymentId: txn.transactionId } },
    create: {
      organizationId: ctx.organizationId,
      legalEntityId: ctx.legalEntityId,
      connectionId: ctx.connectionId,
      externalPaymentId: txn.transactionId,
      orderId: order?.id ?? null,
      amount,
      currency: txn.totalAmount?.currencyCode ?? "INR",
      method: "amazon_settlement",
      status: txn.transactionStatus ?? "unknown",
      feeAmount,
      capturedAt: txn.postedDate ? new Date(txn.postedDate) : null,
      raw: txn as unknown as object,
    },
    update: {
      status: txn.transactionStatus ?? "unknown",
      amount,
      feeAmount,
      raw: txn as unknown as object,
    },
  });
}

async function pullTransactions(ctx: ConnectorContext, sinceIso: string | null): Promise<number> {
  const creds = decodeCredentials(ctx.credentialsRef);
  const accessToken = await getAccessToken(creds.refreshToken);

  const now = new Date();
  const postedAfter = sinceIso ?? new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  let nextToken: string | undefined;
  let pages = 0;
  let total = 0;

  do {
    const url = new URL(`${SP_API_BASE}/finances/${FINANCES_API_VERSION}/transactions`);
    url.searchParams.set("postedAfter", postedAfter);
    if (nextToken) url.searchParams.set("nextToken", nextToken);

    const res = await fetch(url, { headers: spApiHeaders(accessToken) });
    if (!res.ok) throw new Error(`amazon_list_transactions_failed_${res.status}_${await res.text()}`);
    const data = (await res.json()) as ListTransactionsResponse;
    const transactions = data.payload?.transactions ?? [];

    for (const txn of transactions) {
      await processTransaction(ctx, txn);
      total++;
    }

    nextToken = data.payload?.nextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES_PER_RUN);

  return total;
}

async function pull(ctx: ConnectorContext, sinceIso: string | null): Promise<SyncResult> {
  const orderCount = await pullOrders(ctx, sinceIso);
  // Transactions lag orders (Amazon: "orders from the last 48 hours might not
  // be included in financial events yet"), pulled independently rather than
  // gated on order sync succeeding — a transactions failure shouldn't lose
  // orders that already landed, and vice versa is handled by the caller's
  // own try/catch per connector.
  const txnCount = await pullTransactions(ctx, sinceIso);
  return { recordsFetched: orderCount + txnCount, cursor: new Date().toISOString() };
}

export const amazonConnector: Connector = {
  provider: "AMAZON",

  async backfill(ctx: ConnectorContext): Promise<SyncResult> {
    return pull(ctx, null);
  },

  async sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult> {
    return pull(ctx, sinceCursor);
  },

  // SP-API has notification webhooks (EventBridge/SQS-based), but that's a
  // materially different integration shape (AWS infra, not an HTTP POST to
  // our own endpoint) than every webhook this codebase has — out of scope
  // for this pass. Poll-only, same as Meta/Google Ads.
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, eventType: string): Promise<void> {
    if (eventType === "order.sync") await upsertOrder(ctx, payload as AmazonOrder);
  },
};
