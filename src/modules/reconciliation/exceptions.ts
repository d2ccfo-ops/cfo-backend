import { Prisma } from "@prisma/client";
import type { ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { invalidateOrgReads } from "../../lib/orgReadCache.js";
import { AMOUNT_TOLERANCE_PAISE } from "../calc/reconciliation.js";
import { capturedStatusSql } from "../calc/paymentStatus.js";

// P6.4 — the §15 exception taxonomy.
//
// The PRD names eleven kinds of reconciliation exception. Until now the product
// had one word for all of them — "unmatched" — which tells a finance manager
// that something is wrong and nothing about what to do. "Missing COD
// remittance" is a call to the courier; "duplicate settlement" is money
// received twice; "unknown deduction" is a fee nobody agreed to. Same badge,
// three different afternoons.
//
// ---------------------------------------------------------------------------
// WHY THESE ARE DERIVED AND NOT STORED
// ---------------------------------------------------------------------------
// The plan's one-line note says "+ MatchStatus.EXCEPTION writes". Following
// that literally would be wrong, and the schema already says why:
//
//   "One row per PAIRING the engine established — never one row per unmatched
//    record. Unmatched is the absence of a row … materialising 49,617
//    exception rows would mean re-deriving all of them every time a single
//    payment arrives."
//
// Worse, aggregateLeg() filters `status <> 'EXCEPTION'`. Flagging a matched-
// but-discrepant pairing would remove it from the matched count AND from
// needsReview (which reads a column on the row that just disappeared), so the
// leg summary would get less accurate, not more.
//
// So the taxonomy is computed at read time, and a stored EXCEPTION stays what
// it has always been: a human saying "this specific pairing is wrong" — a
// decision, not a derivation, exactly like a write-off.
//
// ---------------------------------------------------------------------------
// DETECTABLE IS NOT THE SAME AS ZERO
// ---------------------------------------------------------------------------
// Every detector states whether its source exists. An org that has never
// uploaded a settlement statement has no way to distinguish "every payment
// settled fine" from "we cannot see settlements", and reporting 8,406 missing
// settlements because the file was never uploaded would be the single most
// alarming and least useful screen in the product. Same refusal
// getPendingSettlements() already makes.

export type ExceptionSeverity = "critical" | "warning" | "info";

export interface ExceptionType {
  key: string;
  label: string;
  spec: string;
  severity: ExceptionSeverity;
  /** What it means and what to do about it — shown, not just documented. */
  meaning: string;
}

/** The §15 taxonomy, in the PRD's own order. */
export const EXCEPTION_TYPES: ExceptionType[] = [
  {
    key: "missing_payment",
    label: "Missing payment",
    spec: "§15",
    severity: "critical",
    meaning: "A prepaid order with no payment recorded. Either the capture failed or it never reached us.",
  },
  {
    key: "missing_settlement",
    label: "Missing settlement",
    spec: "§15",
    severity: "critical",
    meaning: "Money was captured from the customer but the gateway has not paid it out — or the payout statement covering it was never imported.",
  },
  {
    key: "partial_settlement",
    label: "Partial settlement",
    spec: "§15",
    severity: "warning",
    meaning: "The payout carried less than the capture was worth, beyond the fee. Something was withheld that the statement does not explain.",
  },
  {
    key: "duplicate_settlement",
    label: "Duplicate settlement",
    spec: "§15",
    severity: "warning",
    meaning: "One capture appears in more than one payout. Either it was paid twice or the same statement was imported under two batch ids.",
  },
  {
    key: "incorrect_fee",
    label: "Incorrect fee",
    spec: "§15",
    severity: "warning",
    meaning: "A payout line where the fee is far from what this provider normally charges this business.",
  },
  {
    key: "unknown_deduction",
    label: "Unknown deduction",
    spec: "§15",
    severity: "warning",
    meaning: "Money taken out of a payout with no order behind it — a fee, a TDS entry or a chargeback the statement did not attribute.",
  },
  {
    key: "missing_cod_remittance",
    label: "Missing COD remittance",
    spec: "§15",
    severity: "critical",
    meaning: "A parcel was delivered and the cash collected, and no courier remittance covers it. This is the largest single category of silently lost money in Indian D2C.",
  },
  {
    key: "refund_mismatch",
    label: "Refund mismatch",
    spec: "§15",
    severity: "warning",
    meaning: "A refund this store issued that no payout carries as a deduction — the money may not have left, or it left through a route we cannot see.",
  },
  {
    key: "date_mismatch",
    label: "Date mismatch",
    spec: "§15",
    severity: "info",
    meaning: "A payout that arrived far outside the provider's normal cycle. Not wrong by itself, but it is what a systemic delay looks like before anyone notices.",
  },
  {
    key: "amount_mismatch",
    label: "Amount mismatch",
    spec: "§15",
    severity: "warning",
    meaning: "A pairing the engine made where the two sides disagree by more than a rupee.",
  },
  {
    key: "unmatched_bank_transaction",
    label: "Unmatched bank transaction",
    spec: "§15",
    severity: "info",
    meaning: "A credit in the bank that no settlement explains. Could be a payout we have no statement for, or income from somewhere else entirely.",
  },
];

export interface ExceptionSample {
  id: string;
  reference: string;
  amountMinor: string;
  occurredAt: string | null;
  detail: string;
}

export interface ExceptionResult {
  key: string;
  label: string;
  spec: string;
  severity: ExceptionSeverity;
  meaning: string;
  count: number;
  valueMinor: string;
  /**
   * Whether this exception can be looked for at all.
   *
   * False means the source is absent, NOT that the count is zero — and the two
   * must never render the same way. An org with no settlement statement would
   * otherwise read as "no missing settlements", which is the opposite of true.
   */
  detectable: boolean;
  /** Why it is undetectable, or how the count was arrived at. */
  reason: string;
  sample: ExceptionSample[];
}

const SAMPLE_SIZE = 5;

/**
 * A payout cycle longer than this is unusual for every Indian gateway and
 * courier in scope. T+2 is standard, T+7 is a slow marketplace, and past three
 * weeks something has gone wrong that nobody has been told about.
 */
const SLOW_SETTLEMENT_DAYS = 21;

/**
 * How far a line's fee rate has to sit from this org's own median before it is
 * worth naming. Compared against ITSELF rather than an industry benchmark —
 * "2% is the normal MDR" is a number I would be inventing, whereas "this
 * business is normally charged 1.9% by this provider and this line was charged
 * 6%" is measured.
 */
const FEE_OUTLIER_MULTIPLE = 2.5;
/** Below this many lines a median is not a fact about anything. */
const MIN_LINES_FOR_FEE_MEDIAN = 30;

interface Ctx {
  organizationId: string;
  range: ResolvedRange;
  /** Org-wide source presence, read once rather than per detector. */
  has: {
    settlementLines: boolean;
    codLines: boolean;
    bankTransactions: boolean;
    refunds: boolean;
    adjustments: boolean;
  };
}

type Detector = (ctx: Ctx) => Promise<Omit<ExceptionResult, "key" | "label" | "spec" | "severity" | "meaning">>;

const empty = (reason: string, detectable = false) => ({
  count: 0,
  valueMinor: "0",
  detectable,
  reason,
  sample: [] as ExceptionSample[],
});

const DETECTORS: Record<string, Detector> = {
  // -------------------------------------------------------------------------
  async missing_payment({ organizationId, range }) {
    // COD and payment-terms orders are excluded for the reason the status CASE
    // already documents: neither was ever expected to carry a gateway payment,
    // and calling them exceptions would make 72% of a COD-heavy store look
    // broken.
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; amount: bigint; placed: Date }>>(Prisma.sql`
      SELECT o.id, coalesce(o."orderNumber", o."externalOrderId") AS ref, o."grossAmount" AS amount, o."placedAt" AS placed
      FROM orders o
      WHERE o."organizationId" = ${organizationId}
        AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
        AND o."cancelledAt" IS NULL
        AND coalesce(o."paymentMode", '') <> 'COD'
        AND (o.raw->'payment_terms' IS NULL OR o.raw->'payment_terms' = 'null'::jsonb)
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_matches m
          WHERE m."organizationId" = o."organizationId" AND m."matchType" = 'ORDER_PAYMENT'
            AND m."sourceType" = 'ORDER' AND m."sourceId" = o.id
        )
      ORDER BY o."grossAmount" DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.amount, 0n).toString(),
      detectable: true,
      reason: "Prepaid, non-cancelled orders with no payment matched. COD and payment-terms orders are excluded — neither expects a gateway capture.",
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.amount.toString(),
        occurredAt: r.placed.toISOString(),
        detail: "No payment record",
      })),
    };
  },

  // -------------------------------------------------------------------------
  async missing_settlement({ organizationId, range, has }) {
    if (!has.settlementLines) {
      return empty(
        "No settlement statement has been imported, so a captured payment that was never paid out cannot be told apart from one whose statement is simply missing. Every payment would be reported here, which would be alarming and wrong."
      );
    }
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; amount: bigint; captured: Date | null }>>(Prisma.sql`
      SELECT p.id, coalesce(p."externalPaymentId", p.id) AS ref, p.amount, p."capturedAt" AS captured
      FROM payments p
      WHERE p."organizationId" = ${organizationId}
        AND ${capturedStatusSql(Prisma.sql`p.status`)}
        AND p."capturedAt" BETWEEN ${range.from} AND ${range.to}
        AND NOT EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl."paymentId" = p.id)
      ORDER BY p.amount DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.amount, 0n).toString(),
      detectable: true,
      reason: "Captured payments appearing in no payout line.",
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.amount.toString(),
        occurredAt: r.captured?.toISOString() ?? null,
        detail: "Captured, never appeared in a payout",
      })),
    };
  },

  // -------------------------------------------------------------------------
  async partial_settlement({ organizationId, range, has }) {
    if (!has.settlementLines) return empty("No settlement statement has been imported.");
    // COMPARED ON GROSS, NOT NET, AND THIS IS THE WHOLE DETECTOR.
    //
    // The obvious test is `payment.amount − payment.feeAmount − sum(net)`. It
    // is wrong, and wrong in the direction that manufactures alarm: on the real
    // organisation every one of 8,406 payments has feeAmount NULL, so that
    // expression reduces to the gateway's own fee and reported 3,076 "partial
    // settlements" worth ₹1.37 L. Every single one was a fee correctly stated
    // on the line — an afternoon of chasing nothing.
    //
    // A payout line's gross is what the provider says the capture was worth.
    // If that is less than what we captured, the payout genuinely covered only
    // part of it. The fee is irrelevant to the question and is exactly what
    // made the naive version fire.
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; shortfall: bigint; captured: Date | null; paid: bigint }>>(Prisma.sql`
      SELECT p.id, coalesce(p."externalPaymentId", p.id) AS ref,
             (p.amount - sum(sl."grossAmount"))::bigint AS shortfall,
             sum(sl."grossAmount")::bigint AS paid,
             p."capturedAt" AS captured
      FROM payments p
      JOIN settlement_lines sl ON sl."paymentId" = p.id
      WHERE p."organizationId" = ${organizationId}
        AND p."capturedAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY p.id, p.amount, p."externalPaymentId", p."capturedAt"
      HAVING (p.amount - sum(sl."grossAmount")) > ${AMOUNT_TOLERANCE_PAISE}
      ORDER BY 3 DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.shortfall, 0n).toString(),
      detectable: true,
      reason: `Payouts whose stated gross covered less than the capture, by more than ₹${Number(AMOUNT_TOLERANCE_PAISE) / 100}. Compared on gross so a correctly-stated fee is not mistaken for a shortfall.`,
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.shortfall.toString(),
        occurredAt: r.captured?.toISOString() ?? null,
        detail: `Payout covered ₹${(Number(r.paid) / 100).toFixed(2)} of a ₹${((Number(r.paid) + Number(r.shortfall)) / 100).toFixed(2)} capture`,
      })),
    };
  },

  // -------------------------------------------------------------------------
  async duplicate_settlement({ organizationId, range, has }) {
    if (!has.settlementLines) return empty("No settlement statement has been imported.");
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; n: number; total: bigint; captured: Date | null }>>(Prisma.sql`
      SELECT p.id, coalesce(p."externalPaymentId", p.id) AS ref, count(sl.id)::int AS n,
             sum(sl."netAmount")::bigint AS total, p."capturedAt" AS captured
      FROM payments p
      JOIN settlement_lines sl ON sl."paymentId" = p.id
      JOIN settlements st ON st.id = sl."settlementId"
      WHERE p."organizationId" = ${organizationId}
        AND p."capturedAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY p.id, p."externalPaymentId", p."capturedAt"
      -- Distinct PAYOUTS, not distinct lines: a payout legitimately carrying a
      -- capture across two rows (a split, a correction) is not a duplicate.
      HAVING count(DISTINCT st.id) > 1
      ORDER BY 4 DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.total, 0n).toString(),
      detectable: true,
      reason: "Captures appearing in more than one payout batch.",
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.total.toString(),
        occurredAt: r.captured?.toISOString() ?? null,
        detail: `Appears in ${r.n} payout lines across more than one batch`,
      })),
    };
  },

  // -------------------------------------------------------------------------
  async incorrect_fee({ organizationId, range, has }) {
    if (!has.settlementLines) return empty("No settlement statement has been imported.");
    // The median is this organisation's own, per provider. An industry MDR
    // would be a number invented here; "you are normally charged 1.9% and this
    // line was 6%" is measured.
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; rate: number; median: number; fee: bigint; provider: string; settled: Date | null }>>(Prisma.sql`
      WITH lines AS (
        SELECT sl.id, sl."externalReference" AS ref, sl."feeAmount" AS fee, sl."grossAmount" AS gross,
               st.provider::text AS provider, st."settledAt" AS settled,
               (sl."feeAmount"::numeric / nullif(sl."grossAmount", 0)::numeric) AS rate
        FROM settlement_lines sl
        JOIN settlements st ON st.id = sl."settlementId"
        WHERE sl."organizationId" = ${organizationId}
          AND sl.type <> 'ADJUSTMENT'
          AND sl."grossAmount" > 0
          AND st."settledAt" BETWEEN ${range.from} AND ${range.to}
      ), stats AS (
        SELECT provider, percentile_cont(0.5) WITHIN GROUP (ORDER BY rate) AS median, count(*)::int AS n
        FROM lines GROUP BY provider
      )
      SELECT l.id, l.ref, l.rate::float8 AS rate, s.median::float8 AS median, l.fee, l.provider, l.settled
      FROM lines l JOIN stats s ON s.provider = l.provider
      WHERE s.n >= ${MIN_LINES_FOR_FEE_MEDIAN}
        AND s.median > 0
        AND l.rate > s.median * ${FEE_OUTLIER_MULTIPLE}
      ORDER BY l.fee DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.fee, 0n).toString(),
      detectable: true,
      reason: `Lines charged more than ${FEE_OUTLIER_MULTIPLE}× this organisation's own median rate for that provider. Compared against itself, not an industry benchmark — needs at least ${MIN_LINES_FOR_FEE_MEDIAN} lines before a median means anything.`,
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.fee.toString(),
        occurredAt: r.settled?.toISOString() ?? null,
        detail: `${(r.rate * 100).toFixed(2)}% charged where ${r.provider} normally takes ${(r.median * 100).toFixed(2)}%`,
      })),
    };
  },

  // -------------------------------------------------------------------------
  async unknown_deduction({ organizationId, range, has }) {
    if (!has.settlementLines) return empty("No settlement statement has been imported.");
    // ADJUSTMENT is by definition money in the payout with no source row. Most
    // are legitimate and named (commission, TDS); they are surfaced anyway,
    // because the whole point is that nobody has ever looked at them.
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; net: bigint; settled: Date | null }>>(Prisma.sql`
      SELECT sl.id, sl."externalReference" AS ref, sl."netAmount" AS net, st."settledAt" AS settled
      FROM settlement_lines sl
      JOIN settlements st ON st.id = sl."settlementId"
      WHERE sl."organizationId" = ${organizationId}
        AND sl.type = 'ADJUSTMENT'
        AND st."settledAt" BETWEEN ${range.from} AND ${range.to}
      ORDER BY abs(sl."netAmount") DESC`);
    const total = rows.reduce((s, r) => s + (r.net < 0n ? -r.net : r.net), 0n);
    return {
      count: rows.length,
      valueMinor: total.toString(),
      detectable: true,
      reason: "Payout lines attached to no order or shipment — fees, TDS and chargebacks the statement did not attribute.",
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.net.toString(),
        occurredAt: r.settled?.toISOString() ?? null,
        detail: r.net < 0n ? "Deducted from the payout" : "Added to the payout",
      })),
    };
  },

  // -------------------------------------------------------------------------
  async missing_cod_remittance({ organizationId, range, has }) {
    if (!has.codLines) {
      return empty(
        "No COD remittance statement has been imported, so a delivered parcel whose cash never came back cannot be told apart from one whose statement is missing. Every delivered COD order would appear here."
      );
    }
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; amount: bigint; delivered: Date | null }>>(Prisma.sql`
      SELECT s.id, coalesce(s."awbCode", s."externalShipmentId") AS ref,
             coalesce(o."grossAmount", 0) AS amount, s."deliveredAt" AS delivered
      FROM shipments s
      JOIN orders o ON o.id = s."orderId"
      WHERE s."organizationId" = ${organizationId}
        AND s.status = 'DELIVERED'
        AND o."paymentMode" = 'COD'
        AND s."deliveredAt" BETWEEN ${range.from} AND ${range.to}
        AND NOT EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl."shipmentId" = s.id)
      ORDER BY o."grossAmount" DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.amount, 0n).toString(),
      detectable: true,
      reason: "Delivered COD parcels with no remittance line covering them.",
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.amount.toString(),
        occurredAt: r.delivered?.toISOString() ?? null,
        detail: "Delivered, cash collected, no remittance",
      })),
    };
  },

  // -------------------------------------------------------------------------
  async refund_mismatch({ organizationId, range, has }) {
    if (!has.refunds) return empty("No refund records exist for this organisation.");
    if (!has.settlementLines) {
      return empty("No settlement statement has been imported, so a refund that never left cannot be told apart from one whose payout line is missing.");
    }
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; amount: bigint; at: Date | null }>>(Prisma.sql`
      SELECT r.id, coalesce(r."externalRefundId", r.id) AS ref, r.amount, r."processedAt" AS at
      FROM refunds r
      WHERE r."organizationId" = ${organizationId}
        -- processedAt, not createdAt: when the money actually moved is the
        -- window the reconciliation leg is cut on, and using a different one
        -- here would report refunds the leg never looked at.
        AND r."processedAt" BETWEEN ${range.from} AND ${range.to}
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_matches m
          WHERE m."organizationId" = r."organizationId" AND m."matchType" = 'REFUND_PAYMENT'
            AND m."sourceType" = 'REFUND' AND m."sourceId" = r.id
        )
      ORDER BY r.amount DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.amount, 0n).toString(),
      detectable: true,
      reason: "Refunds this store issued that no payout carries as a deduction.",
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.amount.toString(),
        occurredAt: r.at?.toISOString() ?? null,
        detail: "Issued, but absent from every payout",
      })),
    };
  },

  // -------------------------------------------------------------------------
  async date_mismatch({ organizationId, range, has }) {
    if (!has.settlementLines) return empty("No settlement statement has been imported.");
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; amount: bigint; days: number; settled: Date | null }>>(Prisma.sql`
      SELECT sl.id, coalesce(p."externalPaymentId", sl."externalReference") AS ref, sl."netAmount" AS amount,
             EXTRACT(DAY FROM (st."settledAt" - p."capturedAt"))::int AS days, st."settledAt" AS settled
      FROM settlement_lines sl
      JOIN settlements st ON st.id = sl."settlementId"
      JOIN payments p ON p.id = sl."paymentId"
      WHERE sl."organizationId" = ${organizationId}
        AND st."settledAt" BETWEEN ${range.from} AND ${range.to}
        AND p."capturedAt" IS NOT NULL
        -- Multiplied out rather than make_interval(days => …): Prisma binds a
        -- JS number as bigint, and make_interval has no bigint overload.
        AND st."settledAt" > p."capturedAt" + (${SLOW_SETTLEMENT_DAYS}::int * interval '1 day')
      ORDER BY 4 DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.amount, 0n).toString(),
      detectable: true,
      reason: `Payouts that landed more than ${SLOW_SETTLEMENT_DAYS} days after the capture. Not wrong on its own — it is what a systemic delay looks like before anyone notices.`,
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.amount.toString(),
        occurredAt: r.settled?.toISOString() ?? null,
        detail: `Settled ${r.days} days after capture`,
      })),
    };
  },

  // -------------------------------------------------------------------------
  async amount_mismatch({ organizationId, range }) {
    // Reads the pairings the engine already made. Deliberately NOT filtered to
    // the period by match date — a pairing created last night about an order
    // from three months ago belongs to that order's period.
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; delta: bigint; at: Date }>>(Prisma.sql`
      SELECT m.id, coalesce(o."orderNumber", o."externalOrderId", m."sourceId") AS ref,
             m."amountDeltaAbs" AS delta, m."createdAt" AS at
      FROM reconciliation_matches m
      LEFT JOIN orders o ON o.id = m."sourceId" AND m."sourceType" = 'ORDER'
      WHERE m."organizationId" = ${organizationId}
        AND m."amountDeltaAbs" > ${AMOUNT_TOLERANCE_PAISE}
        AND m.status = 'MATCHED'
        AND (o.id IS NULL OR o."placedAt" BETWEEN ${range.from} AND ${range.to})
      ORDER BY m."amountDeltaAbs" DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.delta, 0n).toString(),
      detectable: true,
      reason: `Pairings where the two sides disagree by more than ₹${Number(AMOUNT_TOLERANCE_PAISE) / 100}.`,
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.delta.toString(),
        occurredAt: r.at.toISOString(),
        detail: `Sides differ by ₹${(Number(r.delta) / 100).toFixed(2)}`,
      })),
    };
  },

  // -------------------------------------------------------------------------
  async unmatched_bank_transaction({ organizationId, range, has }) {
    if (!has.bankTransactions) {
      return empty("No bank transactions have been imported, so there is nothing to match against.");
    }
    const rows = await prisma.$queryRaw<Array<{ id: string; ref: string; amount: bigint; at: Date }>>(Prisma.sql`
      SELECT bt.id, coalesce(bt."utr", bt.description, bt.id) AS ref, bt.amount, bt."valueDate" AS at
      FROM bank_transactions bt
      WHERE bt."organizationId" = ${organizationId}
        AND bt.direction = 'CREDIT'
        AND bt."valueDate" BETWEEN ${range.from} AND ${range.to}
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_matches m
          WHERE m."organizationId" = bt."organizationId" AND m."matchType" = 'SETTLEMENT_BANK'
            AND m."targetType" = 'BANK_TRANSACTION' AND m."targetId" = bt.id
        )
      ORDER BY bt.amount DESC`);
    return {
      count: rows.length,
      valueMinor: rows.reduce((s, r) => s + r.amount, 0n).toString(),
      detectable: true,
      reason: "Bank credits that no settlement explains.",
      sample: rows.slice(0, SAMPLE_SIZE).map((r) => ({
        id: r.id,
        reference: r.ref,
        amountMinor: r.amount.toString(),
        occurredAt: r.at.toISOString(),
        detail: "Credit with no settlement behind it",
      })),
    };
  },
};

