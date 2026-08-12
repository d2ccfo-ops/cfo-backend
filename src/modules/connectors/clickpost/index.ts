import crypto from "node:crypto";
import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";
import type { ShipmentStatus } from "@prisma/client";

// ClickPost is a logistics *aggregator* (500+ carriers behind one API), so it
// sits in the same category as Shiprocket rather than a single courier like
// Delhivery. But its API shape is Delhivery's, not Shiprocket's, and that
// distinction drives this whole file:
//  - There is no bulk "list all my shipments" endpoint. Tracking is
//    track-by-known-waybill only (GET /api/v2/track-order/, max 10 waybills
//    per call and only for the same carrier). Confirmed against ClickPost's
//    own docs before building this, not assumed.
//  - So backfill() is a genuine, permanent no-op — nothing to pull on first
//    connect — and sync() can only re-track shipments already known from
//    webhook deliveries. Exactly Delhivery's constraint, for the same reason.
//  - The webhook is therefore the primary (really, the only) discovery
//    mechanism. ClickPost has no signature/HMAC scheme for it — same gap as
//    Delhivery and Setu — but it *does* let you configure an arbitrary
//    webhook URL per account in its dashboard, so this reuses Delhivery's
//    unguessable-token-in-the-URL approach (routes/webhooks/clickpost.ts)
//    rather than Setu's global shared secret.
//  - Auth is two static query params (`username` + `key`), not a header
//    token and not OAuth.

const TRACK_API_BASE = "https://api.clickpost.in/api/v2/track-order/";
// ClickPost's own limit: up to 10 waybills per request, and only for a
// single carrier at a time — hence the group-by-cp_id batching in sync().
const MAX_WAYBILLS_PER_REQUEST = 10;

export interface ClickPostCredentials {
  username: string;
  apiKey: string;
  webhookToken: string; // our own generated secret, embedded in the webhook URL we hand to ClickPost
}

export function encodeCredentials(creds: ClickPostCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): ClickPostCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as ClickPostCredentials;
}

export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

// ClickPost normalises every carrier's own status vocabulary into one numeric
// code set, which is the main reason to integrate an aggregator at all — this
// mapping is against ClickPost's published status-code table rather than the
// best-effort string guessing Shiprocket/Delhivery need, so it's materially
// more trustworthy than those two.
//
// Deliberately NOT mapped, and why it matters: codes 101-106 are ClickPost's
// *returns/exchange* platform (customer-initiated returns after delivery) and
// 30-32 are exchanges. Those are not RTO. RTO means the parcel never reached
// the customer and came back; a return means it was delivered and sent back.
// Folding returns into RTO_INITIATED would silently inflate the RTO-rate
// metric (modules/calc/shipments.ts) with post-delivery events, so they fall
// through to UNKNOWN instead — visible as unmapped rather than wrong.
const STATUS_CODE_MAP: Record<number, ShipmentStatus> = {
  1: "NEW", // OrderPlaced
  2: "NEW", // PickupPending
  3: "NEW", // PickupFailed — still pre-dispatch
  25: "NEW", // OutForPickup
  28: "NEW", // AwbRegistered
  4: "PICKED_UP",
  5: "IN_TRANSIT",
  18: "IN_TRANSIT", // ShipmentDelayed/misroute — still moving
  20: "IN_TRANSIT", // ShipmentHeld
  1004: "IN_TRANSIT", // DestinationHubIn
  1005: "IN_TRANSIT", // OriginCityIn
  1006: "IN_TRANSIT", // OriginCityOut
  6: "OUT_FOR_DELIVERY",
  // A failed delivery attempt is still a dispatched parcel out with the
  // courier, so it stays in the dispatched bucket rather than regressing to
  // IN_TRANSIT — this is what keeps RTO-rate's denominator honest.
  9: "OUT_FOR_DELIVERY", // FailedDelivery (NDR)
  8: "DELIVERED",
  10: "CANCELLED",
  23: "CANCELLED", // Expired
  11: "RTO_INITIATED", // RTO-Requested
  12: "RTO_INITIATED", // RTO-Marked
  13: "RTO_INITIATED", // RTO-OutForDelivery
  15: "RTO_INITIATED", // RTO-Failed
  21: "RTO_INITIATED", // RTO-InTransit
  26: "RTO_INITIATED", // RTO-ContactCustomerCare
  27: "RTO_INITIATED", // RTO-ShipmentDelay
  14: "RTO_DELIVERED",
  16: "LOST",
  // Damaged is financially a loss event, not a delivery — grouped with LOST
  // rather than left UNKNOWN so it isn't silently excluded from the
  // dispatched-shipment counts it belongs in.
  17: "LOST", // Damaged
};

