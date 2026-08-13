import crypto from "node:crypto";
import { Prisma, type ShipmentStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { isCashAtDoorGateway } from "./gateways.js";
import { capturedStatusFilter } from "../../calc/paymentStatus.js";

// Shipment rows derived from the Shopify fulfillments ALREADY STORED in
// Order.raw — no API call, no new credentials. Until this existed the
// Shipment table had zero rows while every order payload in Postgres carried
// courier name, AWB and (for ~35% of fulfillments) live delivery status:
// 3,760 delivered COD orders (₹29 L the courier has collected and owes) and
// 633 failed deliveries were sitting invisible in JSON.
//
// This is deliberately a pass over OUR database, not part of the order-page
// write path. Two reasons:
//  - codAmount needs the order's captured prepaid payments (GoKwik PPCOD:
//    part paid online, balance at the door), and payments are pulled AFTER
//    orders in a sync run — computing at order-write time would bake in a
//    stale zero.
//  - it makes backfill and ongoing sync the same code: the backfill script
//    and pull() both call syncShipmentsFromStoredOrders with a different
//    `since`, so a backfilled row and a synced one cannot drift.

// Shopify's fulfillment.shipment_status vocabulary → our ShipmentStatus.
//
// `failure` → RTO_INITIATED is a judgment call worth stating: Shopify keeps
// `failure` as the terminal tracking state when the courier reports the
// delivery failed. On Indian COD that parcel is heading back to origin —
// which is exactly what the RTO metric (modules/calc/shipments.ts) exists to
// count. Mapping it to UNKNOWN would exclude all 698 of them from the
// dispatched denominator and hide every RTO this store has.
const SHIPMENT_STATUS_MAP: Record<string, ShipmentStatus> = {
  delivered: "DELIVERED",
  failure: "RTO_INITIATED",
  in_transit: "IN_TRANSIT",
  out_for_delivery: "OUT_FOR_DELIVERY",
  // Still on the truck, at least one attempt behind it — an active state,
  // not a terminal one.
  attempted_delivery: "OUT_FOR_DELIVERY",
  confirmed: "NEW",
  label_printed: "NEW",
  label_purchased: "NEW",
  ready_for_pickup: "NEW",
  picked_up: "PICKED_UP",
};

interface RawFulfillmentLineItem {
  price?: string | number | null;
  quantity?: number | null;
}

interface RawFulfillment {
  id: number | string;
  status?: string | null; // success | cancelled | error | failure (fulfillment lifecycle, NOT tracking)
  shipment_status?: string | null; // courier tracking sub-status; null for ~65% here (Bluedart pushes none)
  tracking_company?: string | null;
  tracking_number?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  line_items?: RawFulfillmentLineItem[] | null;
}

function toPaise(amount: string | number | null | undefined): bigint {
  if (amount == null) return 0n;
  const n = typeof amount === "number" ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 100));
}

function mapStatus(f: RawFulfillment): ShipmentStatus {
  // The fulfillment lifecycle status outranks tracking: a cancelled
  // fulfillment is not in transit no matter what the last tracking ping said.
  if (f.status === "cancelled") return "CANCELLED";
  const tracking = f.shipment_status;
  if (!tracking) {
    // No tracking feed (this store: Bluedart, 13.6k fulfillments). The
    // fulfillment SUCCEEDED, which in Shopify means the parcel was handed
    // over — so it factually left the warehouse. PICKED_UP, not UNKNOWN:
    // UNKNOWN would drop most of the store's real dispatches from the RTO
    // denominator. What stays honestly unknowable from Shopify alone is the
    // OUTCOME (delivered vs RTO) for these — that needs the courier's own
    // statement, which is the CSV-import phase's job.
    return f.status === "success" ? "PICKED_UP" : "UNKNOWN";
  }
  return SHIPMENT_STATUS_MAP[tracking] ?? "UNKNOWN";
}

function fulfillmentValue(f: RawFulfillment): bigint {
  return (f.line_items ?? []).reduce((sum, li) => sum + toPaise(li.price) * BigInt(li.quantity ?? 0), 0n);
}

interface OrderForShipments {
  id: string;
  organizationId: string;
  legalEntityId: string;
  connectionId: string;
  grossAmount: bigint;
  paymentMode: string | null;
  raw: Prisma.JsonValue;
}

interface ShipmentRow {
  externalShipmentId: string;
  orderId: string;
  organizationId: string;
  legalEntityId: string;
  connectionId: string;
  awbCode: string | null;
  courierName: string | null;
  status: ShipmentStatus;
  codAmount: bigint | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  raw: RawFulfillment;
}

