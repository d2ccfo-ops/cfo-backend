import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import { rupeesToPaise } from "../../calc/money.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";
import type { ShipmentStatus } from "@prisma/client";

// Shiprocket is a third shape again, distinct from both Shopify (OAuth) and
// Razorpay (static API keys): the merchant creates an "API user" (email +
// password, not their real Shiprocket login) in their dashboard, and that
// email/password is exchanged for a bearer token valid 240 hours. There's no
// refresh-token flow — you just log in again. Rather than caching a token and
// persisting a refreshed one back onto the Connection row (real complexity
// for little benefit at this scale), this connector logs in fresh at the
// start of every backfill/sync/webhook-process call. One extra HTTP call per
// run is a fine trade for not needing token-mutation plumbing.
//
// Known gap, flagged honestly: unlike Shopify/Razorpay, Shiprocket's public
// docs (apidocs.shiprocket.in) render client-side and couldn't be fully
// verified against live responses while building this. The auth endpoint and
// token lifetime below are well-corroborated across Shiprocket's own support
// docs and multiple SDKs. The order/shipment listing response shape is
// best-effort from the same sources, defensively parsed, and the full raw
// payload is always stored on RawEvent/Shipment.raw regardless — so nothing
// is lost even if a field mapping below turns out to need adjusting once
// this runs against a real Shiprocket account. See cfo-docs/ONBOARDING.md.

const API_BASE = "https://apiv2.shiprocket.in/v1/external";
const MAX_PAGES_PER_RUN = 200;

export interface ShiprocketCredentials {
  email: string;
  password: string;
  webhookToken: string; // the "Secret Key" configured in Shiprocket's webhook panel
}

export function encodeCredentials(creds: ShiprocketCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): ShiprocketCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as ShiprocketCredentials;
}

export async function login(creds: ShiprocketCredentials): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (!res.ok) throw new Error(`Shiprocket login failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("Shiprocket login response had no token");
  return data.token;
}

interface ShiprocketShipment {
  id?: number | string;
  awb?: string | null;
  awb_code?: string | null;
  courier_name?: string | null;
  courier?: string | null;
  status?: string | null;
  // Shiprocket reports the human-readable state as `current_status` on
  // tracking/shipment objects and as `status` on order objects; there's also
  // a numeric `shipment_status` code whose full mapping table isn't public,
  // so this deliberately reads only the string forms.
  current_status?: string | null;
  delivered_date?: string | null;
  pickup_date?: string | null;
  freight_charges?: string | number | null;
}

// Shiprocket returns "YYYY-MM-DD HH:mm:ss" in IST, with no timezone marker —
// parsing that directly would silently shift every timestamp by the server's
// own UTC offset (5.5h on a UTC host). Zero-dates ("0000-00-00 ...") are a
// MySQL artifact these APIs commonly emit for "not set" and must not become
// Jan 1st year 0. Anything already carrying an offset/Z is passed through.
function parseShiprocketDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("0000-00-00")) return null;
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(trimmed);
  const iso = naive ? `${naive[1]}T${naive[2]}+05:30` : trimmed;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface ShiprocketOrder {
  id: number | string;
  channel_order_id?: string;
  order_id?: string;
  status?: string;
  channel?: string;
  created_at?: string;
  cod_amount?: string | number;
  shipments?: ShiprocketShipment[];
  // Some responses flatten a single shipment's fields onto the order itself
  // instead of nesting a `shipments` array — handled defensively below.
  awb?: string | null;
  awb_code?: string | null;
  courier_name?: string | null;
  current_status?: string | null;
  delivered_date?: string | null;
  pickup_date?: string | null;
  freight_charges?: string | number | null;
}

interface ShiprocketOrdersResponse {
  data: ShiprocketOrder[];
  meta?: { pagination?: { total_pages?: number } };
}

const STATUS_MAP: Record<string, ShipmentStatus> = {
  NEW: "NEW",
  "ORDER PLACED": "NEW",
  "PICKUP SCHEDULED": "NEW",
  "PICKED UP": "PICKED_UP",
  "IN TRANSIT": "IN_TRANSIT",
  "OUT FOR DELIVERY": "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  "RTO INITIATED": "RTO_INITIATED",
  "RTO DELIVERED": "RTO_DELIVERED",
  CANCELED: "CANCELLED",
  CANCELLED: "CANCELLED",
  LOST: "LOST",
};

function mapStatus(raw: string | null | undefined): ShipmentStatus {
  if (!raw) return "UNKNOWN";
  return STATUS_MAP[raw.trim().toUpperCase()] ?? "UNKNOWN";
}

// One order can carry multiple shipments (split fulfillment); some API
// responses instead flatten a single shipment's fields onto the order. This
// normalizes both shapes into a flat list to upsert.
function extractShipments(order: ShiprocketOrder): ShiprocketShipment[] {
  if (order.shipments && order.shipments.length > 0) return order.shipments;
  if (order.awb || order.awb_code || order.courier_name) {
    return [
      {
        id: order.id,
        awb: order.awb,
        awb_code: order.awb_code,
        courier_name: order.courier_name,
        status: order.status,
        current_status: order.current_status,
        delivered_date: order.delivered_date,
        pickup_date: order.pickup_date,
        freight_charges: order.freight_charges,
      },
    ];
  }
  return [];
}

async function recordAndProcessOrder(ctx: ConnectorContext, order: ShiprocketOrder) {
  const externalEventId = `order_${order.id}`;
  await prisma.rawEvent.upsert({
    where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
    create: {
      organizationId: ctx.organizationId,
      connectionId: ctx.connectionId,
      provider: "SHIPROCKET",
      externalEventId,
      eventType: "order.sync",
      payload: order as unknown as object,
      processedAt: new Date(),
      processingStatus: "PROCESSED",
    },
    update: { payload: order as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
  });
  await shiprocketConnector.processEvent(ctx, order, "order.sync");
}

async function pullOrders(ctx: ConnectorContext, sinceDate: string | null): Promise<SyncResult> {
  const creds = decodeCredentials(ctx.credentialsRef);
  const token = await login(creds);

  let page = 1;
  let total = 0;
  let totalPages = 1;

  do {
    const query = new URLSearchParams({ page: String(page) });
    if (sinceDate) query.set("from", sinceDate);
    const res = await fetch(`${API_BASE}/orders?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Shiprocket orders request failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as ShiprocketOrdersResponse;
    const orders = Array.isArray(data.data) ? data.data : [];

    for (const order of orders) {
      await recordAndProcessOrder(ctx, order);
      total++;
    }

    totalPages = data.meta?.pagination?.total_pages ?? 1;
    page++;
  } while (page <= totalPages && page <= MAX_PAGES_PER_RUN);

  const cursor = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, Shiprocket's `from` filter grain
  return { recordsFetched: total, cursor };
}