function mapStatusCode(code: number | string | null | undefined): ShipmentStatus {
  if (code == null || code === "") return "UNKNOWN";
  const numeric = typeof code === "number" ? code : Number(code);
  if (Number.isNaN(numeric)) return "UNKNOWN";
  return STATUS_CODE_MAP[numeric] ?? "UNKNOWN";
}

const TERMINAL_STATUSES: ShipmentStatus[] = ["DELIVERED", "RTO_DELIVERED", "CANCELLED", "LOST"];

// ClickPost sends `timestamp` as "YYYY-MM-DDTHH:MM:SS" with no zone marker,
// same India-local-time-without-an-offset problem as Shiprocket's dates —
// parsing naively would shift every event by the host's UTC offset (5.5h on
// a UTC server).
function parseClickPostDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.startsWith("0000-00-00")) return null;
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(trimmed);
  const iso = naive ? `${naive[1]}T${naive[2]}+05:30` : trimmed;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Both the webhook payload and the tracking API's per-waybill result carry
// the same conceptual fields, just nested differently — normalised to this
// before anything touches the database.
export interface ClickPostEvent {
  waybill?: string;
  cp_id?: number | string;
  clickpost_status_code?: number | string;
  clickpost_status_description?: string;
  status?: string;
  timestamp?: string;
  location?: string;
  remark?: string;
  courier_name?: string;
  reference_number?: string;
  additional?: Record<string, unknown>;
}

function pick<T>(obj: Record<string, unknown> | null | undefined, ...names: string[]): T | undefined {
  if (!obj) return undefined;
  for (const name of names) {
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === name.toLowerCase()) return obj[key] as T;
    }
  }
  return undefined;
}

// ClickPost's webhook nests a `latest_status` object inside `additional` that
// repeats most top-level fields; the tracking API nests the equivalent under
// result[waybill].latest_status. Reading top-level first and falling back to
// the nested copy handles both without a separate parser per source.
export function normaliseEvent(raw: Record<string, unknown>): ClickPostEvent {
  const additional = pick<Record<string, unknown>>(raw, "additional") ?? {};
  const latest = pick<Record<string, unknown>>(raw, "latest_status") ?? pick<Record<string, unknown>>(additional, "latest_status") ?? {};

  return {
    waybill: pick<string>(raw, "waybill") ?? pick<string>(latest, "waybill"),
    cp_id: pick<number | string>(raw, "cp_id") ?? pick<number | string>(latest, "cp_id"),
    clickpost_status_code: pick<number | string>(raw, "clickpost_status_code") ?? pick<number | string>(latest, "clickpost_status_code"),
    clickpost_status_description:
      pick<string>(raw, "clickpost_status_description") ?? pick<string>(latest, "clickpost_status_description"),
    status: pick<string>(raw, "status") ?? pick<string>(latest, "status"),
    timestamp: pick<string>(raw, "timestamp") ?? pick<string>(latest, "timestamp"),
    location: pick<string>(raw, "location") ?? pick<string>(latest, "location"),
    remark: pick<string>(raw, "remark") ?? pick<string>(latest, "remark"),
    courier_name: pick<string>(additional, "courier_name", "courier_partner", "carrier_name"),
    // ClickPost echoes the merchant's own order identifier back under a few
    // different names depending on how the shipment was created — this is
    // what lets a shipment be matched to an Order we already have.
    reference_number: pick<string>(additional, "reference_number", "order_id", "order_reference", "reference"),
    additional,
  };
}

interface TrackOrderResponse {
  meta?: { status?: number; success?: boolean };
  result?: Record<string, { latest_status?: Record<string, unknown>; valid?: boolean; additional?: Record<string, unknown> }>;
}

async function trackWaybills(
  creds: ClickPostCredentials,
  cpId: string,
  waybills: string[]
): Promise<ClickPostEvent[]> {
  const events: ClickPostEvent[] = [];

  for (let i = 0; i < waybills.length; i += MAX_WAYBILLS_PER_REQUEST) {
    const batch = waybills.slice(i, i + MAX_WAYBILLS_PER_REQUEST);
    const url = new URL(TRACK_API_BASE);
    url.searchParams.set("username", creds.username);
    url.searchParams.set("key", creds.apiKey);
    url.searchParams.set("waybill", batch.join(","));
    url.searchParams.set("cp_id", cpId);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`clickpost_track_failed_${res.status}_${await res.text()}`);
    const data = (await res.json()) as TrackOrderResponse;

    for (const [waybill, entry] of Object.entries(data.result ?? {})) {
      if (entry?.valid === false) continue; // waybill unknown to ClickPost — skip rather than write an empty shipment
      events.push(
        normaliseEvent({
          waybill,
          cp_id: cpId,
          latest_status: entry?.latest_status,
          additional: entry?.additional,
        })
      );
    }
  }

  return events;
}

