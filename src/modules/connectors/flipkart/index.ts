import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import { rupeesToPaise } from "../../calc/money.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";

// Flipkart is closer to Razorpay's shape than Shopify's or Amazon's: no OAuth
// redirect at all. Flipkart's "Self Access Application" — created by the
// seller themselves in their own Seller Dashboard (Manage Profile ->
// Developer Access), scoped to their own account only — issues an appId/
// appSecret pair that authenticates via OAuth2 client_credentials, a single
// server-to-server call with no browser round-trip. This is deliberately the
// path built here, not the "Authorization Code" flow (which is for third-
// party apps acting on behalf of many sellers, and needs Flipkart's app
// review) — the same reasoning as Shopify's Custom App token path being
// preferred over full OAuth for this product's shape.
//
// Honesty gap, worth stating plainly rather than guessing around: Flipkart's
// published API reference has an Order Management API (confirmed against
// seller.flipkart.com/api-docs/order-api-docs/OMAPIRef.html) but its Payment
// Management API page is a literal "Coming Soon" placeholder as of this
// writing — there is no public settlement/payment endpoint to build against.
// This connector pulls real orders/shipments only. Unlike Shiprocket's
// best-effort-but-plausible field mapping, this isn't "might be wrong" — the
// endpoint simply isn't published, so there is nothing to call. Revisit if
// Flipkart publishes it, or a seller's dashboard export/report becomes the
// fallback (same "CSV upload" pattern as the bank connector).

const OAUTH_TOKEN_URL = "https://api.flipkart.net/oauth-service/oauth/token";
const API_BASE = "https://api.flipkart.net/sellers";
const MAX_PAGES_PER_RUN = 100;
const PAGE_SIZE = 20; // Flipkart's shipments/filter caps pageSize at 20

export interface FlipkartCredentials {
  appId: string;
  appSecret: string;
}

export function encodeCredentials(creds: FlipkartCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): FlipkartCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as FlipkartCredentials;
}

