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

/**
 * How long after capture a gateway payout is expected.
 *
 * Exactly the same problem as INVOICE_EXPECTED_AFTER_DAYS, one layer down. A
 * gateway states its fee on the payout, and payouts run on a T+2 to T+7 cycle
 * depending on the rail and the merchant's risk tier — so a capture from this
 * morning has no fee stated anywhere, and never will until the payout lands.
 *
 * Without this the gateway layer could never be covered for a trading org: the
 * most recent few days of captures always lack a payout, so "8,371 of 8,406
 * carry a fee" read as a permanent failure rather than as thirty-five sales
 * that simply have not settled yet.
 *
 * 10 days is deliberately past the slowest ordinary cycle. A capture older than
 * that with no payout is a real gap — that is the `slow_settlement` exception,
 * and it must keep surfacing rather than being absorbed here.
 */
const PAYOUT_EXPECTED_AFTER_DAYS = 10;

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
  /** Dispatched under a waybill another shipment also carries, so freight cannot be split between them. */
  ambiguousAwb: number;
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

  // AN AWB SHARED BY TWO SHIPMENTS CANNOT BE BILLED TO BOTH.
  //
  // A waybill identifies one parcel to the courier, so two Shipment rows
  // carrying the same AWB are the same parcel recorded twice — an ingest
  // artefact, not two deliveries. applyInvoice() resolves the invoice line by
  // AWB and lands every rupee on whichever row it matched, leaving the other
  // with null freight forever.
  //
  // Counted apart rather than as a gap, because there is no upload that closes
  // it: the courier billed the parcel exactly once and we hold two rows for it.
  // Leaving them in the denominator meant "19,340 of 19,342" — a layer stuck one
  // rounding error short of covered, for a reason no invoice could fix. The
  // duplicate itself is worth surfacing, which is what naming it in the note
  // does; silently absorbing it is what this must not do.
  const awbCounts = new Map<string, number>();
  for (const s of dispatched) awbCounts.set(s.awbCode!, (awbCounts.get(s.awbCode!) ?? 0) + 1);
  const unambiguous = dispatched.filter((s) => awbCounts.get(s.awbCode!) === 1);
  const ambiguousAwb = dispatched.length - unambiguous.length;

  const billable = unambiguous.filter((s) => (s.pickedUpAt ?? s.createdAt) < invoiceCutoff);
  const awaitingInvoice = unambiguous.length - billable.length;

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
    ambiguousAwb,
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

/**
 * The Order.channel values those providers sell through — the demand side of
 * the same fact. Separate from MARKETPLACE_PROVIDERS because a Connection's
 * provider is an enum and a channel is a lowercase string written by whichever
 * connector created the order; conflating them silently matches nothing.
 */
export const MARKETPLACE_CHANNELS = ["amazon", "flipkart"] as const;

export interface TransactionFees {
  gatewayMinor: bigint;
  gatewayPayments: number;
  gatewayWithFee: number;
  /** Captures old enough that a payout should have arrived — the coverage denominator. */
  gatewaySettleablePayments: number;
  /** Of those, how many have a fee from either source. */
  gatewaySettleableWithFee: number;
  /** Captures too recent to have settled. Reported, never counted as missing. */
  gatewayAwaitingPayout: number;
  /**
   * Of the covered gateway payments, how many got their fee from a settlement
   * line rather than the payment record. Reported rather than hidden: a fee
   * known only from a payout is known LATER than one stated at capture, so a
   * recent period can look uncovered purely because the payout has not arrived.
   */
  gatewayFeeFromSettlement: number;
  marketplaceMinor: bigint;
  marketplacePayments: number;
  marketplaceWithFee: number;
  /** Marketplace orders placed in this period — the sales a referral fee is owed on. */
  marketplaceOrders: number;
  /**
   * Whether this period's marketplace fees are actually known.
   *
   * False when the brand sold on a marketplace and no settlement states the
   * fee. True when it sold on none — Amazon cannot have charged a referral fee
   * on a sale that did not happen, so ₹0 there is measured, not assumed.
   */
  marketplaceCovered: boolean;
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

