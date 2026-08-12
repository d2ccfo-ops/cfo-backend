import type { ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import type { OrgSettings } from "../orgs/settings.js";

// §23–§25 fulfilment cost layers (P6.5) — packaging, the forward/reverse
// freight split, and what an RTO actually costs.
//
// ---------------------------------------------------------------------------
// THE DOUBLE-COUNTING TRAP THIS MODULE EXISTS TO AVOID
// ---------------------------------------------------------------------------
// `Shipment.freightAmount` is the SUM of every invoice line for that AWB — both
// directions. applyInvoice() sets it that way deliberately (an RTO that cost
// freight twice must read as twice the cost), and contribution.ts has always
// used it as "forward shipping" because reverse freight had no source and the
// distinction did not exist.
//
// It does now. Return legs are billed as their own rows, so summing
// freightAmount for forward shipping AND return-leg rows for reverse shipping
// would count every return twice — inflating cost, understating margin, and
// doing it in a way that looks entirely reasonable on the page.
//
// So forward freight is derived by SUBTRACTION: total billed minus the return
// legs. Not by re-summing non-return rows, because Shiprocket also writes
// freightAmount from its API and produces no invoice lines at all; a re-sum
// would silently drop every Shiprocket-billed shipment from the forward layer.
//
// ---------------------------------------------------------------------------
// WHY RTO COST IS A MEMO AND NOT A DEDUCTION
// ---------------------------------------------------------------------------
// §36's CM1 lists packaging, forward shipping, reverse shipping and RTO cost as
// four deductions. Taken literally that is wrong: the freight on a returned
// parcel is already inside the forward and reverse layers, so deducting an
// "RTO cost" built from the same freight subtracts it a second time.
//
// What a founder actually wants from that line is not a fourth deduction — it
// is the ANSWER to "what do returns cost me", gathered from costs already
// counted. So it is reported as a memo: measured, shown, explicitly not
// subtracted again. A number that is honest about which question it answers is
// worth more than one that keeps the formula looking symmetrical.

/**
 * How long after dispatch a courier invoice is expected.
 *
 * Couriers bill monthly in arrears, so a parcel shipped last week has no
 * invoice yet and that is the billing cycle, not a missing upload. Without
 * this distinction the forward-shipping layer can NEVER be covered for any
 * org that is still trading — the current month's shipments always lack an
 * invoice — and CM1 stays permanently unreliable for a reason nobody can act
 * on. 45 days covers a monthly cycle plus the fortnight it takes to arrive.
 */
const INVOICE_EXPECTED_AFTER_DAYS = 45;

export interface FreightSplit {
  /** Outbound freight: total billed minus return legs. */
  forwardMinor: bigint;
  /** Return-leg freight — the only place reverse shipping is ever stated. */
  reverseMinor: bigint;
  /** Shipments in the period that carry any freight at all. */
  billedShipments: number;
  /**
   * Billable shipments that carry freight.
   *
   * Kept separate from billedShipments because a courier can invoice sooner
   * than the cutoff assumes, which made the numerator exceed the denominator
   * and print "6089 of 5300 billable shipments" — a coverage line that reads
   * as a bug whatever the arithmetic behind it is doing.
   */
  billedBillableShipments: number;
  totalShipments: number;
  /**
   * Shipments a courier could actually bill for: dispatched (they have a
   * waybill) and old enough that an invoice should have arrived.
   *
   * A shipment with no AWB was never handed over, so no courier can have
   * charged for it. Counting it as missing freight reports a gap that cannot
   * be closed.
   */
  billableShipments: number;
  /** Dispatched, but too recent for an invoice. Reported, not counted a gap. */
  awaitingInvoice: number;
  /** Never dispatched — no waybill, so nothing to bill. */
  neverDispatched: number;
  /** Shipments with a return leg billed against them. */
  returnedShipments: number;
  /** True when a return-leg source exists at all (an invoice has been uploaded). */
  hasReverseSource: boolean;
}

export async function getFreightSplit(organizationId: string, range: ResolvedRange): Promise<FreightSplit> {
  const shipments = await prisma.shipment.findMany({
    where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
    select: { id: true, freightAmount: true, awbCode: true, pickedUpAt: true, createdAt: true },
  });

  const invoiceCutoff = new Date(Date.now() - INVOICE_EXPECTED_AFTER_DAYS * 86_400_000);
  // Dispatched = it has a waybill. Nothing else is a claim about whether a
  // courier COULD have billed us.
  const dispatched = shipments.filter((s) => s.awbCode !== null);
  const billable = dispatched.filter((s) => (s.pickedUpAt ?? s.createdAt) < invoiceCutoff);
  const awaitingInvoice = dispatched.length - billable.length;

  const billed = shipments.filter((s) => s.freightAmount !== null);
  const totalBilled = billed.reduce((sum, s) => sum + (s.freightAmount as bigint), 0n);

  // Return legs for exactly these shipments. Resolved through shipmentId rather
  // than AWB — a line the courier billed for a parcel we never shipped has no
  // shipmentId, and it must not be attributed to this period's fulfilment cost
  // just because its ship date happens to fall inside the window.
  const reverseRows = await prisma.freightInvoiceLine.groupBy({
    by: ["shipmentId"],
    where: {
      organizationId,
      isReturnLeg: true,
      shipmentId: { in: billed.map((s) => s.id) },
    },
    _sum: { amount: true },
  });

  const reverseMinor = reverseRows.reduce((sum, r) => sum + (r._sum.amount ?? 0n), 0n);

  // Does a reverse source exist at all in this org? Distinct from "this period
  // had no returns" — one means the layer cannot be measured, the other means
  // it was measured as zero, and telling a founder the wrong one sends them to
  // fix the wrong thing.
  const anyReturnLeg = await prisma.freightInvoiceLine.count({ where: { organizationId, isReturnLeg: true } });

  return {
    forwardMinor: totalBilled - reverseMinor,
    reverseMinor,
    billedShipments: billed.length,
    billedBillableShipments: billable.filter((s) => s.freightAmount !== null).length,
    totalShipments: shipments.length,
    billableShipments: billable.length,
    awaitingInvoice,
    neverDispatched: shipments.length - dispatched.length,
    returnedShipments: reverseRows.length,
    hasReverseSource: anyReturnLeg > 0,
  };
}

export interface PackagingCost {
  amountMinor: bigint;
  configured: boolean;
  orders: number;
  items: number;
  perOrderPaise: bigint;
  perItemPaise: bigint;
}

/**
 * Packaging from the org's configured rate.
 *
 * Pure over its inputs so the arithmetic can be tested without a database —
 * the whole layer is two multiplications, and the thing worth asserting is that
 * an unconfigured org yields `configured: false` rather than a confident zero.
 */
export function computePackaging(
  settings: OrgSettings,
  orders: number,
  items: number
): PackagingCost {
  const cfg = settings.packagingCost;
  if (!cfg) {
    return { amountMinor: 0n, configured: false, orders, items, perOrderPaise: 0n, perItemPaise: 0n };
  }
  const perOrder = BigInt(cfg.perOrderPaise);
  const perItem = BigInt(cfg.perItemPaise);
  return {
    amountMinor: perOrder * BigInt(orders) + perItem * BigInt(items),
    configured: true,
    orders,
    items,
    perOrderPaise: perOrder,
    perItemPaise: perItem,
  };
}

export interface RtoCost {
  /** Freight already counted in the forward and reverse layers, for RTO parcels. */
  freightMinor: bigint;
  /** Packaging consumed on parcels that came back — not recoverable. */
  packagingMinor: bigint;
  totalMinor: bigint;
  rtoShipments: number;
  totalShipments: number;
  ratePct: number | null;
  measurable: boolean;
}

/**
 * What returns cost, gathered from costs already deducted elsewhere.
 *
 * Reported, never subtracted — see the module header. The freight here is the
 * same freight inside forwardMinor/reverseMinor; presenting it as a fourth
 * deduction would charge it twice.
 */
export async function getRtoCost(
  organizationId: string,
  range: ResolvedRange,
  packaging: PackagingCost
): Promise<RtoCost> {
  const shipments = await prisma.shipment.findMany({
    where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
    select: { id: true, status: true, freightAmount: true },
  });

  const rto = shipments.filter((s) => s.status === "RTO_INITIATED" || s.status === "RTO_DELIVERED");
  const freightMinor = rto.reduce((sum, s) => sum + (s.freightAmount ?? 0n), 0n);

  // One parcel's worth of packaging per returned parcel. The per-ITEM component
  // is deliberately excluded: this function does not know how many items were
  // in each returned parcel, and multiplying by an average would be inventing a
  // number to fill a column. The mailer is the part that is certainly gone.
  const packagingMinor = packaging.configured ? packaging.perOrderPaise * BigInt(rto.length) : 0n;

  return {
    freightMinor,
    packagingMinor,
    totalMinor: freightMinor + packagingMinor,
    rtoShipments: rto.length,
    totalShipments: shipments.length,
    ratePct: shipments.length === 0 ? null : Math.round((rto.length / shipments.length) * 1000) / 10,
    // Measurable when the RTO parcels carry freight. Without it the count is
    // real but the cost is not, and a returns-cost line that is really just a
    // count wearing a rupee sign is worse than an empty one.
    measurable: rto.length > 0 && rto.some((s) => s.freightAmount !== null),
  };
}

// ---------------------------------------------------------------------------
// Transaction-cost layers (§27–§30)
// ---------------------------------------------------------------------------

/**
 * Providers whose payments are marketplace settlements rather than gateway
 * captures.
 *
 * Listed as what IS a marketplace rather than what is not: a gateway added
 * tomorrow must not silently start counting as marketplace fees, whereas a
 * marketplace added tomorrow is a deliberate edit here.
 */
export const MARKETPLACE_PROVIDERS = ["AMAZON", "FLIPKART"] as const;

export interface TransactionFees {
  gatewayMinor: bigint;
  gatewayPayments: number;
  gatewayWithFee: number;
  marketplaceMinor: bigint;
  marketplacePayments: number;
  marketplaceWithFee: number;
  codMinor: bigint;
  codLines: number;
  /** True when any COD remittance statement has been imported for this org. */
  hasCodSource: boolean;
  /** COD orders placed in this period — the cash that should have a statement. */
  codOrders: number;
  /**
   * Whether this period's COD charges are actually known.
   *
   * NOT the same as hasCodSource. An org that uploaded one remittance statement
   * last March has a source; it does not thereby know what COD cost it in
   * August. Reporting ₹0 as measured for a period full of COD sales whose
   * statement was never uploaded is the exact false-confidence this layer was
   * rebuilt to remove — so a period with COD orders and no remittance lines is
   * uncovered, not zero.
   */
  codCovered: boolean;
}

export async function getTransactionFees(organizationId: string, range: ResolvedRange): Promise<TransactionFees> {
  // Payment carries connectionId but no `connection` relation, so which
  // provider produced a payment is resolved through the connection table first.
  // One query rather than a join — an org has a handful of connections and
  // tens of thousands of payments.
  const marketplaceConnections = await prisma.connection.findMany({
    where: { organizationId, provider: { in: [...MARKETPLACE_PROVIDERS] } },
    select: { id: true },
  });
  const marketplaceIds = new Set(marketplaceConnections.map((c) => c.id));

  const [payments, codAgg, codSourceCount, codOrders] = await Promise.all([
    prisma.payment.findMany({
      where: { organizationId, capturedAt: { gte: range.from, lte: range.to } },
      select: { feeAmount: true, connectionId: true },
    }),
    // COD collection charges — the courier's cut for handling cash, stated in
    // the remittance statement's fee column and nowhere else. This is the fee a
    // brand pays for the privilege of COD and has never been visible.
    prisma.settlementLine.aggregate({
      where: {
        organizationId,
        type: "SHIPMENT_COD",
        settlement: { settledAt: { gte: range.from, lte: range.to } },
      },
      _sum: { feeAmount: true },
      _count: true,
    }),
    prisma.settlementLine.count({ where: { organizationId, type: "SHIPMENT_COD" } }),
    prisma.order.count({
      where: { organizationId, placedAt: { gte: range.from, lte: range.to }, paymentMode: "COD", cancelledAt: null },
    }),
  ]);

  const isMarketplace = (p: (typeof payments)[number]) => marketplaceIds.has(p.connectionId);

  const marketplace = payments.filter(isMarketplace);
  // Everything that is not a marketplace settlement is a gateway capture. This
  // split is the fix for a real double count: gateway fees used to sum EVERY
  // payment's feeAmount, so the moment marketplace fees landed on Payment the
  // same rupee would have been deducted as both a gateway fee and a marketplace
  // fee — CM2 too low, and no warning anywhere.
  const gateway = payments.filter((p) => !isMarketplace(p));

  const sumFees = (rows: typeof payments) => rows.reduce((s, p) => s + (p.feeAmount ?? 0n), 0n);

  return {
    gatewayMinor: sumFees(gateway),
    gatewayPayments: gateway.length,
    gatewayWithFee: gateway.filter((p) => p.feeAmount !== null).length,
    marketplaceMinor: sumFees(marketplace),
    marketplacePayments: marketplace.length,
    marketplaceWithFee: marketplace.filter((p) => p.feeAmount !== null).length,
    codMinor: codAgg._sum.feeAmount ?? 0n,
    codLines: codAgg._count,
    hasCodSource: codSourceCount > 0,
    codOrders,
    // Measured zero only when there was no COD to charge for. Otherwise a
    // statement is missing and the layer must say so.
    codCovered: codAgg._count > 0 || codOrders === 0,
  };
}