// client_credentials grant: Basic-auth the appId:appSecret pair against the
// token endpoint, get back a short-lived bearer token. No refresh_token in
// this grant type — same "fetch a fresh one at the start of every call"
// pattern as Google Ads/Shiprocket, just with no separate long-lived secret
// to store beyond appId/appSecret themselves.
export async function getAccessToken(creds: FlipkartCredentials): Promise<string> {
  const basicAuth = Buffer.from(`${creds.appId}:${creds.appSecret}`).toString("base64");
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "Seller_Api" }),
  });
  if (!res.ok) throw new Error(`flipkart_token_failed_${res.status}_${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// Validates the credentials actually work before a caller persists them —
// same "probe before saving" discipline as Shopify's/Shiprocket's connect
// routes. Throws on failure; callers turn that into a 400.
export async function verifyCredentials(creds: FlipkartCredentials): Promise<void> {
  await getAccessToken(creds);
}

interface FlipkartOrderItem {
  orderItemId?: string;
  sku?: string;
  quantity?: number;
  productTitle?: string;
  priceComponents?: { sellingPrice?: number; total?: number };
}

interface FlipkartShipment {
  shipmentId: string;
  orderId?: string;
  orderDate?: string;
  status?: string;
  orderItems?: FlipkartOrderItem[];
}

interface ShipmentsFilterResponse {
  shipments?: FlipkartShipment[];
  hasMore?: boolean;
  nextPageUrl?: string;
}

function toPaise(amount: number | null | undefined): bigint {
  return rupeesToPaise(amount ?? 0);
}

function mapOrder(shipment: FlipkartShipment) {
  const items = shipment.orderItems ?? [];
  let gross = 0n;
  const lineItems = items.map((item) => {
    const qty = item.quantity ?? 0;
    const total = item.priceComponents?.total ?? item.priceComponents?.sellingPrice ?? 0;
    const totalPaise = toPaise(total);
    gross += totalPaise;
    const unitPrice = qty > 0 ? totalPaise / BigInt(qty) : totalPaise;
    return {
      sku: item.sku || null,
      productName: item.productTitle ?? "Unknown product",
      quantity: qty,
      unitPrice,
      totalAmount: totalPaise,
    };
  });

  return {
    externalOrderId: shipment.orderId ?? shipment.shipmentId,
    orderNumber: shipment.orderId ?? shipment.shipmentId,
    channel: "flipkart",
    status: shipment.status ?? "unknown",
    currency: "INR",
    // No discount/tax breakdown in the shipments/filter response — see the
    // module-level comment. Recorded as zero rather than guessed; the raw
    // payload is preserved so a real per-order price breakdown can be added
    // later without re-pulling anything.
    grossAmount: gross,
    discountAmount: 0n,
    taxAmount: 0n,
    placedAt: shipment.orderDate ? new Date(shipment.orderDate) : new Date(),
    lineItems,
  };
}

async function upsertOrder(ctx: ConnectorContext, shipment: FlipkartShipment) {
  const mapped = mapOrder(shipment);
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
      raw: shipment as unknown as object,
    },
    update: {
      status: mapped.status,
      grossAmount: mapped.grossAmount,
      raw: shipment as unknown as object,
    },
  });

  await prisma.orderLineItem.deleteMany({ where: { orderId: row.id } });
  if (mapped.lineItems.length > 0) {
    await prisma.orderLineItem.createMany({ data: mapped.lineItems.map((li) => ({ orderId: row.id, ...li })) });
  }
}

async function pullOrders(ctx: ConnectorContext, sinceIso: string | null): Promise<number> {
  const creds = decodeCredentials(ctx.credentialsRef);
  const accessToken = await getAccessToken(creds);

  const now = new Date();
  const orderDateFrom = sinceIso ?? new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  let total = 0;
  let pages = 0;
  let nextUrl: string | null = `${API_BASE}/v3/shipments/filter/`;
  let body: object | null = {
    filter: {
      type: "preDispatch",
      orderDate: { from: orderDateFrom, to: now.toISOString() },
    },
    pagination: { pageSize: PAGE_SIZE },
  };

  while (nextUrl && pages < MAX_PAGES_PER_RUN) {
    const res: Response = await fetch(nextUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      // nextPageUrl (when present) is a complete, ready-to-call URL per
      // Flipkart's docs — no body on those follow-up requests, only on the
      // first filter call.
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`flipkart_shipments_filter_failed_${res.status}_${await res.text()}`);
    const data = (await res.json()) as ShipmentsFilterResponse;

    for (const shipment of data.shipments ?? []) {
      const externalEventId = `order_${shipment.orderId ?? shipment.shipmentId}`;
      await prisma.rawEvent.upsert({
        where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
        create: {
          organizationId: ctx.organizationId,
          connectionId: ctx.connectionId,
          provider: "FLIPKART",
          externalEventId,
          eventType: "order.sync",
          payload: shipment as unknown as object,
          processedAt: new Date(),
          processingStatus: "PROCESSED",
        },
        update: { payload: shipment as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
      });
      await upsertOrder(ctx, shipment);
      total++;
    }

    nextUrl = data.hasMore && data.nextPageUrl ? data.nextPageUrl : null;
    body = null; // only the first request carries a filter body
    pages++;
    ctx.reportProgress?.(total, null);
  }

  return total;
}

export const flipkartConnector: Connector = {
  provider: "FLIPKART",

  async backfill(ctx: ConnectorContext): Promise<SyncResult> {
    const count = await pullOrders(ctx, null);
    return { recordsFetched: count, cursor: new Date().toISOString() };
  },

  async sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult> {
    const count = await pullOrders(ctx, sinceCursor);
    return { recordsFetched: count, cursor: new Date().toISOString() };
  },

  // No documented webhook/push mechanism for orders — poll-only, same
  // category as Meta/Google Ads.
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, eventType: string): Promise<void> {
    if (eventType === "order.sync") await upsertOrder(ctx, payload as FlipkartShipment);
  },
};