  const [payments, settledFees, codAgg, codSourceCount, codOrders, marketplaceOrders] = await Promise.all([
    prisma.payment.findMany({
      where: { organizationId, capturedAt: { gte: range.from, lte: range.to } },
      select: { id: true, feeAmount: true, connectionId: true, capturedAt: true },
    }),
    // THE SECOND PLACE A GATEWAY FEE IS STATED, and for several providers the
    // ONLY place. Razorpay's payments API returns `fee` per capture, so those
    // land on Payment.feeAmount. GoKwik does not — it states the MDR on the
    // settlement line when the payout is composed, days later. Reading only
    // Payment.feeAmount meant every GoKwik-settled org reported ₹0 gateway
    // fees, and reported it as an uncovered layer with no way to ever cover it.
    prisma.settlementLine.findMany({
      where: {
        organizationId,
        type: "PAYMENT",
        paymentId: { not: null },
        settlement: { settledAt: { gte: range.from, lte: range.to } },
      },
      select: { paymentId: true, feeAmount: true },
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
    // Marketplace orders placed in this period — the sales that should have a
    // referral fee against them. Same role codOrders plays: it separates "this
    // brand does not sell on Amazon" from "this brand sells on Amazon and the
    // connector is not attached".
    prisma.order.count({
      where: {
        organizationId,
        placedAt: { gte: range.from, lte: range.to },
        channel: { in: [...MARKETPLACE_CHANNELS] },
        cancelledAt: null,
      },
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

  // A payout may state a fee on more than one line for the same capture (a
  // partial settlement, or a fee reversal booked separately), so lines are
  // summed per payment rather than last-one-wins.
  //
  // WHY > 0 AND NOT >= 0. SettlementLine.feeAmount is `BigInt @default(0)`, so
  // a line from a file with NO fee column is stored identically to one stating
  // a genuine zero. Treating zero as "stated" would mark every such payment
  // covered and report ₹0 gateway fees as measured — the precise false
  // confidence this layer exists to prevent.
  //
  // This errs the other way, and that is deliberate but not free: an org on
  // genuinely zero-MDR rails (UPI at some PSPs) has a real ₹0 that will keep
  // reading as uncovered. A warning that cannot be cleared is a worse user
  // experience than one that can; a margin overstated by an unstated fee is a
  // worse ERROR. Fixing it properly means the parser recording whether the
  // column was present, which is a schema change, not a calc change.
  const settledFeeByPayment = new Map<string, bigint>();
  for (const l of settledFees) {
    if (!l.paymentId || l.feeAmount <= 0n) continue;
    settledFeeByPayment.set(l.paymentId, (settledFeeByPayment.get(l.paymentId) ?? 0n) + l.feeAmount);
  }

  // RESOLUTION, NOT ADDITION. Both sources describe the SAME rupee — the MDR on
  // one capture. An org connected to both Razorpay and GoKwik would have the
  // fee stated twice, and adding them would double the gateway layer with
  // nothing throwing. The payment's own figure wins because it is the
  // provider's primary record; the payout line fills in only where there is
  // none.
  const feeOf = (p: (typeof payments)[number]) => p.feeAmount ?? settledFeeByPayment.get(p.id) ?? null;
  const sumFees = (rows: typeof payments) => rows.reduce((s, p) => s + (feeOf(p) ?? 0n), 0n);

  // Captures old enough that a payout should have arrived. A newer one lacking
  // a fee is the settlement cycle, not a missing source — see
  // PAYOUT_EXPECTED_AFTER_DAYS.
  const payoutDue = new Date(Date.now() - PAYOUT_EXPECTED_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const settleable = gateway.filter((p) => p.capturedAt !== null && p.capturedAt < payoutDue);

  return {
    gatewayMinor: sumFees(gateway),
    gatewayPayments: gateway.length,
    gatewayWithFee: gateway.filter((p) => feeOf(p) !== null).length,
    gatewaySettleablePayments: settleable.length,
    gatewaySettleableWithFee: settleable.filter((p) => feeOf(p) !== null).length,
    gatewayAwaitingPayout: gateway.length - settleable.length,
    gatewayFeeFromSettlement: gateway.filter((p) => p.feeAmount === null && settledFeeByPayment.has(p.id)).length,
    marketplaceMinor: sumFees(marketplace),
    marketplacePayments: marketplace.length,
    marketplaceWithFee: marketplace.filter((p) => feeOf(p) !== null).length,
    marketplaceOrders,
    // Measured zero only when there was no marketplace sale to charge a
    // referral fee on — the same rule codCovered follows, and it was missing
    // here. A D2C-only brand was reported as having a cost layer with no data
    // source forever: a warning naming Amazon fees to a brand that has never
    // sold on Amazon, and a completeness score it could not raise by supplying
    // anything. A brand that DOES sell on a marketplace and has no settlement
    // still reads as uncovered, which is the case the flag exists for.
    marketplaceCovered:
      marketplaceOrders === 0 || (marketplace.length > 0 && marketplace.every((p) => feeOf(p) !== null)),
    codMinor: codAgg._sum.feeAmount ?? 0n,
    codLines: codAgg._count,
    hasCodSource: codSourceCount > 0,
    codOrders,
    // Measured zero only when there was no COD to charge for. Otherwise a
    // statement is missing and the layer must say so.
    codCovered: codAgg._count > 0 || codOrders === 0,
  };
}
