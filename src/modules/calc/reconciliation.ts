import { MatchConfidence, MatchStatus, MatchType, Prisma, type ShipmentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { CARRIER_SQL } from "../connectors/courier.js";
import { isCashAtDoorGateway } from "../connectors/shopify/gateways.js";

// Reconciliation — §110's trust layer applied to money movement.
//
// The question this answers is not "how much did we sell" (revenueLadder.ts
// already answers that exactly) but "did the money actually arrive". Those are
// different failure modes: a gateway can hold a settlement, a courier can lose
// a COD remittance, a marketplace can deduct a fee nobody agreed to. None of
// them change revenue, and all of them change the bank balance.
//
// The chain, and what carries it:
//
//   Order ──ORDER_PAYMENT──▶ Payment ──PAYMENT_SETTLEMENT──▶ Settlement
//                                                                 │
//                                                        SETTLEMENT_BANK
//                                                                 ▼
//                                                         BankTransaction
//
//   Shipment (COD) ─────────COD_REMITTANCE────────────────▶ BankTransaction
//
// A COD order does not travel the top path at all. On this store 72% of orders
// are COD, so treating "no gateway payment" as a failure would report 35,614
// broken orders that were never supposed to have one. That distinction is the
// single most important thing this file gets right.

export const RECONCILIATION_VERSION = "v1";

// How far apart two records may sit in time and still be considered the same
// money. Deliberately tight: a wider window buys more matches at the cost of
// matching the wrong ones, and a wrong match in reconciliation is worse than
// no match — an exception gets looked at, a false match never does.
const ORDER_PAYMENT_WINDOW_DAYS = 3;
const SETTLEMENT_BANK_WINDOW_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

// A difference this small or smaller is rounding between two systems, not a
// discrepancy worth a human's attention. Anything larger is surfaced for
// review even when the pairing itself is certain.
export const AMOUNT_TOLERANCE_PAISE = 100n; // ₹1

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

// Why a leg produced what it produced. `unavailable` is a first-class outcome,
// not an error: three of the four legs need a data source this org may simply
// not have connected, and saying so is more useful than reporting 0 matches
// and letting the reader assume everything failed.
export type LegState = "ran" | "unavailable";

export interface LegOutcome {
  matchType: MatchType;
  state: LegState;
  /** Present when state is "unavailable" — what is missing, in plain words. */
  blockedReason?: string;
  /** Sources the leg was responsible for. */
  eligible: number;
  matched: number;
  /** Matched, but with a money difference above AMOUNT_TOLERANCE_PAISE. */
  needsReview: number;
  unmatched: number;
  matchedValue: bigint;
  unmatchedValue: bigint;
}

export interface ReconciliationRunResult {
  version: string;
  ranAt: Date;
  durationMs: number;
  legs: LegOutcome[];
  created: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Order references travel between systems with decoration — "#AW-1042",
// "aw-1042 ", "AW1042". Normalising to a comparable core is what makes a
// merchant-configured Razorpay note joinable to a Shopify order at all.
function normaliseRef(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function withinDays(a: Date, b: Date, days: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= days * DAY_MS;
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

// Razorpay carries the merchant's own order reference in `notes` (a free-form
// key/value bag the Shopify↔Razorpay integration populates) and sometimes in
// `receipt`. Which key it uses is merchant-specific, so every string value is
// harvested rather than guessing at `notes.shopify_order_id`.
function candidateRefs(raw: Prisma.JsonValue | null): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const out: string[] = [];

  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim().length > 0) out.push(normaliseRef(v));
    else if (typeof v === "number") out.push(normaliseRef(String(v)));
  };

  push(obj.receipt);
  const notes = obj.notes;
  if (notes && typeof notes === "object" && !Array.isArray(notes)) {
    for (const v of Object.values(notes as Record<string, unknown>)) push(v);
  }
  return out;
}

// A pairing the engine decided on, before it is written.
interface PendingMatch {
  matchType: MatchType;
  confidence: MatchConfidence;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  amountDeltaAbs: bigint;
}

// Exact amount + a date window, resolved ONLY when exactly one candidate
// survives. Ambiguity is deliberately left unmatched: two payments of the same
// value on the same day is precisely the case where a machine guess is a
// coin flip, and an exception a human resolves is the correct outcome.
function uniqueByAmountAndDate<T extends { id: string; amount: bigint; at: Date }>(
  index: Map<string, T[]>,
  amount: bigint,
  at: Date,
  windowDays: number,
  used: Set<string>
): T | null {
  const bucket = index.get(amount.toString());
  if (!bucket) return null;

  let found: T | null = null;
  for (const candidate of bucket) {
    if (used.has(candidate.id)) continue;
    if (!withinDays(candidate.at, at, windowDays)) continue;
    if (found) return null; // ambiguous — leave it for a human
    found = candidate;
  }
  return found;
}

function indexByAmount<T extends { amount: bigint }>(items: T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const key = item.amount.toString();
    const bucket = index.get(key);
    if (bucket) bucket.push(item);
    else index.set(key, [item]);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Leg: ORDER → PAYMENT
// ---------------------------------------------------------------------------

async function runOrderPaymentLeg(organizationId: string, pending: PendingMatch[]): Promise<LegOutcome> {
  // Only orders that are SUPPOSED to have a gateway payment. Excluding COD is
  // not an optimisation — a COD order has no gateway payment by definition,
  // and counting its absence as a discrepancy would make the metric describe
  // the payment mix rather than anything about reconciliation.
  //
  // Cancelled orders are excluded from the denominator too (§16): no revenue
  // is recognised, so no payment is expected. A cancelled order that WAS paid
  // can still match below — it simply isn't counted as a failure if it doesn't.
  const orders = await prisma.order.findMany({
    where: { organizationId, paymentMode: { not: "COD" }, cancelledAt: null },
    select: { id: true, externalOrderId: true, orderNumber: true, grossAmount: true, placedAt: true },
    orderBy: { placedAt: "asc" },
  });

  const payments = await prisma.payment.findMany({
    where: {
      organizationId,
      // An authorised-but-uncaptured payment has moved no money yet, and a
      // failed one never will. Neither settles an order.
      status: { in: ["captured", "CAPTURED", "processed", "PROCESSED", "paid", "PAID"] },
    },
    select: { id: true, orderId: true, amount: true, capturedAt: true, createdAt: true, raw: true },
  });

  const leg: LegOutcome = {
    matchType: MatchType.ORDER_PAYMENT,
    state: payments.length === 0 ? "unavailable" : "ran",
    eligible: orders.length,
    matched: 0,
    needsReview: 0,
    unmatched: orders.length,
    matchedValue: 0n,
    unmatchedValue: orders.reduce((sum, o) => sum + o.grossAmount, 0n),
  };

  if (payments.length === 0) {
    leg.blockedReason =
      "No payment-gateway connection has produced any captured payments yet. Prepaid orders cannot be traced to money received until one is connected.";
    return leg;
  }

  // Sources and targets already paired by an earlier run (or by a human) are
  // fixed: re-running must not re-decide them, and must not hand the same
  // payment to a second order.
  const existing = await prisma.reconciliationMatch.findMany({
    where: { organizationId, matchType: MatchType.ORDER_PAYMENT },
    select: { sourceId: true, targetId: true, amountDeltaAbs: true, status: true },
  });
  const settledSources = new Set(existing.map((m) => m.sourceId));
  const usedTargets = new Set(existing.map((m) => m.targetId).filter((v): v is string => v !== null));

  const record = (orderId: string, paymentId: string, delta: bigint, confidence: MatchConfidence) => {
    pending.push({
      matchType: MatchType.ORDER_PAYMENT,
      confidence,
      sourceType: "ORDER",
      sourceId: orderId,
      targetType: "PAYMENT",
      targetId: paymentId,
      amountDeltaAbs: delta,
    });
    usedTargets.add(paymentId);
    settledSources.add(orderId);
  };

  const paymentAt = (p: { capturedAt: Date | null; createdAt: Date }) => p.capturedAt ?? p.createdAt;

  // --- Pass 1: a real key. -------------------------------------------------
  // Either the FK (no connector sets it today, but the column exists and a
  // future one should) or the merchant's own order reference carried in the
  // gateway's notes. This is the only pass that can be called certain.
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // ref -> order id, or null meaning "this reference is ambiguous, never use it".
  //
  // The collision that matters is between DIFFERENT orders, not between the
  // two references of the SAME order: externalOrderId "1001" and orderNumber
  // "#1001" both normalise to "1001", so a naive has()-then-poison check
  // silently disables reference matching for every order in the store.
  const orderByRef = new Map<string, string | null>();
  for (const o of orders) {
    for (const ref of [o.externalOrderId, o.orderNumber]) {
      const key = normaliseRef(ref);
      if (key.length === 0) continue;
      const seen = orderByRef.get(key);
      if (seen === undefined) orderByRef.set(key, o.id);
      else if (seen !== o.id) orderByRef.set(key, null);
    }
  }

  const unkeyed: typeof payments = [];
  for (const p of payments) {
    if (usedTargets.has(p.id)) continue;

    // A payment with an order FK that is NOT in the eligible set belongs to a
    // known order that is COD or cancelled — the Shopify transactions pull
    // attaches an orderId to every payment, including a COD order "marked as
    // paid". Such a payment must be consumed HERE, never released into the
    // amount-and-date pool below, where it could pair with an unrelated
    // prepaid order that happens to share a value and a day. Its own order's
    // reconciliation happens elsewhere (COD leg / cancellation handling).
    if (p.orderId && !orderById.has(p.orderId)) continue;

    let order = p.orderId ? orderById.get(p.orderId) : undefined;
    if (!order) {
      for (const ref of candidateRefs(p.raw)) {
        const orderId = orderByRef.get(ref);
        if (orderId) {
          order = orderById.get(orderId);
          break;
        }
      }
    }

    if (order && !settledSources.has(order.id)) {
      record(order.id, p.id, abs(order.grossAmount - p.amount), MatchConfidence.HIGH);
    } else if (!order) {
      unkeyed.push(p);
    }
  }

  // --- Pass 2: exact amount inside a date window, only when unambiguous. ---
  const paymentIndex = indexByAmount(
    unkeyed.map((p) => ({ id: p.id, amount: p.amount, at: paymentAt(p) }))
  );
  for (const o of orders) {
    if (settledSources.has(o.id)) continue;
    const hit = uniqueByAmountAndDate(paymentIndex, o.grossAmount, o.placedAt, ORDER_PAYMENT_WINDOW_DAYS, usedTargets);
    if (hit) record(o.id, hit.id, abs(o.grossAmount - hit.amount), MatchConfidence.MEDIUM);
  }

  return summariseLeg(leg, orders, pending, existing);
}

// ---------------------------------------------------------------------------
// Leg: SETTLEMENT → BANK
// ---------------------------------------------------------------------------

async function runSettlementBankLeg(organizationId: string, pending: PendingMatch[]): Promise<LegOutcome> {
  const settlements = await prisma.settlement.findMany({
    where: { organizationId },
    select: { id: true, amount: true, utr: true, settledAt: true, createdAt: true },
  });

  const credits = await prisma.bankTransaction.findMany({
    where: { organizationId, direction: "CREDIT" },
    select: { id: true, amount: true, utr: true, description: true, valueDate: true },
  });

  const leg: LegOutcome = {
    matchType: MatchType.SETTLEMENT_BANK,
    state: "ran",
    eligible: settlements.length,
    matched: 0,
    needsReview: 0,
    unmatched: settlements.length,
    matchedValue: 0n,
    unmatchedValue: settlements.reduce((sum, s) => sum + s.amount, 0n),
  };

  if (settlements.length === 0 || credits.length === 0) {
    leg.state = "unavailable";
    leg.blockedReason =
      settlements.length === 0
        ? "No settlement records. A payment-gateway or marketplace connection supplies these."
        : "No bank credits to match against. Connect a bank account or upload a statement.";
    return leg;
  }

  const existing = await prisma.reconciliationMatch.findMany({
    where: { organizationId, matchType: MatchType.SETTLEMENT_BANK },
    select: { sourceId: true, targetId: true, amountDeltaAbs: true, status: true },
  });
  const settledSources = new Set(existing.map((m) => m.sourceId));
  const usedTargets = new Set(existing.map((m) => m.targetId).filter((v): v is string => v !== null));

  const record = (settlementId: string, bankId: string, delta: bigint, confidence: MatchConfidence) => {
    pending.push({
      matchType: MatchType.SETTLEMENT_BANK,
      confidence,
      sourceType: "SETTLEMENT",
      sourceId: settlementId,
      targetType: "BANK_TRANSACTION",
      targetId: bankId,
      amountDeltaAbs: delta,
    });
    usedTargets.add(bankId);
    settledSources.add(settlementId);
  };

  // --- Pass 1: UTR. --------------------------------------------------------
  // The UTR is the RBI-issued identifier for the actual transfer, so a match
  // on it is the strongest evidence available anywhere in this file. Banks
  // frequently bury it inside the narration instead of exposing it as a field,
  // so the description is searched too.
  const creditsByUtr = new Map<string, string>();
  for (const c of credits) {
    if (c.utr) creditsByUtr.set(normaliseRef(c.utr), c.id);
  }

  for (const s of settlements) {
    if (settledSources.has(s.id) || !s.utr) continue;
    const utr = normaliseRef(s.utr);
    if (utr.length < 8) continue; // too short to be a UTR; matching on it would be noise

    let bankId = creditsByUtr.get(utr);
    if (!bankId) {
      const buried = credits.find((c) => !usedTargets.has(c.id) && c.description && normaliseRef(c.description).includes(utr));
      bankId = buried?.id;
    }
    if (!bankId || usedTargets.has(bankId)) continue;

    const credit = credits.find((c) => c.id === bankId)!;
    record(s.id, bankId, abs(s.amount - credit.amount), MatchConfidence.HIGH);
  }

  // --- Pass 2: exact amount inside a date window, only when unambiguous. ---
  const creditIndex = indexByAmount(
    credits.filter((c) => !usedTargets.has(c.id)).map((c) => ({ id: c.id, amount: c.amount, at: c.valueDate }))
  );
  for (const s of settlements) {
    if (settledSources.has(s.id)) continue;
    const at = s.settledAt ?? s.createdAt;
    const hit = uniqueByAmountAndDate(creditIndex, s.amount, at, SETTLEMENT_BANK_WINDOW_DAYS, usedTargets);
    if (hit) record(s.id, hit.id, abs(s.amount - hit.amount), MatchConfidence.MEDIUM);
  }

  return summariseLeg(leg, settlements.map((s) => ({ id: s.id, grossAmount: s.amount })), pending, existing);
}

// ---------------------------------------------------------------------------
// Legs with no key available
// ---------------------------------------------------------------------------

// PAYMENT → SETTLEMENT needs Razorpay's settlement-recon report
// (/settlements/recon/combined), which states which payments composed a
// payout. The connector doesn't pull it, and nothing else carries the link:
// the payments API returns no settlement id, and inferring the grouping from
// amounts alone is subset-sum over thousands of rows — not merely expensive
// but genuinely ambiguous, since many different payment sets total the same
// payout. Guessing here would manufacture false confidence, so it reports the
// gap instead.
// PAYMENT → SETTLEMENT, from the gateway's own settlement report.
//
// This used to be permanently `unavailable`, and the stated reason was exact:
// "payout composition cannot be inferred from amounts without guessing". That
// is still true — what changed is that the composition no longer has to be
// inferred. A settlement statement states which payments are in which payout,
// and SettlementLine stores that statement. So this leg does not match anything;
// it RECORDS what the provider already told us, which is why every match it
// creates is HIGH confidence rather than a scored guess.
async function runPaymentSettlementLeg(
  organizationId: string,
  pending: PendingMatch[]
): Promise<LegOutcome> {
  const [payments, lines] = await Promise.all([
    prisma.payment.findMany({
      where: { organizationId, status: "captured" },
      select: { id: true, amount: true },
    }),
    prisma.settlementLine.findMany({
      where: { organizationId, type: "PAYMENT", paymentId: { not: null } },
      select: { paymentId: true, settlementId: true, grossAmount: true },
    }),
  ]);

  const base: LegOutcome = {
    matchType: MatchType.PAYMENT_SETTLEMENT,
    state: "ran",
    eligible: payments.length,
    matched: 0,
    needsReview: 0,
    unmatched: payments.length,
    matchedValue: 0n,
    unmatchedValue: 0n,
  };

  if (lines.length === 0) {
    const settlements = await prisma.settlement.count({ where: { organizationId, kind: "GATEWAY" } });
    return {
      ...base,
      state: "unavailable",
      blockedReason:
        payments === undefined || payments.length === 0
          ? "No payments recorded yet, so there is nothing to trace into a settlement."
          : settlements === 0
            ? "Payments exist, but no settlement records do — a gateway settlement statement (CSV export or API) is the missing source."
            : "Settlements exist but carry no line items, so which payments each payout contains is still unknown. Import the gateway's settlement recon report.",
      unmatchedValue: payments.reduce((a, p) => a + p.amount, 0n),
    };
  }

  const amountById = new Map(payments.map((p) => [p.id, p.amount]));
  for (const line of lines) {
    const paymentId = line.paymentId!;
    const stated = amountById.get(paymentId);
    // A line naming a payment we do not hold is a real finding, not a match —
    // it means the gateway settled something this system never ingested.
    if (stated === undefined) continue;
    pending.push({
      matchType: MatchType.PAYMENT_SETTLEMENT,
      confidence: MatchConfidence.HIGH,
      sourceType: "PAYMENT",
      sourceId: paymentId,
      targetType: "SETTLEMENT",
      targetId: line.settlementId,
      amountDeltaAbs: stated > line.grossAmount ? stated - line.grossAmount : line.grossAmount - stated,
    });
  }

  const existing = await prisma.reconciliationMatch.findMany({
    where: { organizationId, matchType: MatchType.PAYMENT_SETTLEMENT },
    select: { sourceId: true, amountDeltaAbs: true, status: true },
  });
  return summariseLeg(
    base,
    payments.map((p) => ({ id: p.id, grossAmount: p.amount })),
    pending,
    existing
  );
}

// §15 leg 6 — Refund ↔ the settlement line that carries the money back out.
//
// This leg could not exist before P2.3a-pre. Refunds were a cumulative
// per-order total with no date and no id, and matching needs discrete records
// on both sides; the Refund table is that record.
//
// Two passes, in confidence order, and the order matters. An id match is
// something the gateway TOLD us, so it is HIGH and taken first. An
// amount-and-date match is something this engine INFERRED, so it is MEDIUM,
// and it only ever runs against what the first pass left over — otherwise a
// coincidental ₹1,240 could claim a line whose id names a different refund
// entirely.
//
// Both directions are findings, which is the whole point of the leg:
//   - our refund with no settlement line  → the store believes it returned
//     money the gateway has no record of returning
//   - a settlement refund line with no refund of ours → money left against an
//     order this system never saw refunded: a chargeback, or a refund issued
//     straight from the gateway dashboard. Invisible everywhere else in the
//     product.
const REFUND_MATCH_WINDOW_DAYS = 10;

async function runRefundPaymentLeg(organizationId: string, pending: PendingMatch[]): Promise<LegOutcome> {
  const [refunds, lines] = await Promise.all([
    prisma.refund.findMany({
      where: { organizationId },
      select: { id: true, amount: true, processedAt: true, gatewayRef: true },
      orderBy: { processedAt: "asc" },
    }),
    // Refunds arrive as ADJUSTMENT lines: a settlement's PAYMENT lines are
    // captures, and money going back out is not one. Negative-net lines are
    // the refunds and fee deductions inside a payout — see the Razorpay recon
    // mapping in connectors/razorpay, where netAmount = credit − debit.
    prisma.settlementLine.findMany({
      where: { organizationId, type: "ADJUSTMENT" },
      select: { id: true, settlementId: true, externalReference: true, grossAmount: true, netAmount: true },
    }),
  ]);

  const totalRefundValue = refunds.reduce((a, r) => a + r.amount, 0n);
  const base: LegOutcome = {
    matchType: MatchType.REFUND_PAYMENT,
    state: "ran",
    eligible: refunds.length,
    matched: 0,
    needsReview: 0,
    unmatched: refunds.length,
    matchedValue: 0n,
    unmatchedValue: totalRefundValue,
  };

  if (refunds.length === 0) {
    return {
      ...base,
      state: "unavailable",
      blockedReason:
        "No refunds recorded yet. Refunds arrive with Shopify orders — if the store has issued some, run scripts/backfillRefunds.ts to read them out of stored payloads.",
    };
  }
  if (lines.length === 0) {
    const settlements = await prisma.settlement.count({ where: { organizationId, kind: "GATEWAY" } });
    return {
      ...base,
      state: "unavailable",
      blockedReason:
        settlements === 0
          ? "Refunds exist, but no gateway settlement records do — the settlement statement that would show the money leaving is the missing source."
          : "Settlements exist but carry no adjustment lines, so the refunds inside each payout are not itemised. Import the gateway's settlement recon report.",
    };
  }

  // Only outgoing lines. A positive adjustment is money coming IN (a reversal,
  // a recovery) and can never be the counterpart of a refund; including them
  // would let an inbound ₹1,240 satisfy an outbound ₹1,240.
  const outgoing = lines.filter((l) => l.netAmount < 0n || l.grossAmount < 0n);
  const absOf = (l: (typeof outgoing)[number]) => {
    const v = l.netAmount !== 0n ? l.netAmount : l.grossAmount;
    return v < 0n ? -v : v;
  };

  const claimed = new Set<string>();

  // --- Pass 1: the gateway named it.
  const byReference = new Map<string, typeof outgoing>();
  for (const l of outgoing) {
    const list = byReference.get(l.externalReference) ?? [];
    list.push(l);
    byReference.set(l.externalReference, list);
  }
  const matchedRefundIds = new Set<string>();
  for (const refund of refunds) {
    if (!refund.gatewayRef) continue;
    const candidates = (byReference.get(refund.gatewayRef) ?? []).filter((l) => !claimed.has(l.id));
    const line = candidates[0];
    if (!line) continue;
    claimed.add(line.id);
    matchedRefundIds.add(refund.id);
    const stated = absOf(line);
    pending.push({
      matchType: MatchType.REFUND_PAYMENT,
      confidence: MatchConfidence.HIGH,
      sourceType: "REFUND",
      sourceId: refund.id,
      targetType: "SETTLEMENT_LINE",
      targetId: line.id,
      amountDeltaAbs: refund.amount > stated ? refund.amount - stated : stated - refund.amount,
    });
  }

  // --- Pass 2: exact amount inside a date window, over what pass 1 left.
  //
  // Exact amount only. A refund is a specific figure the gateway passes
  // through unchanged — unlike a payout, nothing is netted off it — so a
  // tolerance here would not absorb rounding, it would let two different
  // refunds of similar size claim each other's lines.
  const windowMs = REFUND_MATCH_WINDOW_DAYS * 86_400_000;
  const remaining = outgoing.filter((l) => !claimed.has(l.id));
  const byAmount = new Map<string, typeof remaining>();
  for (const l of remaining) {
    const key = absOf(l).toString();
    const list = byAmount.get(key) ?? [];
    list.push(l);
    byAmount.set(key, list);
  }
  // Settled-at is needed for the window; fetched once for the lines that could
  // still match rather than joined into the query above, which would pull a
  // settlement row per line for the majority that pass 1 already resolved.
  const settlementIds = [...new Set(remaining.map((l) => l.settlementId))];
  const settledAt = new Map(
    (
      await prisma.settlement.findMany({
        where: { id: { in: settlementIds } },
        select: { id: true, settledAt: true, createdAt: true },
      })
    ).map((s) => [s.id, s.settledAt ?? s.createdAt])
  );

  for (const refund of refunds) {
    if (matchedRefundIds.has(refund.id)) continue;
    const candidates = (byAmount.get(refund.amount.toString()) ?? []).filter((l) => !claimed.has(l.id));
    // Nearest in time wins when several are eligible. Two identical refunds a
    // month apart should each take the payout beside them, not whichever the
    // query happened to return first.
    let best: (typeof remaining)[number] | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const l of candidates) {
      const when = settledAt.get(l.settlementId);
      if (!when) continue;
      const gap = Math.abs(when.getTime() - refund.processedAt.getTime());
      if (gap <= windowMs && gap < bestGap) {
        best = l;
        bestGap = gap;
      }
    }
    if (!best) continue;
    claimed.add(best.id);
    matchedRefundIds.add(refund.id);
    pending.push({
      matchType: MatchType.REFUND_PAYMENT,
      confidence: MatchConfidence.MEDIUM,
      sourceType: "REFUND",
      sourceId: refund.id,
      targetType: "SETTLEMENT_LINE",
      targetId: best.id,
      // Zero by construction — the pass matches on exact equality. Stated
      // explicitly rather than left implicit so a future tolerance change
      // cannot silently start reporting these as clean.
      amountDeltaAbs: 0n,
    });
  }

  const existing = await prisma.reconciliationMatch.findMany({
    where: { organizationId, matchType: MatchType.REFUND_PAYMENT },
    select: { sourceId: true, amountDeltaAbs: true, status: true },
  });
  return summariseLeg(
    base,
    refunds.map((r) => ({ id: r.id, grossAmount: r.amount })),
    pending,
    existing
  );
}

// COD → BANK is a batch relationship, not a pairing: a courier remits many
// delivered shipments in one transfer. Resolving it needs the courier's COD
// remittance statement (Shiprocket and Delhivery both expose one; neither
// connector pulls it yet). What IS computable without it — how much COD has
// been delivered and is therefore owed to the business — is reported by
// getCodExposure() below rather than pretended to be a match.
async function runCodRemittanceLeg(
  organizationId: string,
  pending: PendingMatch[]
): Promise<LegOutcome> {
  const [delivered, lines] = await Promise.all([
    prisma.shipment.findMany({
      where: { organizationId, status: "DELIVERED", codAmount: { gt: 0 } },
      select: { id: true, codAmount: true },
    }),
    prisma.settlementLine.findMany({
      where: { organizationId, type: "SHIPMENT_COD", shipmentId: { not: null } },
      select: { shipmentId: true, settlementId: true, grossAmount: true },
    }),
  ]);

  const base: LegOutcome = {
    matchType: MatchType.COD_REMITTANCE,
    state: "ran",
    eligible: delivered.length,
    matched: 0,
    needsReview: 0,
    unmatched: delivered.length,
    matchedValue: 0n,
    unmatchedValue: 0n,
  };

  if (lines.length === 0) {
    return {
      ...base,
      state: "unavailable",
      blockedReason:
        delivered.length === 0
          ? "No delivered COD shipments. A courier connection (Shiprocket, Delhivery, ClickPost, Bluedart) supplies these."
          : "Delivered COD shipments exist, but no remittance statement has been imported — couriers remit many shipments in one transfer, so individual shipments cannot be tied to a bank credit without it. Import a Bluedart COD MIS or a GoKwik settlement report.",
      unmatchedValue: delivered.reduce((a, s) => a + (s.codAmount ?? 0n), 0n),
    };
  }

  const codById = new Map(delivered.map((s) => [s.id, s.codAmount ?? 0n]));
  for (const line of lines) {
    const shipmentId = line.shipmentId!;
    const stated = codById.get(shipmentId);
    // Remitted for a shipment we do not have as delivered COD — either the
    // courier remitted an RTO, or our delivery status is stale. Left unmatched
    // so it surfaces rather than being absorbed.
    if (stated === undefined) continue;
    pending.push({
      matchType: MatchType.COD_REMITTANCE,
      confidence: MatchConfidence.HIGH,
      sourceType: "SHIPMENT",
      sourceId: shipmentId,
      targetType: "SETTLEMENT",
      targetId: line.settlementId,
      amountDeltaAbs: stated > line.grossAmount ? stated - line.grossAmount : line.grossAmount - stated,
    });
  }

  const existing = await prisma.reconciliationMatch.findMany({
    where: { organizationId, matchType: MatchType.COD_REMITTANCE },
    select: { sourceId: true, amountDeltaAbs: true, status: true },
  });
  return summariseLeg(
    base,
    delivered.map((s) => ({ id: s.id, grossAmount: s.codAmount ?? 0n })),
    pending,
    existing
  );
}

// ---------------------------------------------------------------------------
// Summary arithmetic shared by the legs that actually run
// ---------------------------------------------------------------------------

function summariseLeg(
  leg: LegOutcome,
  sources: { id: string; grossAmount: bigint }[],
  pending: PendingMatch[],
  existing: { sourceId: string; amountDeltaAbs: bigint; status: MatchStatus }[]
): LegOutcome {
  const valueById = new Map(sources.map((s) => [s.id, s.grossAmount]));

  const deltaBySource = new Map<string, bigint>();
  for (const m of existing) {
    if (m.status === MatchStatus.EXCEPTION) continue;
    deltaBySource.set(m.sourceId, m.amountDeltaAbs);
  }
  for (const m of pending) {
    if (m.matchType !== leg.matchType) continue;
    deltaBySource.set(m.sourceId, m.amountDeltaAbs);
  }

  let matched = 0;
  let needsReview = 0;
  let matchedValue = 0n;

  for (const [sourceId, delta] of deltaBySource) {
    const value = valueById.get(sourceId);
    if (value === undefined) continue; // matched source is outside this leg's current eligible set
    matched += 1;
    matchedValue += value;
    if (delta > AMOUNT_TOLERANCE_PAISE) needsReview += 1;
  }

  const totalValue = sources.reduce((sum, s) => sum + s.grossAmount, 0n);
  return {
    ...leg,
    matched,
    needsReview,
    unmatched: sources.length - matched,
    matchedValue,
    unmatchedValue: totalValue - matchedValue,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shipment ↔ freight invoice line
// ---------------------------------------------------------------------------
// The only leg that reconciles a COST. Every other leg asks "did money we are
// owed arrive"; this one asks "is money we were charged for something we
// actually did".
//
// Both directions are findings, and they are different findings:
//
//   shipment with no invoice line — freight not yet billed, or an invoice we
//     have not uploaded. Understates cost, so margin currently reads too high.
//   invoice line with no shipment — the courier billed for a parcel this system
//     has no record of. Real money, leaving, for something unverifiable. There
//     is nowhere else in the product this would ever surface.
//
// Eligible is scoped to carriers we hold at least one invoice for. Counting
// DTDC parcels as "unreconciled freight" when no DTDC invoice has ever been
// uploaded would describe which invoices the merchant happens to own rather
// than anything about their freight.
async function runShipmentFreightLeg(organizationId: string, pending: PendingMatch[]): Promise<LegOutcome> {
  const carriers = await prisma.freightInvoice.findMany({
    where: { organizationId },
    select: { carrier: true },
    distinct: ["carrier"],
  });
  const slugs = carriers.map((c) => c.carrier);

  const leg: LegOutcome = {
    matchType: MatchType.SHIPMENT_FREIGHT,
    state: "unavailable",
    eligible: 0,
    matched: 0,
    needsReview: 0,
    unmatched: 0,
    matchedValue: 0n,
    unmatchedValue: 0n,
  };

  if (slugs.length === 0) {
    leg.blockedReason =
      "No courier freight invoice has been uploaded yet, so what shipping actually cost is unknown. Upload a Bluedart tax invoice PDF on the Connections page.";
    return leg;
  }

  const eligible = await prisma.$queryRaw<Array<{ id: string; awb: string }>>(Prisma.sql`
    SELECT id, "awbCode" AS awb
    FROM shipments
    WHERE "organizationId" = ${organizationId}
      AND "awbCode" IS NOT NULL
      AND ${Prisma.raw(CARRIER_SQL)} IN (${Prisma.join(slugs)})`);

  leg.eligible = eligible.length;
  leg.unmatched = eligible.length;
  if (eligible.length === 0) {
    leg.blockedReason = "Freight invoices are imported, but no shipment carries a waybill from those carriers.";
    return leg;
  }

  const lines = await prisma.freightInvoiceLine.findMany({
    where: { organizationId, shipmentId: { not: null } },
    select: { id: true, shipmentId: true, amount: true },
  });

  if (lines.length === 0) {
    leg.blockedReason =
      "Freight invoices are imported, but none of their waybills matched a shipment — the invoices may cover a different store or period.";
    return leg;
  }

  // A shipment legitimately carries more than one line: outbound plus the
  // return leg of an RTO. Every pair is recorded, so no billed line is left
  // unaccounted for, while the leg counts SHIPMENTS (the LEFT JOIN LATERAL in
  // aggregateLeg takes one row per source).
  const byShipment = new Map<string, bigint>();
  for (const line of lines) {
    pending.push({
      matchType: MatchType.SHIPMENT_FREIGHT,
      confidence: MatchConfidence.HIGH,
      sourceType: "SHIPMENT",
      sourceId: line.shipmentId!,
      targetType: "FREIGHT_INVOICE_LINE",
      targetId: line.id,
      // Nothing to compare against: an invoice line IS the charge, so there is
      // no independent expected amount to differ from. Left at zero rather than
      // invented, which is why needsReview is always 0 on this leg.
      amountDeltaAbs: 0n,
    });
    byShipment.set(line.shipmentId!, (byShipment.get(line.shipmentId!) ?? 0n) + line.amount);
  }

  const eligibleIds = new Set(eligible.map((e) => e.id));
  let matched = 0;
  let matchedValue = 0n;
  for (const [shipmentId, amount] of byShipment) {
    if (!eligibleIds.has(shipmentId)) continue;
    matched += 1;
    matchedValue += amount;
  }

  leg.state = "ran";
  leg.matched = matched;
  leg.unmatched = eligible.length - matched;
  leg.matchedValue = matchedValue;
  // Deliberately zero, not a guess. What an unbilled shipment WILL cost is
  // unknown until its invoice arrives, and extrapolating from an average would
  // put a number on this card that no document supports.
  leg.unmatchedValue = 0n;
  return leg;
}

export async function runReconciliation(organizationId: string): Promise<ReconciliationRunResult> {
  const startedAt = Date.now();
  const pending: PendingMatch[] = [];

  // Sequential, not Promise.all: the legs share the reconciliation_matches
  // table and each reads what earlier ones wrote conceptually. They also each
  // hold a result set in memory, and running them one at a time keeps the peak
  // bounded by the largest leg rather than their sum.
  const orderPayment = await runOrderPaymentLeg(organizationId, pending);
  const settlementBank = await runSettlementBankLeg(organizationId, pending);
  const paymentSettlement = await runPaymentSettlementLeg(organizationId, pending);
  const codRemittance = await runCodRemittanceLeg(organizationId, pending);
  const shipmentFreight = await runShipmentFreightLeg(organizationId, pending);
  // Runs after the settlement legs: it reads SettlementLine rows, and running
  // it before them would work but would read a table nothing in this pass had
  // touched yet — the ordering states the dependency rather than leaving it to
  // be rediscovered.
  const refundPayment = await runRefundPaymentLeg(organizationId, pending);

  let created = 0;
  if (pending.length > 0) {
    // skipDuplicates against the recon_pair unique index is what makes a
    // re-run idempotent: the engine is a pure function of the current tables,
    // so the same pass must converge on the same rows rather than accumulate.
    const result = await prisma.reconciliationMatch.createMany({
      data: pending.map((m) => ({ organizationId, ...m, status: MatchStatus.MATCHED })),
      skipDuplicates: true,
    });
    created = result.count;
  }

  return {
    version: RECONCILIATION_VERSION,
    ranAt: new Date(),
    durationMs: Date.now() - startedAt,
    legs: [orderPayment, paymentSettlement, settlementBank, codRemittance, refundPayment, shipmentFreight],
    created,
  };
}

// ---------------------------------------------------------------------------
// Reading the chain without re-running it
// ---------------------------------------------------------------------------
// runReconciliation() WRITES. A dashboard that renders the chain must not, so
// this derives the same four legs from what is already stored. It existed
// nowhere before, which is why the chain card only appeared after a reader
// pressed "Run" and vanished on reload — the work was done and invisible.
//
// Aggregated in SQL rather than by loading rows: the run can afford to hold
// 25k orders in memory once, a page load hit on every visit cannot.
interface LegAggregate {
  eligible: number;
  eligible_value: bigint | null;
  matched: number;
  matched_value: bigint | null;
  needs_review: number;
}

async function aggregateLeg(
  organizationId: string,
  matchType: MatchType,
  sourceType: string,
  sourceSql: Prisma.Sql
): Promise<LegAggregate> {
  const rows = await prisma.$queryRaw<LegAggregate[]>(Prisma.sql`
    SELECT count(*)::int                                        AS eligible,
           coalesce(sum(s.value), 0)::bigint                     AS eligible_value,
           count(m.id)::int                                      AS matched,
           coalesce(sum(s.value) FILTER (WHERE m.id IS NOT NULL), 0)::bigint AS matched_value,
           count(*) FILTER (WHERE m."amountDeltaAbs" > ${AMOUNT_TOLERANCE_PAISE})::int AS needs_review
    FROM (${sourceSql}) s
    LEFT JOIN LATERAL (
      SELECT rm.id, rm."amountDeltaAbs"
      FROM reconciliation_matches rm
      WHERE rm."organizationId" = ${organizationId}
        AND rm."matchType" = ${matchType}::"MatchType"
        AND rm."sourceType" = ${sourceType}
        AND rm."sourceId" = s.id
        AND rm.status <> 'EXCEPTION'
      ORDER BY rm."createdAt" DESC
      LIMIT 1
    ) m ON true`);
  return rows[0]!;
}

function toLeg(matchType: MatchType, a: LegAggregate): LegOutcome {
  const eligibleValue = a.eligible_value ?? 0n;
  const matchedValue = a.matched_value ?? 0n;
  return {
    matchType,
    state: "ran",
    eligible: a.eligible,
    matched: a.matched,
    needsReview: a.needs_review,
    unmatched: a.eligible - a.matched,
    matchedValue,
    unmatchedValue: eligibleValue - matchedValue,
  };
}

/**
 * The four legs as they currently stand, read-only. Values and counts follow
 * the same definitions runReconciliation() uses, so the card a reader sees on
 * load and the one they see after pressing Run cannot disagree.
 */
export async function readReconciliationLegs(organizationId: string): Promise<LegOutcome[]> {
  // Which carriers we hold invoices for scopes the freight leg's denominator,
  // and it has to be known before the aggregate query is built.
  const invoiceCarriers = await prisma.freightInvoice.findMany({
    where: { organizationId },
    select: { carrier: true },
    distinct: ["carrier"],
  });
  const carrierSlugs = invoiceCarriers.map((c) => c.carrier);

  const [orderPayment, paymentSettlement, settlementBank, codRemittance, refundPayment, shipmentFreight] = await Promise.all([
    aggregateLeg(
      organizationId,
      MatchType.ORDER_PAYMENT,
      "ORDER",
      Prisma.sql`SELECT id, "grossAmount" AS value FROM orders
                 WHERE "organizationId" = ${organizationId}
                   AND "paymentMode" <> 'COD' AND "cancelledAt" IS NULL`
    ),
    aggregateLeg(
      organizationId,
      MatchType.PAYMENT_SETTLEMENT,
      "PAYMENT",
      Prisma.sql`SELECT id, amount AS value FROM payments
                 WHERE "organizationId" = ${organizationId} AND status = 'captured'`
    ),
    aggregateLeg(
      organizationId,
      MatchType.SETTLEMENT_BANK,
      "SETTLEMENT",
      Prisma.sql`SELECT id, amount AS value FROM settlements
                 WHERE "organizationId" = ${organizationId}`
    ),
    aggregateLeg(
      organizationId,
      MatchType.COD_REMITTANCE,
      "SHIPMENT",
      Prisma.sql`SELECT id, "codAmount" AS value FROM shipments
                 WHERE "organizationId" = ${organizationId}
                   AND status = 'DELIVERED' AND "codAmount" > 0`
    ),
    aggregateLeg(
      organizationId,
      MatchType.REFUND_PAYMENT,
      "REFUND",
      Prisma.sql`SELECT id, amount AS value FROM refunds
                 WHERE "organizationId" = ${organizationId}`
    ),
    // Scoped to carriers we hold an invoice for — see runShipmentFreightLeg.
    // With no invoices at all the query is skipped entirely rather than run
    // against an empty IN list, which Postgres rejects.
    carrierSlugs.length === 0
      ? Promise.resolve({ eligible: 0, eligible_value: 0n, matched: 0, matched_value: 0n, needs_review: 0 })
      : aggregateLeg(
          organizationId,
          MatchType.SHIPMENT_FREIGHT,
          "SHIPMENT",
          Prisma.sql`SELECT id, coalesce("freightAmount", 0) AS value FROM shipments
                     WHERE "organizationId" = ${organizationId}
                       AND "awbCode" IS NOT NULL
                       AND ${Prisma.raw(CARRIER_SQL)} IN (${Prisma.join(carrierSlugs)})`
        ),
  ]);

  const legs = [
    toLeg(MatchType.ORDER_PAYMENT, orderPayment),
    toLeg(MatchType.PAYMENT_SETTLEMENT, paymentSettlement),
    toLeg(MatchType.SETTLEMENT_BANK, settlementBank),
    toLeg(MatchType.COD_REMITTANCE, codRemittance),
    toLeg(MatchType.REFUND_PAYMENT, refundPayment),
    toLeg(MatchType.SHIPMENT_FREIGHT, shipmentFreight),
  ];
  // The freight leg's unmatched value is not "eligible minus matched": an
  // unbilled shipment has freightAmount NULL, so that subtraction would report
  // a negative figure as money outstanding. What an unbilled parcel will cost
  // is unknown until its invoice arrives, and is left at zero rather than
  // extrapolated.
  const freightLeg = legs[legs.length - 1]!;
  freightLeg.unmatchedValue = 0n;

  // A leg with nothing matched and nothing to match it against is not "0%
  // reconciled" — it is waiting on a source that does not exist yet, and
  // saying which one is the only actionable part of this card.
  const [settlementCount, paymentLineCount, codLineCount, bankCount, invoiceCount] = await Promise.all([
    prisma.settlement.count({ where: { organizationId } }),
    prisma.settlementLine.count({ where: { organizationId, type: "PAYMENT" } }),
    // Counted BY TYPE, not org-wide. Counting every line made the COD leg claim
    // "a remittance statement has been imported" as soon as any GATEWAY
    // statement existed — so a store with GoKwik payouts and no courier
    // statement at all was told its courier import had failed to resolve,
    // sending the reader to debug an import that never happened.
    prisma.settlementLine.count({ where: { organizationId, type: "SHIPMENT_COD" } }),
    prisma.bankTransaction.count({ where: { organizationId } }),
    prisma.freightInvoice.count({ where: { organizationId } }),
  ]);

  for (const leg of legs) {
    if (leg.matched > 0) continue;
    // Freight is checked BEFORE the generic empty case. Its denominator is
    // scoped to carriers we hold an invoice for, so with no invoices at all it
    // is legitimately empty — and "Nothing eligible in this leg yet" would then
    // be the one leg whose message never tells the reader to upload anything.
    if (leg.matchType === MatchType.SHIPMENT_FREIGHT && invoiceCount === 0) {
      leg.state = "unavailable";
      leg.blockedReason =
        "No courier freight invoice has been uploaded yet, so what shipping actually cost is unknown — and shipping is one of the two halves of contribution margin. Upload Bluedart tax invoice PDFs on the Connections page.";
      continue;
    }
    if (leg.eligible === 0) {
      leg.state = "unavailable";
      leg.blockedReason = "Nothing eligible in this leg yet.";
      continue;
    }
    switch (leg.matchType) {
      case MatchType.ORDER_PAYMENT:
        leg.state = "unavailable";
        leg.blockedReason =
          "No captured payments exist, so prepaid orders cannot be traced to money received.";
        break;
      case MatchType.PAYMENT_SETTLEMENT:
        leg.state = "unavailable";
        leg.blockedReason =
          settlementCount === 0
            ? "Payments exist, but no settlement records do — import a gateway settlement statement."
            : paymentLineCount === 0
              ? "Settlements exist but carry no payment lines, so which payments each payout contains is still unknown."
              : "Payment lines exist but none resolved to a captured payment we hold.";
        break;
      case MatchType.SETTLEMENT_BANK:
        leg.state = "unavailable";
        leg.blockedReason =
          bankCount === 0
            ? "No bank transactions have been imported, so no payout can be confirmed as received."
            : "Bank transactions exist but none line up with a payout — the account holding these payouts may not be the one connected.";
        break;
      case MatchType.COD_REMITTANCE:
        leg.state = "unavailable";
        leg.blockedReason =
          codLineCount === 0
            ? "Delivered COD shipments exist, but no courier remittance statement has been imported — couriers remit many shipments in one transfer, so individual shipments cannot be tied to a bank credit without one."
            : "A courier remittance statement has been imported, but none of its lines resolved to a delivered COD shipment.";
        break;
      case MatchType.SHIPMENT_FREIGHT:
        leg.state = "unavailable";
        leg.blockedReason =
          invoiceCount === 0
            ? "No courier freight invoice has been uploaded yet, so what shipping actually cost is unknown — and shipping is one of the two halves of contribution margin. Upload Bluedart tax invoice PDFs on the Connections page."
            : "Freight invoices are imported, but none of their waybills matched a shipment — the invoices may cover a different store or a period this store has no shipments for.";
        break;
    }
  }

  return legs;
}

// ---------------------------------------------------------------------------
// Freight coverage
// ---------------------------------------------------------------------------

export interface FreightSummary {
  invoices: number;
  lines: number;
  /** paise — everything the couriers billed across every imported invoice. */
  billedPaise: bigint;
  /** Lines billing an AWB this system has no shipment for. */
  linesWithoutShipment: number;
  /** paise — what those unattributable lines cost. */
  valueWithoutShipmentPaise: bigint;
  returnLegCount: number;
  returnLegPaise: bigint;
  creditCount: number;
  creditPaise: bigint;
  /** Carriers an invoice has been imported for, and how far coverage reaches. */
  carriers: Array<{ carrier: string; invoices: number; shipments: number; billedShipments: number }>;
  earliestShipDate: Date | null;
  latestShipDate: Date | null;
}

/**
 * What the imported freight invoices actually cover.
 *
 * The leg above counts shipments; this counts the money, including the half the
 * leg cannot express — lines billed for parcels that have no shipment at all.
 * That figure has no home anywhere else in the product.
 */
export async function readFreightSummary(organizationId: string): Promise<FreightSummary> {
  const [invoices, lineAgg, orphanAgg, returnAgg, creditAgg, dates] = await Promise.all([
    prisma.freightInvoice.count({ where: { organizationId } }),
    prisma.freightInvoiceLine.aggregate({
      where: { organizationId },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.freightInvoiceLine.aggregate({
      where: { organizationId, shipmentId: null },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.freightInvoiceLine.aggregate({
      where: { organizationId, isReturnLeg: true },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.freightInvoiceLine.aggregate({
      where: { organizationId, amount: { lt: 0 } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.freightInvoiceLine.aggregate({
      where: { organizationId },
      _min: { shipDate: true },
      _max: { shipDate: true },
    }),
  ]);

  const byCarrier = await prisma.freightInvoice.groupBy({
    by: ["carrier"],
    where: { organizationId },
    _count: { _all: true },
  });

  const carriers = await Promise.all(
    byCarrier.map(async (c) => {
      const rows = await prisma.$queryRaw<Array<{ total: number; billed: number }>>(Prisma.sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE "freightAmount" IS NOT NULL)::int AS billed
        FROM shipments
        WHERE "organizationId" = ${organizationId}
          AND "awbCode" IS NOT NULL
          AND ${Prisma.raw(CARRIER_SQL)} = ${c.carrier}`);
      return {
        carrier: c.carrier,
        invoices: c._count._all,
        shipments: rows[0]?.total ?? 0,
        billedShipments: rows[0]?.billed ?? 0,
      };
    })
  );

  return {
    invoices,
    lines: lineAgg._count._all,
    billedPaise: lineAgg._sum.amount ?? 0n,
    linesWithoutShipment: orphanAgg._count._all,
    valueWithoutShipmentPaise: orphanAgg._sum.amount ?? 0n,
    returnLegCount: returnAgg._count._all,
    returnLegPaise: returnAgg._sum.amount ?? 0n,
    creditCount: creditAgg._count._all,
    creditPaise: creditAgg._sum.amount ?? 0n,
    carriers,
    earliestShipDate: dates._min.shipDate,
    latestShipDate: dates._max.shipDate,
  };
}

// ---------------------------------------------------------------------------
// COD exposure (§51) — what the COD_REMITTANCE leg can honestly say today
// ---------------------------------------------------------------------------

// A parcel that was picked up and never reported another scan is not "in
// transit" — no courier takes a month. Past this age its status is not a
// journey in progress, it is a tracking failure, and the two must not share a
// bucket: one is money still coming, the other is money whose fate is unknown.
// Measured on this store: 13,439 Bluedart parcels sit here carrying ₹70.7 L,
// which "still out for delivery" would report as routine.
const STALE_TRACKING_DAYS = 30;

const NON_TERMINAL_STATUSES: ShipmentStatus[] = [
  "NEW",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "UNKNOWN",
];

export interface CodExposure {
  /** Orders placed as COD whose parcels are genuinely still moving — recent,
   *  non-terminal, and therefore not owed to us yet. */
  inFlightCount: number;
  inFlightValue: bigint;
  /** Picked up more than STALE_TRACKING_DAYS ago and never scanned to a
   *  terminal state. Neither collectible nor written off: the courier has
   *  stopped telling us, so this is the size of what we cannot see. */
  unknownCount: number;
  unknownValue: bigint;
  /** How old the oldest such parcel is, in days — the plainest statement of how
   *  long tracking has been silent. Null when there are none. */
  unknownOldestDays: number | null;
  /** PPCOD deposits already captured ONLINE across these orders. Not courier
   *  money — subtracted from the collectible so "coming via courier" never
   *  counts rupees that already arrived. */
  onlineDepositsValue: bigint;
  /** Delivered COD: the courier has collected this cash and owes it to us. */
  deliveredCount: number;
  deliveredValue: bigint;
  /** Came back undelivered — this cash was never collected and never will be.
   *  Its own bucket because calling it "in flight" reads as money still
   *  coming, which is the opposite of what RTO means. */
  rtoCount: number;
  rtoValue: bigint;
  /** True once shipment data exists; otherwise the split above is unknowable. */
  hasCourierData: boolean;
}

// Every bucket is scoped by the ORDER's placedAt — including the two shipment
// aggregates, which reach it through the order relation. Scoping shipments by
// their own delivery date instead would break the arithmetic below: a parcel
// delivered inside the window from an order placed before it would subtract a
// value that was never added to `totalCodValue`, and in-flight would go
// negative. One period definition, applied to the one entity the page lists.
export async function getCodExposure(
  organizationId: string,
  range?: { from: Date; to: Date }
): Promise<CodExposure> {
  const placedAt = range ? { gte: range.from, lte: range.to } : undefined;
  const orderScope = { paymentMode: "COD", cancelledAt: null, ...(placedAt ? { placedAt } : {}) };

  // The cutoff is computed once and reused by both the stale aggregate and the
  // in-flight count, so the two can never describe overlapping sets.
  const staleBefore = new Date(Date.now() - STALE_TRACKING_DAYS * 24 * 60 * 60 * 1000);
  const staleShipmentWhere = {
    organizationId,
    status: { in: NON_TERMINAL_STATUSES },
    codAmount: { gt: 0n },
    pickedUpAt: { lt: staleBefore },
    ...(placedAt ? { order: { placedAt } } : {}),
  };

  const [codOrders, codPayments, deliveredCod, rtoCod, shipmentCount, inFlightCount, staleCod, oldestStale] =
    await Promise.all([
    prisma.order.aggregate({
      where: { organizationId, ...orderScope },
      _count: { _all: true },
      _sum: { grossAmount: true },
    }),
    // Captured payments on COD orders — PPCOD deposits, plus the occasional
    // marked-as-paid door collection. Filtered in code because telling those
    // two apart is a gateway-name test (see connectors/shopify/gateways.ts)
    // that SQL can't share.
    prisma.payment.findMany({
      where: { organizationId, status: "captured", order: orderScope },
      select: { amount: true, method: true },
    }),
    prisma.shipment.aggregate({
      where: {
        organizationId,
        status: "DELIVERED",
        codAmount: { gt: 0 },
        ...(placedAt ? { order: { placedAt } } : {}),
      },
      _count: { _all: true },
      _sum: { codAmount: true },
    }),
    prisma.shipment.aggregate({
      where: {
        organizationId,
        status: { in: ["RTO_INITIATED", "RTO_DELIVERED"] },
        codAmount: { gt: 0 },
        ...(placedAt ? { order: { placedAt } } : {}),
      },
      _count: { _all: true },
      _sum: { codAmount: true },
    }),
    // Deliberately NOT scoped: this answers "can we see courier data at all",
    // an org-level fact that decides which card the page renders. Scoping it
    // would make a period whose orders haven't shipped yet (any "Today") claim
    // "no courier data — delivery status unknown" for a store that has 42k
    // tracked shipments.
    prisma.shipment.count({ where: { organizationId } }),
    // Counted directly rather than as (orders − delivered − rto): two orders in
    // this store ship in two parcels, so the subtraction under-reports whenever
    // one lands in the window — and on a narrow window it can go NEGATIVE (one
    // order, two delivered parcels → −1). Values still net out arithmetically;
    // only the count needs an order-level question asked at order level.
    // An order counts as in flight only if NOTHING about it has resolved AND
    // nothing about it has gone silent — otherwise a parcel picked up eight
    // months ago would be counted here and in `unknown` at once, and the two
    // buckets would sum to more than the order book.
    prisma.order.count({
      where: {
        organizationId,
        ...orderScope,
        shipments: {
          none: { status: { in: ["DELIVERED", "RTO_INITIATED", "RTO_DELIVERED"] } },
        },
        NOT: {
          shipments: {
            some: {
              status: { in: NON_TERMINAL_STATUSES },
              codAmount: { gt: 0n },
              pickedUpAt: { lt: staleBefore },
            },
          },
        },
      },
    }),
    prisma.shipment.aggregate({
      where: staleShipmentWhere,
      _count: { _all: true },
      _sum: { codAmount: true },
    }),
    prisma.shipment.findFirst({
      where: staleShipmentWhere,
      orderBy: { pickedUpAt: "asc" },
      select: { pickedUpAt: true },
    }),
  ]);

  const deliveredValue = deliveredCod._sum.codAmount ?? 0n;
  const rtoValue = rtoCod._sum.codAmount ?? 0n;
  const totalCodValue = codOrders._sum.grossAmount ?? 0n;

  // What rides with couriers is gross MINUS money already captured online —
  // GoKwik PPCOD collects a ₹21–51 deposit up front and only the balance is
  // cash at the door. isCashAtDoorGateway is the same test the per-shipment
  // codAmount uses, so the aggregate and the rows can't disagree.
  const onlineDeposits = codPayments.reduce(
    (sum, p) => (isCashAtDoorGateway(p.method) ? sum : sum + p.amount),
    0n
  );

  const unknownValue = staleCod._sum.codAmount ?? 0n;

  return {
    // Without courier data every COD order is simply "placed" — claiming a
    // delivered/in-flight split we cannot see would be §109 false precision.
    // "In flight" is the remainder AFTER the stale bucket is removed. It used
    // to absorb that bucket too, which meant a parcel picked up eight months
    // ago and never scanned again was reported as "still out for delivery" —
    // true of the database, false of the world, and the single largest
    // misstatement this function made. Delivered, RTO and unknown values are
    // per-shipment codAmount (already deposit-adjusted), so only the deposits
    // of the REMAINING orders need subtracting — netting every bucket off one
    // deposit total.
    inFlightCount,
    inFlightValue: totalCodValue - onlineDeposits - deliveredValue - rtoValue - unknownValue,
    unknownCount: staleCod._count._all,
    unknownValue,
    unknownOldestDays: oldestStale?.pickedUpAt
      ? Math.floor((Date.now() - oldestStale.pickedUpAt.getTime()) / (24 * 60 * 60 * 1000))
      : null,
    onlineDepositsValue: onlineDeposits,
    deliveredCount: deliveredCod._count._all,
    deliveredValue,
    rtoCount: rtoCod._count._all,
    rtoValue,
    hasCourierData: shipmentCount > 0,
  };
}
