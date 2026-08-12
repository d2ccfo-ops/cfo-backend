import { prisma } from "../../lib/prisma.js";
import type { ResolvedRange } from "../../lib/dateRange.js";

// P4.1b. Three positions the AI tool registry needed and no calc module owned:
// what a provider has paid us, what it still owes us, and what actually moved
// through the bank.
//
// These live here rather than inside routes/settlements.ts because the route
// answers a PAGE's question — a paginated list with a cursor — and a tool
// answers a QUESTION. Both read the same tables and neither derives the
// other's numbers, so there is no second implementation of a figure to drift.
//
// Everything is a database aggregate. Not one of these functions estimates,
// projects or apportions: where a fact is unknown it is reported as unknown
// and counted separately, because the entire reason the AI layer can be
// audited is that its inputs are sums of rows a human can go and read.

export const MONEY_MOVEMENT_VERSION = "v1";

export interface SettlementSummary {
  metricKey: "settlement_summary";
  period: { from: string; to: string };
  payoutCount: number;
  /** Net settled — what actually hit the bank, after the provider's deductions. */
  netSettledPaise: string;
  feePaise: string;
  /** GST charged on those fees. A subset of feePaise, not additional to it. */
  taxOnFeePaise: string;
  byProvider: Array<{ provider: string; kind: string; count: number; netSettledPaise: string; feePaise: string }>;
  /** Payouts the provider has told us about but that carry no settlement date. */
  undatedCount: number;
  /** Payouts with no UTR — unmatchable against a bank statement until one arrives. */
  withoutUtrCount: number;
}

export async function getSettlementSummary(organizationId: string, range: ResolvedRange): Promise<SettlementSummary> {
  const where = { organizationId, settledAt: { gte: range.from, lte: range.to } };

  const [totals, grouped, undated, withoutUtr] = await Promise.all([
    prisma.settlement.aggregate({ where, _count: { _all: true }, _sum: { amount: true, feeAmount: true, taxAmount: true } }),
    prisma.settlement.groupBy({
      by: ["provider", "kind"],
      where,
      _count: { _all: true },
      _sum: { amount: true, feeAmount: true },
    }),
    prisma.settlement.count({ where: { organizationId, settledAt: null } }),
    prisma.settlement.count({ where: { ...where, utr: null } }),
  ]);

  return {
    metricKey: "settlement_summary",
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    payoutCount: totals._count._all,
    netSettledPaise: String(totals._sum.amount ?? 0n),
    feePaise: String(totals._sum.feeAmount ?? 0n),
    taxOnFeePaise: String(totals._sum.taxAmount ?? 0n),
    byProvider: grouped
      .map((g) => ({
        provider: g.provider,
        kind: g.kind,
        count: g._count._all,
        netSettledPaise: String(g._sum.amount ?? 0n),
        feePaise: String(g._sum.feeAmount ?? 0n),
      }))
      .sort((a, b) => (BigInt(b.netSettledPaise) > BigInt(a.netSettledPaise) ? 1 : -1)),
    undatedCount: undated,
    withoutUtrCount: withoutUtr,
  };
}

export interface PendingSettlements {
  metricKey: "pending_settlements";
  /** Captured payments that appear in no settlement line — money the gateway holds. */
  unsettledPaymentCount: number;
  unsettledPaymentPaise: string;
  oldestUnsettledAt: string | null;
  /**
   * Null when no settlement LINES exist at all. Without line items nothing can
   * be marked settled, so every payment would read as pending and the figure
   * would be the gateway's entire lifetime volume rather than its float.
   */
  hasSettlementLines: boolean;
  unavailableReason: string | null;
}