function mapOrderShipments(order: OrderForShipments, prepaidCapturedPaise: bigint): ShipmentRow[] {
  const raw = order.raw as { fulfillments?: RawFulfillment[] } | null;
  const fulfillments = raw?.fulfillments ?? [];
  if (fulfillments.length === 0) return [];

  // What the courier is supposed to collect at the door: the order total less
  // whatever was already captured ONLINE — including GoKwik PPCOD's ₹21–51
  // deposit, whose gateway name contains "PPCOD" but which is online money
  // (see gateways.ts). Only cash-at-door payments are excluded from the
  // subtraction: a COD order later "marked as paid" records a
  // "Cash on Delivery (COD)" transaction, and subtracting that would zero the
  // collectible for exactly the orders where the courier did collect.
  const isCod = order.paymentMode === "COD";
  const totalCod = isCod ? (order.grossAmount > prepaidCapturedPaise ? order.grossAmount - prepaidCapturedPaise : 0n) : null;

  // codAmount is split across LIVE fulfillments by their line value (2 orders
  // in 21k have a split shipment, but a wrong double-count is wrong forever).
  const live = fulfillments.filter((f) => f.status !== "cancelled");
  const liveValues = new Map(live.map((f) => [String(f.id), fulfillmentValue(f)]));
  const totalLiveValue = [...liveValues.values()].reduce((a, b) => a + b, 0n);

  let codAssigned = 0n;
  const rows: ShipmentRow[] = [];

  fulfillments.forEach((f, index) => {
    const status = mapStatus(f);
    const isLive = f.status !== "cancelled";

    let codAmount: bigint | null = null;
    if (totalCod !== null && isLive) {
      if (live.length === 1) {
        codAmount = totalCod;
      } else if (totalLiveValue > 0n) {
        codAmount = (totalCod * (liveValues.get(String(f.id)) ?? 0n)) / totalLiveValue;
      } else {
        // No line values to weight by — put it all on the first live one
        // rather than inventing an even split.
        codAmount = f === live[0] ? totalCod : 0n;
      }
      codAssigned += codAmount;
      // Integer division remainder lands on the last live fulfillment so the
      // shipments always sum exactly to the order's collectible.
      if (f === live[live.length - 1] && codAssigned !== totalCod) {
        codAmount += totalCod - codAssigned;
      }
    }

    rows.push({
      externalShipmentId: String(f.id ?? `${order.id}_${index}`),
      orderId: order.id,
      organizationId: order.organizationId,
      legalEntityId: order.legalEntityId,
      connectionId: order.connectionId,
      awbCode: f.tracking_number ?? null,
      courierName: f.tracking_company ?? null,
      status,
      codAmount,
      // Shopify has no separate pickup timestamp; fulfillment creation is the
      // handover to the courier, which is what "dispatched" means for the RTO
      // metric's bucketing.
      pickedUpAt: f.created_at ? new Date(f.created_at) : null,
      // Approximation, stated: updated_at is the record's last change, which
      // for a shipment whose CURRENT state is delivered is almost always the
      // delivery ping — couriers stop updating after delivery. Only set when
      // the status is actually DELIVERED.
      deliveredAt: status === "DELIVERED" && f.updated_at ? new Date(f.updated_at) : null,
      raw: f,
    });
  });

  return rows;
}

const PAGE_SIZE = 500;

export interface ShipmentSyncResult {
  ordersScanned: number;
  shipmentsUpserted: number;
}

// Upserts Shipment rows for every order (of this connection) whose stored
// payload carries fulfillments. `since` bounds it to orders updated after
// that instant — pull() passes its own start time so an incremental sync only
// reprocesses the orders it just wrote; the backfill script passes null.
// Idempotent: keyed on (connectionId, externalShipmentId) = Shopify's
// fulfillment id, so re-running converges instead of duplicating.
export async function syncShipmentsFromStoredOrders(
  connectionId: string,
  since: Date | null
): Promise<ShipmentSyncResult> {
  let cursor: string | null = null;
  let ordersScanned = 0;
  let shipmentsUpserted = 0;

  for (;;) {
    const orders: OrderForShipments[] = await prisma.order.findMany({
      where: {
        connectionId,
        ...(since ? { updatedAt: { gte: since } } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: {
        id: true,
        organizationId: true,
        legalEntityId: true,
        connectionId: true,
        grossAmount: true,
        paymentMode: true,
        raw: true,
      },
    });
    if (orders.length === 0) break;
    cursor = orders[orders.length - 1]!.id;
    ordersScanned += orders.length;

    // Captured ONLINE payments per order, for the PPCOD collectible. One
    // grouped query per page, filtered to non-COD gateways in code (the
    // gateway test is a regex set, not expressible in the where).
    const payments = await prisma.payment.findMany({
      where: { orderId: { in: orders.map((o) => o.id) }, ...capturedStatusFilter() },
      select: { orderId: true, amount: true, method: true },
    });
    const prepaidByOrder = new Map<string, bigint>();
    for (const p of payments) {
      if (!p.orderId || isCashAtDoorGateway(p.method)) continue;
      prepaidByOrder.set(p.orderId, (prepaidByOrder.get(p.orderId) ?? 0n) + p.amount);
    }

    const rows = orders.flatMap((o) => mapOrderShipments(o, prepaidByOrder.get(o.id) ?? 0n));
    if (rows.length === 0) continue;

    const values = rows.map(
      (r) =>
        Prisma.sql`(${crypto.randomUUID()}, ${r.organizationId}, ${r.legalEntityId}, ${r.connectionId}, ${r.externalShipmentId}, ${r.orderId}, ${r.awbCode}, ${r.courierName}, ${r.status}::"ShipmentStatus", ${r.codAmount}, ${r.pickedUpAt}, ${r.deliveredAt}, ${JSON.stringify(r.raw)}::jsonb, now(), now())`
    );
    await prisma.$executeRaw`
      INSERT INTO shipments (id, "organizationId", "legalEntityId", "connectionId", "externalShipmentId", "orderId", "awbCode", "courierName", status, "codAmount", "pickedUpAt", "deliveredAt", raw, "createdAt", "updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("connectionId", "externalShipmentId") DO UPDATE SET
        "orderId" = EXCLUDED."orderId",
        "awbCode" = EXCLUDED."awbCode",
        "courierName" = EXCLUDED."courierName",
        status = EXCLUDED.status,
        "codAmount" = EXCLUDED."codAmount",
        "pickedUpAt" = EXCLUDED."pickedUpAt",
        "deliveredAt" = EXCLUDED."deliveredAt",
        raw = EXCLUDED.raw,
        "updatedAt" = now()
    `;
    shipmentsUpserted += rows.length;
  }

  return { ordersScanned, shipmentsUpserted };
}
