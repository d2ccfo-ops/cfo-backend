import crypto from "node:crypto";
import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";
import type { ShipmentStatus } from "@prisma/client";

// Delhivery is a seventh shape, and the most constrained one yet — its
// public API is built around tracking waybills you already know about, not
// discovering shipments. There is no "list all my shipments" endpoint
// (confirmed by checking Delhivery's own docs before building this, not
// assumed): the only bulk-ish capability is GET .../packages/json/ tracking
// up to 30 known AWBs at once. So:
//  - backfill() is a genuine, permanent no-op — there is nothing to pull on
//    first connect. Shipments only become known to us as their webhook
//    events arrive (see processEvent), same as if this were a pure webhook
//    connector, except Delhivery's webhook has no documented signature
//    scheme at all (see routes/webhooks/delhivery.ts for how that's
//    handled).
//  - sync() re-tracks shipments already known from webhook events, to catch
//    up on any status change a missed webhook delivery didn't relay. It
//    can't discover anything new.
// Auth is a single static API token (Settings -> API Setup in Delhivery
// One), sent as `Authorization: Token <token>` — the standard Django REST
// Framework convention, which is what several independent Delhivery
// integration write-ups use; not confirmed against a live account.

const TRACK_API_BASE = "https://track.delhivery.com/api/v1/packages/json/";
const MAX_WAYBILLS_PER_REQUEST = 30;

export interface DelhiveryCredentials {
  apiToken: string;
  webhookToken: string; // our own generated secret, embedded in the webhook URL we give Delhivery — see below
}

export function encodeCredentials(creds: DelhiveryCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): DelhiveryCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as DelhiveryCredentials;
}

export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

interface DelhiveryShipmentStatus {
  Status?: string;
  StatusDateTime?: string;
  StatusType?: string;
  StatusLocation?: string;
}

interface DelhiveryShipment {
  AWB?: string;
  Status?: DelhiveryShipmentStatus;
  PickUpDate?: string;
  ReferenceNo?: string;
}

interface DelhiveryTrackResponse {
  ShipmentData?: { Shipment: DelhiveryShipment }[];
}

// Best-effort mapping — Delhivery's exact status vocabulary isn't confirmed
// against a live account (same category of caveat as Shiprocket's). Unknown
// strings fall through to UNKNOWN rather than guessing, and the raw payload
// is always stored so nothing is lost if this needs adjusting.
const STATUS_MAP: Record<string, ShipmentStatus> = {
  MANIFESTED: "NEW",
  "NOT PICKED": "NEW",
  "PICKED UP": "PICKED_UP",
  DISPATCHED: "IN_TRANSIT",
  "IN TRANSIT": "IN_TRANSIT",
  "OUT FOR DELIVERY": "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  RTO: "RTO_INITIATED",
  "RTO INITIATED": "RTO_INITIATED",
  "RTO DELIVERED": "RTO_DELIVERED",
  CANCELED: "CANCELLED",
  CANCELLED: "CANCELLED",
  LOST: "LOST",
};

function mapStatus(raw: string | undefined): ShipmentStatus {
  if (!raw) return "UNKNOWN";
  return STATUS_MAP[raw.trim().toUpperCase()] ?? "UNKNOWN";
}

const TERMINAL_STATUSES: ShipmentStatus[] = ["DELIVERED", "RTO_DELIVERED", "CANCELLED", "LOST"];

async function trackWaybills(apiToken: string, waybills: string[]): Promise<DelhiveryShipment[]> {
  if (waybills.length === 0) return [];
  const results: DelhiveryShipment[] = [];

  for (let i = 0; i < waybills.length; i += MAX_WAYBILLS_PER_REQUEST) {
    const batch = waybills.slice(i, i + MAX_WAYBILLS_PER_REQUEST);
    const url = new URL(TRACK_API_BASE);
    url.searchParams.set("waybill", batch.join(","));
    const res = await fetch(url, { headers: { Authorization: `Token ${apiToken}` } });
    if (!res.ok) throw new Error(`delhivery_track_failed_${res.status}`);
    const data = (await res.json()) as DelhiveryTrackResponse;
    for (const item of data.ShipmentData ?? []) {
      if (item.Shipment) results.push(item.Shipment);
    }
  }

  return results;
}

async function recordAndProcess(ctx: ConnectorContext, shipment: DelhiveryShipment) {
  if (!shipment.AWB) return;
  const externalEventId = `shipment_${shipment.AWB}_${shipment.Status?.StatusDateTime ?? Date.now()}`;
  await prisma.rawEvent.upsert({
    where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
    create: {
      organizationId: ctx.organizationId,
      connectionId: ctx.connectionId,
      provider: "DELHIVERY",
      externalEventId,
      eventType: "shipment.sync",
      payload: shipment as unknown as object,
      processedAt: new Date(),
      processingStatus: "PROCESSED",
    },
    update: { payload: shipment as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
  });
  await delhiveryConnector.processEvent(ctx, shipment, "shipment.sync");
}

export const delhiveryConnector: Connector = {
  provider: "DELHIVERY",

  // Permanent no-op — see the module-level comment on why there's nothing
  // to pull on first connect.
  async backfill(_ctx: ConnectorContext): Promise<SyncResult> {
    return { recordsFetched: 0, cursor: null };
  },

  // Re-tracks every non-terminal shipment already known for this connection
  // (from webhook events), to catch up on missed webhook deliveries. Cannot
  // discover shipments Delhivery hasn't told us about via webhook yet.
  async sync(ctx: ConnectorContext, _sinceCursor: string | null): Promise<SyncResult> {
    const creds = decodeCredentials(ctx.credentialsRef);
    const known = await prisma.shipment.findMany({
      where: { connectionId: ctx.connectionId, status: { notIn: TERMINAL_STATUSES }, awbCode: { not: null } },
      select: { awbCode: true },
    });
    const waybills = known.map((s) => s.awbCode).filter((awb): awb is string => Boolean(awb));
    const shipments = await trackWaybills(creds.apiToken, waybills);
    for (const shipment of shipments) {
      await recordAndProcess(ctx, shipment);
    }
    return { recordsFetched: shipments.length, cursor: null };
  },

  // No documented signature/verification scheme exists for Delhivery's push
  // webhook at all (confirmed by checking their docs, not assumed) — see
  // routes/webhooks/delhivery.ts for how this connector compensates (an
  // unguessable token embedded in the webhook URL itself, since there's no
  // header/field to verify).
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, _eventType: string): Promise<void> {
    const shipment = payload as DelhiveryShipment;
    if (!shipment.AWB) return;

    const referenceNo = shipment.ReferenceNo;
    const matchedOrder = referenceNo
      ? await prisma.order.findFirst({
          where: { organizationId: ctx.organizationId, orderNumber: String(referenceNo) },
          select: { id: true },
        })
      : null;

    const status = mapStatus(shipment.Status?.Status);

    await prisma.shipment.upsert({
      where: { connectionId_externalShipmentId: { connectionId: ctx.connectionId, externalShipmentId: shipment.AWB } },
      create: {
        organizationId: ctx.organizationId,
        legalEntityId: ctx.legalEntityId,
        connectionId: ctx.connectionId,
        externalShipmentId: shipment.AWB,
        orderId: matchedOrder?.id ?? null,
        awbCode: shipment.AWB,
        courierName: "Delhivery",
        status,
        deliveredAt: status === "DELIVERED" ? new Date() : null,
        raw: payload as object,
      },
      update: {
        orderId: matchedOrder?.id ?? null,
        status,
        deliveredAt: status === "DELIVERED" ? new Date() : undefined,
        raw: payload as object,
      },
    });
  },
};