export async function getPendingSettlements(organizationId: string): Promise<PendingSettlements> {
  const lineCount = await prisma.settlementLine.count({ where: { settlement: { organizationId }, type: "PAYMENT" } });

  if (lineCount === 0) {
    return {
      metricKey: "pending_settlements",
      unsettledPaymentCount: 0,
      unsettledPaymentPaise: "0",
      oldestUnsettledAt: null,
      hasSettlementLines: false,
      unavailableReason:
        "No settlement line items have been ingested, so nothing can be marked as settled. Every captured payment would read as pending, which would overstate the gateway float by the whole lifetime volume.",
    };
  }

  // A payment is pending when it captured but no settlement line claims it.
  const rows = await prisma.payment.findMany({
    where: {
      organizationId,
      status: "CAPTURED",
      settlementLines: { none: {} },
    },
    select: { amount: true, capturedAt: true },
    orderBy: { capturedAt: "asc" },
  });

  let total = 0n;
  for (const r of rows) total += r.amount;

  return {
    metricKey: "pending_settlements",
    unsettledPaymentCount: rows.length,
    unsettledPaymentPaise: String(total),
    oldestUnsettledAt: rows[0]?.capturedAt?.toISOString() ?? null,
    hasSettlementLines: true,
    unavailableReason: null,
  };
}

export interface BankMovement {
  metricKey: "bank_movement";
  period: { from: string; to: string };
  creditCount: number;
  creditPaise: string;
  debitCount: number;
  debitPaise: string;
  /** credits − debits. Signed, and negative means more left than arrived. */
  netPaise: string;
  /** Zero rows is reported as a fact about coverage, never as a zero balance. */
  hasBankData: boolean;
  unavailableReason: string | null;
}

export async function getBankMovement(organizationId: string, range: ResolvedRange): Promise<BankMovement> {
  const where = { organizationId, valueDate: { gte: range.from, lte: range.to } };
  const [credit, debit, anyRow] = await Promise.all([
    prisma.bankTransaction.aggregate({ where: { ...where, direction: "CREDIT" }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.bankTransaction.aggregate({ where: { ...where, direction: "DEBIT" }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.bankTransaction.findFirst({ where: { organizationId }, select: { id: true } }),
  ]);

  const credits = credit._sum.amount ?? 0n;
  const debits = debit._sum.amount ?? 0n;

  return {
    metricKey: "bank_movement",
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    creditCount: credit._count._all,
    creditPaise: String(credits),
    debitCount: debit._count._all,
    debitPaise: String(debits),
    netPaise: String(credits - debits),
    hasBankData: anyRow !== null,
    unavailableReason:
      anyRow === null
        ? "No bank transactions have been ingested for this organisation. Upload a statement on Connections, or forward it to the ingest address."
        : null,
  };
}

export interface RefundAnalysis {
  metricKey: "refund_analysis";
  period: { from: string; to: string };
  refundCount: number;
  refundedPaise: string;
  byGateway: Array<{ gateway: string; count: number; refundedPaise: string }>;
  largestRefundPaise: string | null;
  /**
   * Dated refund RECORDS, not the refundedAmount field on an order. The two
   * differ when a platform reports a total without the transaction behind it,
   * and the difference is the point: only a dated record can be reconciled
   * against a gateway line.
   */
  ordersWithRefundAmountButNoRecord: number;
}

export async function getRefundAnalysis(organizationId: string, range: ResolvedRange): Promise<RefundAnalysis> {
  const where = { organizationId, processedAt: { gte: range.from, lte: range.to } };

  const [totals, grouped, largest, orphanOrders] = await Promise.all([
    prisma.refund.aggregate({ where, _count: { _all: true }, _sum: { amount: true } }),
    prisma.refund.groupBy({ by: ["gateway"], where, _count: { _all: true }, _sum: { amount: true } }),
    prisma.refund.findFirst({ where, orderBy: { amount: "desc" }, select: { amount: true } }),
    prisma.order.count({
      where: {
        organizationId,
        placedAt: { gte: range.from, lte: range.to },
        refundedAmount: { gt: 0 },
        refunds: { none: {} },
      },
    }),
  ]);

  return {
    metricKey: "refund_analysis",
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    refundCount: totals._count._all,
    refundedPaise: String(totals._sum.amount ?? 0n),
    byGateway: grouped
      .map((g) => ({ gateway: g.gateway ?? "unknown", count: g._count._all, refundedPaise: String(g._sum.amount ?? 0n) }))
      .sort((a, b) => (BigInt(b.refundedPaise) > BigInt(a.refundedPaise) ? 1 : -1)),
    largestRefundPaise: largest ? String(largest.amount) : null,
    ordersWithRefundAmountButNoRecord: orphanOrders,
  };
}
