import { prisma } from "../../lib/prisma.js";
import { capturedStatusFilter } from "../calc/paymentStatus.js";

// P6.3 — manual match pairing (§15).
//
// The engine matches on order reference, then on amount and date. What it
// cannot do is recognise the cases a person can: a customer who paid for two
// orders in one transfer, a capture booked under a mistyped reference, a
// refund-and-recapture that left the amounts looking nothing alike.
//
// Those orders sit unmatched forever, and "unmatched" on the reconciliation
// page reads as missing money. Someone eventually reconciles them in a
// spreadsheet — the outcome this product exists to prevent.
//
// WHY THIS IS NOT A WRITE-OFF, AND TAKES NO APPROVAL
// -------------------------------------------------
// A write-off asserts money will never arrive; it removes a receivable, so it
// crosses the §22 materiality gate. A pairing asserts money already arrived and
// names the transfer it came in. Neither cash received nor revenue moves —
// both are computed from orders and payments directly — so the pairing only
// decides what the reconciliation page SAYS. Lower stakes, audit rather than
// approval.
//
// WHAT IT REFUSES
// ---------------
// One payment cannot settle two orders. Allowing it would let the same rupees
// mark two receivables as collected, and nothing would look wrong: no total
// sums the matches, so the error would stay invisible until someone chased a
// customer who had already paid.
//
// THE ORDERING RULE THIS DEPENDS ON
// ---------------------------------
// Both readers of reconciliation_matches order by `confidence = 'MANUAL'` DESC
// before createdAt DESC. Without that, the next nightly run could create a row
// for a different payment and silently overrule a human decision — the person
// who paired it would see their work undone with nothing to indicate it had
// happened.

/** How far either side of the order date to look for a candidate payment. */
export const PAIR_WINDOW_DAYS = 45;

export type PairFailure =
  | { ok: false; reason: "order_not_found" }
  | { ok: false; reason: "payment_not_found" }
  | { ok: false; reason: "payment_already_matched"; conflictingOrderId: string; conflictingOrderRef: string | null };

export type PairSuccess = {
  ok: true;
  matchId: string;
  differencePaise: bigint;
};

export type PairResult = PairSuccess | PairFailure;

export interface PairCandidate {
  id: string;
  externalPaymentId: string | null;
  amountPaise: bigint;
  differencePaise: bigint;
  capturedAt: Date | null;
  method: string | null;
}

/**
 * Payments that could plausibly belong to this order.
 *
 * The window is wide on purpose. The reason a row needs manual pairing at all
 * is that the obvious signals did not line up, so a narrow window would exclude
 * exactly the payments worth showing.
 */
export async function getPairCandidates(organizationId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, organizationId },
    select: { id: true, grossAmount: true, placedAt: true, externalOrderId: true },
  });
  if (!order) return null;

  const from = new Date(order.placedAt.getTime() - PAIR_WINDOW_DAYS * 86_400_000);
  const to = new Date(order.placedAt.getTime() + PAIR_WINDOW_DAYS * 86_400_000);

  const rows = await prisma.payment.findMany({
    where: {
      organizationId,
      ...capturedStatusFilter(),
      capturedAt: { gte: from, lte: to },
      // A payment already carrying a different order's id is that order's
      // money. Excluded here rather than shown and refused on submit —
      // offering a choice that cannot be made is worse than not offering it.
      OR: [{ orderId: null }, { orderId: order.id }],
    },
    select: { id: true, externalPaymentId: true, amount: true, capturedAt: true, method: true },
    orderBy: { capturedAt: "desc" },
    take: 50,
  });

  // Also exclude anything another order has already been PAIRED to, which is a
  // different fact from Payment.orderId — a manual pairing does not rewrite the
  // payment row.
  const claimed = await prisma.reconciliationMatch.findMany({
    where: {
      organizationId,
      matchType: "ORDER_PAYMENT",
      targetType: "PAYMENT",
      targetId: { in: rows.map((r) => r.id) },
      sourceId: { not: orderId },
    },
    select: { targetId: true },
  });
  const claimedIds = new Set(claimed.map((c) => c.targetId));

  const candidates: PairCandidate[] = rows
    .filter((r) => !claimedIds.has(r.id))
    .map((r) => ({
      id: r.id,
      externalPaymentId: r.externalPaymentId,
      amountPaise: r.amount,
      // Stated rather than left for the caller to compute, so a UI cannot
      // round it into agreement.
      differencePaise: r.amount - order.grossAmount,
      capturedAt: r.capturedAt,
      method: r.method,
    }));

  return { order, windowDays: PAIR_WINDOW_DAYS, candidates };
}