export const shiprocketConnector: Connector = {
  provider: "SHIPROCKET",

  async backfill(ctx: ConnectorContext): Promise<SyncResult> {
    return pullOrders(ctx, null);
  },

  async sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult> {
    return pullOrders(ctx, sinceCursor);
  },

  // Same shape as Razorpay: the webhook "secret" is a value the merchant
  // chooses themselves in their own Shiprocket panel, not a platform-wide
  // HMAC key, so it can't be verified without a DB lookup per connection.
  // routes/webhooks/shiprocket.ts does that lookup; this always returns
  // invalid on its own. See cfo-docs/ARCHITECTURE.md.
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, eventType: string): Promise<void> {
    const order = payload as ShiprocketOrder;
    const orderNumber = order.channel_order_id ?? order.order_id;
    const matchedOrder = orderNumber
      ? await prisma.order.findFirst({
          where: { organizationId: ctx.organizationId, orderNumber: String(orderNumber) },
          select: { id: true },
        })
      : null;

    const codAmount =
      order.cod_amount != null && order.cod_amount !== "" ? rupeesToPaise(Number(order.cod_amount)) : null;

    for (const shipment of extractShipments(order)) {
      const externalShipmentId = String(shipment.id ?? shipment.awb ?? shipment.awb_code ?? `${order.id}_${eventType}`);
      const awbCode = shipment.awb ?? shipment.awb_code ?? null;
      const status = mapStatus(shipment.current_status ?? shipment.status ?? order.status);

      // Previously `deliveredAt` was set to `new Date()` whenever the status
      // happened to read DELIVERED — i.e. the time we *synced*, not the time
      // the parcel landed. That silently makes every delivery look like it
      // happened during a backfill, so any delivery-time metric built on it
      // would be meaningless. Shiprocket reports the real timestamps.
      const deliveredAt = parseShiprocketDate(shipment.delivered_date);
      // pickup_date is the real dispatch timestamp. cfo-docs/PROGRESS.md
      // flags getRtoRateSummary() as bucketing by Shipment.createdAt (when we
      // first ingested the row) precisely because nothing populated this —
      // the column already existed, it was just never filled in.
      const pickedUpAt = parseShiprocketDate(shipment.pickup_date);
      const freightAmount =
        shipment.freight_charges != null && shipment.freight_charges !== ""
          ? rupeesToPaise(Number(shipment.freight_charges))
          : null;

      await prisma.shipment.upsert({
        where: { connectionId_externalShipmentId: { connectionId: ctx.connectionId, externalShipmentId } },
        create: {
          organizationId: ctx.organizationId,
          legalEntityId: ctx.legalEntityId,
          connectionId: ctx.connectionId,
          externalShipmentId,
          orderId: matchedOrder?.id ?? null,
          awbCode,
          courierName: shipment.courier_name ?? shipment.courier ?? null,
          status,
          codAmount,
          freightAmount,
          pickedUpAt,
          deliveredAt,
          raw: payload as object,
        },
        // `undefined` (not null) on the timestamp/freight fields so a later
        // event that omits them can't erase a value an earlier one supplied —
        // Shiprocket's order list and its webhook carry different subsets.
        update: {
          orderId: matchedOrder?.id ?? null,
          awbCode,
          courierName: shipment.courier_name ?? shipment.courier ?? null,
          status,
          codAmount,
          freightAmount: freightAmount ?? undefined,
          pickedUpAt: pickedUpAt ?? undefined,
          deliveredAt: deliveredAt ?? undefined,
          raw: payload as object,
        },
      });
    }
  },
};