async function recordAndProcess(ctx: ConnectorContext, event: ClickPostEvent) {
  if (!event.waybill) return;
  const externalEventId = `shipment_${event.waybill}_${event.timestamp ?? event.clickpost_status_code ?? Date.now()}`;
  await prisma.rawEvent.upsert({
    where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
    create: {
      organizationId: ctx.organizationId,
      connectionId: ctx.connectionId,
      provider: "CLICKPOST",
      externalEventId,
      eventType: "shipment.sync",
      payload: event as unknown as object,
      processedAt: new Date(),
      processingStatus: "PROCESSED",
    },
    update: { payload: event as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
  });
  await clickpostConnector.processEvent(ctx, event, "shipment.sync");
}

export const clickpostConnector: Connector = {
  provider: "CLICKPOST",

  // Permanent no-op — ClickPost has no endpoint that enumerates a merchant's
  // shipments, so there is genuinely nothing to pull on first connect. See
  // the module-level comment.
  async backfill(_ctx: ConnectorContext): Promise<SyncResult> {
    return { recordsFetched: 0, cursor: null };
  },

  // Re-tracks every non-terminal shipment already known for this connection
  // (learned from webhook deliveries), to catch up on any status change a
  // missed webhook didn't relay. Cannot discover new shipments.
  async sync(ctx: ConnectorContext, _sinceCursor: string | null): Promise<SyncResult> {
    const creds = decodeCredentials(ctx.credentialsRef);
    const known = await prisma.shipment.findMany({
      where: { connectionId: ctx.connectionId, status: { notIn: TERMINAL_STATUSES }, awbCode: { not: null } },
      select: { awbCode: true, raw: true },
    });

    // The tracking API needs both the waybill and its carrier (cp_id), and
    // only accepts one carrier per request — so shipments are grouped by the
    // cp_id stored on their raw payload. Anything missing a cp_id can't be
    // re-tracked and is skipped rather than guessed at.
    const byCarrier = new Map<string, string[]>();
    for (const shipment of known) {
      const raw = (shipment.raw ?? {}) as Record<string, unknown>;
      const cpId = raw.cp_id == null ? null : String(raw.cp_id);
      if (!cpId || !shipment.awbCode) continue;
      const list = byCarrier.get(cpId) ?? [];
      list.push(shipment.awbCode);
      byCarrier.set(cpId, list);
    }

    let total = 0;
    for (const [cpId, waybills] of byCarrier) {
      const events = await trackWaybills(creds, cpId, waybills);
      for (const event of events) {
        await recordAndProcess(ctx, event);
        total++;
      }
      ctx.reportProgress?.(total, null);
    }

    return { recordsFetched: total, cursor: null };
  },

  // ClickPost documents no signature/HMAC scheme for its webhook (checked
  // against their docs, not assumed) — routes/webhooks/clickpost.ts uses an
  // unguessable per-connection token in the URL instead, same approach as
  // Delhivery.
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, _eventType: string): Promise<void> {
    // Accepts either an already-normalised event (from sync) or a raw webhook
    // body (from the webhook route) — normalising twice is harmless.
    const event = normaliseEvent(payload as Record<string, unknown>);
    if (!event.waybill) return;

    const matchedOrder = event.reference_number
      ? await prisma.order.findFirst({
          where: { organizationId: ctx.organizationId, orderNumber: String(event.reference_number) },
          select: { id: true },
        })
      : null;

    const status = mapStatusCode(event.clickpost_status_code);
    const eventAt = parseClickPostDate(event.timestamp);
    const deliveredAt = status === "DELIVERED" ? (eventAt ?? new Date()) : null;
    const pickedUpAt = status === "PICKED_UP" ? (eventAt ?? new Date()) : null;

    await prisma.shipment.upsert({
      where: { connectionId_externalShipmentId: { connectionId: ctx.connectionId, externalShipmentId: event.waybill } },
      create: {
        organizationId: ctx.organizationId,
        legalEntityId: ctx.legalEntityId,
        connectionId: ctx.connectionId,
        externalShipmentId: event.waybill,
        orderId: matchedOrder?.id ?? null,
        awbCode: event.waybill,
        courierName: event.courier_name ?? (event.cp_id != null ? `ClickPost carrier ${event.cp_id}` : "ClickPost"),
        status,
        pickedUpAt,
        deliveredAt,
        raw: event as unknown as object,
      },
      // `undefined` rather than null on the timestamps so a later event that
      // doesn't carry one can't erase a value an earlier event supplied —
      // status updates arrive as a stream, each carrying only its own moment.
      update: {
        orderId: matchedOrder?.id ?? null,
        status,
        pickedUpAt: pickedUpAt ?? undefined,
        deliveredAt: deliveredAt ?? undefined,
        raw: event as unknown as object,
      },
    });
  },
};