export async function pairOrderToPayment(
  organizationId: string,
  orderId: string,
  paymentId: string,
  note: string | null,
  userId: string
): Promise<PairResult> {
  // Both sides scoped to the org in the WHERE. An id from another tenant reads
  // as "not found", never as something actionable.
  const [order, payment] = await Promise.all([
    prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: { id: true, grossAmount: true, externalOrderId: true },
    }),
    prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
      select: { id: true, amount: true, externalPaymentId: true },
    }),
  ]);
  if (!order) return { ok: false, reason: "order_not_found" };
  if (!payment) return { ok: false, reason: "payment_not_found" };

  // THE REFUSAL THAT MATTERS.
  const claimed = await prisma.reconciliationMatch.findFirst({
    where: {
      organizationId,
      matchType: "ORDER_PAYMENT",
      targetType: "PAYMENT",
      targetId: paymentId,
      sourceId: { not: orderId },
    },
    select: { sourceId: true },
  });
  if (claimed) {
    const other = await prisma.order.findUnique({
      where: { id: claimed.sourceId },
      select: { externalOrderId: true },
    });
    return {
      ok: false,
      reason: "payment_already_matched",
      conflictingOrderId: claimed.sourceId,
      conflictingOrderRef: other?.externalOrderId ?? null,
    };
  }

  const delta = order.grossAmount - payment.amount;
  const abs = delta < 0n ? -delta : delta;

  // Replace, do not stack. Leaving the engine's row behind would mean two rows
  // for one order, and which one wins would depend on the reader.
  const match = await prisma.$transaction(async (tx) => {
    await tx.reconciliationMatch.deleteMany({
      where: { organizationId, matchType: "ORDER_PAYMENT", sourceType: "ORDER", sourceId: orderId },
    });
    const created = await tx.reconciliationMatch.create({
      data: {
        organizationId,
        matchType: "ORDER_PAYMENT",
        confidence: "MANUAL",
        sourceType: "ORDER",
        sourceId: orderId,
        targetType: "PAYMENT",
        targetId: paymentId,
        amountDeltaAbs: abs,
        status: "MATCHED",
        note,
        resolvedBy: userId,
        resolvedAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId,
        actorType: "USER",
        actorId: userId,
        action: "reconciliation.pair",
        entityType: "ORDER",
        entityId: orderId,
        // The amounts as they stood at the moment of the decision, so the trail
        // answers "was this a reasonable pairing" and not merely "did it
        // happen". Re-deriving them later would read today's data, not the
        // data the person was looking at.
        metadata: {
          paymentId,
          externalPaymentId: payment.externalPaymentId,
          orderAmountPaise: order.grossAmount.toString(),
          paymentAmountPaise: payment.amount.toString(),
          differencePaise: delta.toString(),
          note,
        },
      },
    });
    return created;
  });

  return { ok: true, matchId: match.id, differencePaise: delta };
}

export async function unpairOrder(
  organizationId: string,
  orderId: string,
  userId: string
): Promise<{ unpaired: boolean }> {
  const { count } = await prisma.reconciliationMatch.deleteMany({
    where: {
      organizationId,
      matchType: "ORDER_PAYMENT",
      sourceType: "ORDER",
      sourceId: orderId,
      confidence: "MANUAL",
      // A write-off is also MANUAL but carries a null target; it is undone by
      // /restore, and deleting it here would remove the decision without the
      // audit trail that path writes.
      targetId: { not: null },
    },
  });
  if (count === 0) return { unpaired: false };

  await prisma.auditLog.create({
    data: {
      organizationId,
      actorType: "USER",
      actorId: userId,
      action: "reconciliation.unpair",
      entityType: "ORDER",
      entityId: orderId,
    },
  });
  return { unpaired: true };
}
