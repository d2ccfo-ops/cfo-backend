import type { ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { scopeWhere, type EntityScope } from "../../lib/entityScope.js";
import { paiseToRupees } from "./money.js";

// §14 state profitability (P6.1).
//
// WHERE THE STATE COMES FROM, AND WHY IT IS NOT A COLUMN. Order has no state
// field — the shipping address lives only in the raw provider payload. That is
// a deliberate consequence of §27 minimisation: an address is customer data,
// and promoting it to a first-class indexed column would spread it across
// every backup, export and replica for the sake of a chart.
//
// So the state is derived at read time, from raw, and NOTHING ELSE IS. No
// street, no pincode, no name — only the province, which is the one field this
// analysis needs and the one that identifies nobody.
//
// WHY THIS MATTERS FOR AN INDIAN D2C BRAND SPECIFICALLY: RTO is regional. A
// state with a 25% return rate and a state with 6% are different businesses
// sharing a catalogue, and the aggregate rate hides both. This is the one
// dimension where the average is actively misleading.

export const GEOGRAPHY_VERSION = "v1";

// Enough rows to be a fact rather than an anecdote. Below this a state's RTO
// rate is noise — one returned parcel out of three is 33%, and reporting that
// beside Maharashtra's 8% invites a decision nobody should make.
const MIN_ORDERS_FOR_RATE = 20;

/**
 * Pull the province out of a raw order payload.
 *
 * Falls back through the three places a provider might put it. Exported so a
 * test can assert the fallback order without a database — the order matters:
 * shipping is where the parcel went, billing is where the card is registered,
 * and the customer default is where they usually are. Only the first is the
 * question being asked.
 */
export function stateFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const candidates = [
    o.shipping_address,
    o.billing_address,
    (o.customer as Record<string, unknown> | undefined)?.default_address,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const addr = c as Record<string, unknown>;
    const province = addr.province ?? addr.province_code ?? addr.state;
    if (typeof province === "string" && province.trim().length > 0) return province.trim();
  }
  return null;
}

export interface StateRow {
  state: string;
  orders: number;
  netRevenue: number;
  netRevenueMinor: string;
  aov: number;
  /** Null below MIN_ORDERS_FOR_RATE — a rate off five orders is not a rate. */
  rtoRatePct: number | null;
  rtoOrders: number;
  cancelRatePct: number | null;
  codSharePct: number | null;
}

export interface StateProfitability {
  metricKey: "state_profitability";
  formulaVersion: string;
  period: { from: string; to: string };
  states: StateRow[];
  /** Orders whose payload carried no province at all. */
  unattributedOrders: number;
  coveragePct: number;
  minOrdersForRate: number;
  warnings: string[];
}

export async function getStateProfitability(
  organizationId: string,
  range: ResolvedRange,
  scope: EntityScope | null = null,
  limit = 25
): Promise<StateProfitability> {
  const orders = await prisma.order.findMany({
    where: { ...scopeWhere(organizationId, scope), placedAt: { gte: range.from, lte: range.to } },
    select: {
      id: true,
      grossAmount: true,
      taxAmount: true,
      refundedAmount: true,
      cancelledAt: true,
      paymentMode: true,
      raw: true,
    },
  });

  interface Acc {
    orders: number;
    netMinor: bigint;
    rto: number;
    cancelled: number;
    cod: number;
  }
  const byState = new Map<string, Acc>();
  let unattributed = 0;

  // Which orders came back. Read once rather than per state — a per-state
  // query would be 25 round trips for a chart.
  const rtoOrderIds = new Set(
    (
      await prisma.shipment.findMany({
        where: { organizationId, status: { in: ["RTO_INITIATED", "RTO_DELIVERED"] }, orderId: { not: null } },
        select: { orderId: true },
      })
    )
      .map((s) => s.orderId)
      .filter((id): id is string => id !== null)
  );

  for (const o of orders) {
    const state = stateFromRaw(o.raw);
    if (!state) {
      unattributed += 1;
      continue;
    }
    const acc = byState.get(state) ?? { orders: 0, netMinor: 0n, rto: 0, cancelled: 0, cod: 0 };
    acc.orders += 1;
    // Net of tax and refunds, matching the §11 ladder's definition rather than
    // inventing a third one — a state chart that disagrees with the revenue
    // page about total revenue is worse than no state chart.
    if (!o.cancelledAt) acc.netMinor += o.grossAmount - o.taxAmount - o.refundedAmount;
    if (o.cancelledAt) acc.cancelled += 1;
    if (rtoOrderIds.has(o.id)) acc.rto += 1;
    if ((o.paymentMode ?? "").toUpperCase() === "COD") acc.cod += 1;
    byState.set(state, acc);
  }

  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

  const states: StateRow[] = [...byState.entries()]
    .map(([state, a]) => ({
      state,
      orders: a.orders,
      netRevenue: paiseToRupees(a.netMinor),
      netRevenueMinor: a.netMinor.toString(),
      aov: a.orders === 0 ? 0 : paiseToRupees(a.netMinor / BigInt(a.orders)),
      // Null, not zero, below the threshold. A state with three orders and one
      // return is not a 33% RTO state, and printing that beside Maharashtra's
      // real rate invites a decision nobody should make.
      rtoRatePct: a.orders >= MIN_ORDERS_FOR_RATE ? pct(a.rto, a.orders) : null,
      rtoOrders: a.rto,
      cancelRatePct: a.orders >= MIN_ORDERS_FOR_RATE ? pct(a.cancelled, a.orders) : null,
      codSharePct: a.orders >= MIN_ORDERS_FOR_RATE ? pct(a.cod, a.orders) : null,
    }))
    .sort((a, b) => (BigInt(b.netRevenueMinor) > BigInt(a.netRevenueMinor) ? 1 : -1))
    .slice(0, limit);

  const warnings: string[] = [];
  const attributed = orders.length - unattributed;
  const coveragePct = orders.length === 0 ? 0 : Math.round((attributed / orders.length) * 1000) / 10;
  if (unattributed > 0) {
    warnings.push(
      `${unattributed} of ${orders.length} orders carry no shipping state and are excluded entirely — they are not spread across the states below, so these totals do not sum to net revenue.`
    );
  }
  if (states.some((s) => s.rtoRatePct === null)) {
    warnings.push(
      `States with fewer than ${MIN_ORDERS_FOR_RATE} orders show no rate. A rate off a handful of orders is noise, and printing it beside a real one invites a decision nobody should make.`
    );
  }

  return {
    metricKey: "state_profitability",
    formulaVersion: GEOGRAPHY_VERSION,
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    states,
    unattributedOrders: unattributed,
    coveragePct,
    minOrdersForRate: MIN_ORDERS_FOR_RATE,
    warnings,
  };
}