export interface ExceptionReport {
  version: string;
  period: { from: string; to: string };
  types: ExceptionResult[];
  totalCount: number;
  totalValueMinor: string;
  /** Types that could not be looked for, and why — never folded into zero. */
  undetectable: string[];
}

export const EXCEPTION_TAXONOMY_VERSION = "v1";

export async function getExceptionReport(organizationId: string, range: ResolvedRange): Promise<ExceptionReport> {
  // Source presence, read once. Each detector asking for itself would be
  // eleven extra round trips to answer the same five questions.
  const [settlementLines, codLines, bankTransactions, refunds, adjustments] = await Promise.all([
    prisma.settlementLine.count({ where: { organizationId, type: "PAYMENT" } }),
    prisma.settlementLine.count({ where: { organizationId, type: "SHIPMENT_COD" } }),
    prisma.bankTransaction.count({ where: { organizationId } }),
    prisma.refund.count({ where: { organizationId } }),
    prisma.settlementLine.count({ where: { organizationId, type: "ADJUSTMENT" } }),
  ]);

  const ctx: Ctx = {
    organizationId,
    range,
    has: {
      settlementLines: settlementLines > 0,
      codLines: codLines > 0,
      bankTransactions: bankTransactions > 0,
      refunds: refunds > 0,
      adjustments: adjustments > 0,
    },
  };

  const types: ExceptionResult[] = [];
  for (const type of EXCEPTION_TYPES) {
    const detector = DETECTORS[type.key];
    if (!detector) {
      types.push({ ...type, ...empty("No detector is implemented for this type.") });
      continue;
    }
    types.push({ ...type, ...(await detector(ctx)) });
  }

  const detectableTypes = types.filter((t) => t.detectable);
  return {
    version: EXCEPTION_TAXONOMY_VERSION,
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    types,
    // Totals cover only what could actually be looked for. Summing across
    // undetectable types would present a total that silently excludes whole
    // categories while looking complete.
    totalCount: detectableTypes.reduce((s, t) => s + t.count, 0),
    totalValueMinor: detectableTypes.reduce((s, t) => s + BigInt(t.valueMinor), 0n).toString(),
    undetectable: types.filter((t) => !t.detectable).map((t) => `${t.label}: ${t.reason}`),
  };
}

