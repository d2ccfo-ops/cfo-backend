import { resolveDateRange, shouldPersistSnapshot, type ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import type { ShipmentStatus } from "@prisma/client";

// RTO rate = shipments that came back to origin over shipments actually
// dispatched, for the period. This is the first metric computed from
// Shipment data (brought in by the Shiprocket connector) rather than
// Order/Payment — same "the calc engine, never the AI, does the arithmetic"
// rule as modules/calc/revenue.ts.

// v2: buckets by the real dispatch timestamp (Shipment.pickedUpAt, now
// populated from Shiprocket's pickup_date) instead of Shipment.createdAt,
// falling back to createdAt only where no real timestamp exists. This changes
// what the number means for any org whose shipments were ingested in a
// backfill — under v1 a year of history all landed in the month of the
// backfill — so it gets a new version rather than silently rewriting v1
// snapshots.
const FORMULA_VERSION = "v2";

// Everything that left the warehouse, whatever happened after — excludes
// NEW (not yet picked up), CANCELLED, and UNKNOWN (status we couldn't map,
// see modules/connectors/shiprocket's honesty caveat on field parsing).
const DISPATCHED_STATUSES: ShipmentStatus[] = [
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RTO_INITIATED",
  "RTO_DELIVERED",
  "LOST",
];
const RTO_STATUSES: ShipmentStatus[] = ["RTO_INITIATED", "RTO_DELIVERED"];

// Bucketed by when the parcel actually left the warehouse (pickedUpAt) where
// Shiprocket gave us that, falling back to Shipment.createdAt (when we first
// ingested the row) only for shipments that don't carry one — webhook-created
// rows, and anything from a provider that doesn't report a pickup timestamp.
// The fallback is why `dispatchedAtUnknownCount` is returned: a period whose
// count is mostly fallback rows is measuring ingestion, not dispatch.
function dispatchWindow(start: Date, end: Date) {
  return {
    OR: [
      { pickedUpAt: { gte: start, lte: end } },
      { pickedUpAt: null, createdAt: { gte: start, lte: end } },
    ],
  };
}

export async function getRtoRateSummary(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({})
) {
  const periodStart = range.from;
  const periodEnd = range.to;

  const [currentShipments, priorShipments] = await Promise.all([
    prisma.shipment.findMany({
      where: { organizationId, status: { in: DISPATCHED_STATUSES }, ...dispatchWindow(periodStart, periodEnd) },
      select: { status: true, pickedUpAt: true },
    }),
    prisma.shipment.findMany({
      where: {
        organizationId,
        status: { in: DISPATCHED_STATUSES },
        ...dispatchWindow(range.priorFrom, range.priorTo),
      },
      select: { status: true, pickedUpAt: true },
    }),
  ]);

  const dispatchedCount = currentShipments.length;
  const rtoCount = currentShipments.filter((s) => RTO_STATUSES.includes(s.status)).length;
  const dispatchedAtUnknownCount = currentShipments.filter((s) => s.pickedUpAt == null).length;
  const rtoRate = dispatchedCount === 0 ? null : Math.round((rtoCount / dispatchedCount) * 1000) / 10;

  const priorDispatchedCount = priorShipments.length;
  const priorRtoCount = priorShipments.filter((s) => RTO_STATUSES.includes(s.status)).length;
  const priorRtoRate = priorDispatchedCount === 0 ? null : Math.round((priorRtoCount / priorDispatchedCount) * 1000) / 10;

  const changePct = rtoRate == null || priorRtoRate == null ? null : Math.round((rtoRate - priorRtoRate) * 10) / 10;

  // Same manual findFirst+create/update as revenue.ts — Prisma can't
  // .upsert() against this compound key with legalEntityId: null.
  // Default period only (see shouldPersistSnapshot in lib/dateRange.ts).
  if (shouldPersistSnapshot(range)) {
    const existingSnapshot = await prisma.metricSnapshot.findFirst({
      where: {
        organizationId,
        legalEntityId: null,
        metricKey: "rto_rate_mtd",
        granularity: "MONTHLY",
        periodStart,
        formulaVersion: FORMULA_VERSION,
      },
      select: { id: true },
    });
    if (existingSnapshot) {
      await prisma.metricSnapshot.update({
        where: { id: existingSnapshot.id },
        data: { periodEnd, valueNumeric: rtoRate, computedAt: new Date() },
      });
    } else {
      await prisma.metricSnapshot.create({
        data: {
          organizationId,
          metricKey: "rto_rate_mtd",
          granularity: "MONTHLY",
          periodStart,
          periodEnd,
          valueNumeric: rtoRate,
          formulaVersion: FORMULA_VERSION,
          confidence: "ESTIMATED",
        },
      });
    }
  }

  return {
    metricKey: "rto_rate_mtd",
    rtoRatePct: rtoRate,
    priorRtoRatePct: priorRtoRate,
    changePct,
    dispatchedCount,
    rtoCount,
    // How many of dispatchedCount had no real dispatch timestamp and were
    // bucketed by ingestion time instead — surfaced rather than hidden so a
    // number built mostly on the fallback can be recognised as such.
    dispatchedAtUnknownCount,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    periodFiltered: true,
    comparison: range.comparison,
    formulaVersion: FORMULA_VERSION,
  };
}