// ---------------------------------------------------------------------------
// The one stored EXCEPTION: a person saying a specific pairing is wrong.
// ---------------------------------------------------------------------------
// Not derived, so it must be stored — the same argument the schema makes for a
// write-off. Flagging removes the pairing from the matched counts, which is
// correct here and would NOT be correct as an automatic consequence of a
// discrepancy: the engine cannot tell a wrong pairing from a real shortfall,
// and a person can.
export async function flagMatchAsException(
  organizationId: string,
  matchId: string,
  note: string | null,
  userId: string
): Promise<{ flagged: boolean }> {
  const match = await prisma.reconciliationMatch.findFirst({
    where: { id: matchId, organizationId },
    select: { id: true, status: true, matchType: true, sourceId: true, amountDeltaAbs: true },
  });
  if (!match || match.status === "EXCEPTION") return { flagged: false };

  await prisma.$transaction(async (tx) => {
    await tx.reconciliationMatch.update({
      where: { id: matchId },
      data: { status: "EXCEPTION", note, resolvedBy: userId, resolvedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        organizationId,
        actorType: "USER",
        actorId: userId,
        action: "reconciliation.flag_exception",
        entityType: "RECONCILIATION_MATCH",
        entityId: matchId,
        metadata: {
          matchType: match.matchType,
          sourceId: match.sourceId,
          amountDeltaAbsPaise: match.amountDeltaAbs.toString(),
          note,
        },
      },
    });
  });
  // An exception flag removes the row from every leg's matched set at once.
  invalidateOrgReads(organizationId);
  return { flagged: true };
}

export async function unflagMatch(organizationId: string, matchId: string, userId: string): Promise<{ unflagged: boolean }> {
  const { count } = await prisma.reconciliationMatch.updateMany({
    where: { id: matchId, organizationId, status: "EXCEPTION" },
    data: { status: "MATCHED", resolvedBy: userId, resolvedAt: new Date() },
  });
  if (count === 0) return { unflagged: false };
  await prisma.auditLog.create({
    data: {
      organizationId,
      actorType: "USER",
      actorId: userId,
      action: "reconciliation.unflag_exception",
      entityType: "RECONCILIATION_MATCH",
      entityId: matchId,
    },
  });
  invalidateOrgReads(organizationId);
  return { unflagged: true };
}
