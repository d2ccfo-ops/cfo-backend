import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { describeRange, withDateRange } from "../lib/dateRange.js";
import { requireAuth } from "../middleware/auth.js";

export const settlementsRouter = Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_LINES_PER_PAYOUT = 500;

// ---------------------------------------------------------------------------
// GET /settlements
// ---------------------------------------------------------------------------
// A payout is a real, dated, UTR-bearing transfer a provider says it made. This
// endpoint did not exist, which is why the Settlements page stated "no
// settlement records exist for this organisation" while 37 payouts and 555
// lines sat in the database — the page had no way to ask.
//
// Scoped by the payout's own settledAt rather than by the placedAt of the
// orders inside it: a payout is an event in its own right, and asking "which
// payouts landed in August" must not depend on when the underlying orders were
// taken. This is the one place in the product where the period means something
// other than order date, so it is stated in the response.
settlementsRouter.get("/", ...requireAuth, withDateRange, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const range = req.dateRange!;

  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  const settledInRange: Prisma.SettlementWhereInput = {
    organizationId,
    settledAt: { gte: range.from, lte: range.to },
  };

  const [payouts, windowTotals, allTime, coverage, lineTypeRows, unresolved] = await Promise.all([
    prisma.settlement.findMany({
      where: settledInRange,
      orderBy: [{ settledAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        externalSettlementId: true,
        utr: true,
        settledAt: true,
        amount: true,
        feeAmount: true,
        status: true,
        provider: true,
        kind: true,
        _count: { select: { lines: true } },
      },
    }),
    prisma.settlement.aggregate({
      where: settledInRange,
      _count: { _all: true },
      _sum: { amount: true, feeAmount: true },
    }),
    // Stated alongside the window so a reader who narrows the picker to a week
    // and sees two payouts knows whether that is all there is.
    prisma.settlement.aggregate({
      where: { organizationId },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.settlement.aggregate({
      where: { organizationId },
      _min: { settledAt: true },
      _max: { settledAt: true },
    }),
    // Gross and fee live on the LINES; the payout's own amount is the net that
    // moved. Summing lines is what lets the page show an effective fee rate
    // instead of a deduction with no denominator.
    prisma.settlementLine.groupBy({
      by: ["type"],
      where: { organizationId, settlement: settledInRange },
      _count: { _all: true },
      _sum: { grossAmount: true, feeAmount: true, netAmount: true },
    }),
    // Lines the provider stated that we could not attach to anything we hold.
    // A real and reportable state (§ the provider settled something we never
    // ingested), not a row to hide.
    prisma.settlementLine.count({
      where: {
        organizationId,
        settlement: settledInRange,
        paymentId: null,
        shipmentId: null,
        type: { not: "ADJUSTMENT" },
      },
    }),
  ]);

  const hasMore = payouts.length > limit;
  const page = hasMore ? payouts.slice(0, limit) : payouts;

  res.json({
    period: { from: range.from.toISOString(), to: range.to.toISOString(), isDefault: range.isDefault },
    window: describeRange(range),
    // Named explicitly because it is NOT the order-date window every other page
    // uses, and a reader comparing this total to Revenue deserves to know why
    // they differ.
    periodBasis: "payout date",
    payouts: page.map((p) => ({
      id: p.id,
      externalId: p.externalSettlementId,
      utr: p.utr,
      settledAt: p.settledAt?.toISOString() ?? null,
      netAmount: p.amount.toString(),
      feeAmount: p.feeAmount.toString(),
      status: p.status,
      provider: p.provider,
      kind: p.kind,
      lineCount: p._count.lines,
    })),
    hasMore,
    totals: {
      inPeriod: {
        count: windowTotals._count._all,
        netAmount: (windowTotals._sum.amount ?? 0n).toString(),
        feeAmount: (windowTotals._sum.feeAmount ?? 0n).toString(),
      },
      allTime: {
        count: allTime._count._all,
        netAmount: (allTime._sum.amount ?? 0n).toString(),
      },
      byLineType: lineTypeRows.map((r) => ({
        type: r.type,
        count: r._count._all,
        grossAmount: (r._sum.grossAmount ?? 0n).toString(),
        feeAmount: (r._sum.feeAmount ?? 0n).toString(),
        netAmount: (r._sum.netAmount ?? 0n).toString(),
      })),
      unresolvedLines: unresolved,
    },
    coverage: {
      earliest: coverage._min.settledAt?.toISOString() ?? null,
      latest: coverage._max.settledAt?.toISOString() ?? null,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /settlements/:id/lines
// ---------------------------------------------------------------------------
// What a payout is actually made of, with the order number beside each line —
// the join that makes a settlement statement answerable rather than a wall of
// gateway ids. Resolved through payment→order and shipment→order, because a
// funnel like GoKwik settles both prepaid captures and COD cash.
settlementsRouter.get("/:id/lines", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;

  const settlement = await prisma.settlement.findFirst({
    where: { id: req.params.id, organizationId },
    select: {
      id: true,
      externalSettlementId: true,
      utr: true,
      settledAt: true,
      amount: true,
      feeAmount: true,
      provider: true,
      kind: true,
    },
  });
  // Scoped by organizationId in the same query rather than fetched then
  // checked: a payout belonging to another org must be indistinguishable from
  // one that does not exist.
  if (!settlement) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const lines = await prisma.settlementLine.findMany({
    where: { organizationId, settlementId: settlement.id },
    take: MAX_LINES_PER_PAYOUT,
    orderBy: { grossAmount: "desc" },
    select: {
      id: true,
      type: true,
      externalReference: true,
      grossAmount: true,
      feeAmount: true,
      netAmount: true,
      payment: { select: { id: true, order: { select: { id: true, orderNumber: true, grossAmount: true } } } },
      shipment: { select: { id: true, awbCode: true, order: { select: { id: true, orderNumber: true, grossAmount: true } } } },
    },
  });

  res.json({
    settlement: {
      id: settlement.id,
      externalId: settlement.externalSettlementId,
      utr: settlement.utr,
      settledAt: settlement.settledAt?.toISOString() ?? null,
      netAmount: settlement.amount.toString(),
      feeAmount: settlement.feeAmount.toString(),
      provider: settlement.provider,
      kind: settlement.kind,
    },
    lines: lines.map((l) => {
      const order = l.payment?.order ?? l.shipment?.order ?? null;
      return {
        id: l.id,
        type: l.type,
        reference: l.externalReference,
        grossAmount: l.grossAmount.toString(),
        feeAmount: l.feeAmount.toString(),
        netAmount: l.netAmount.toString(),
        awb: l.shipment?.awbCode ?? null,
        orderId: order?.id ?? null,
        orderNumber: order?.orderNumber ?? null,
        // The order's own total, so a line that settles only part of an order
        // (a PPCOD deposit: ₹21 against a ₹1,498 order) reads as partial
        // rather than as the whole thing.
        orderTotal: order?.grossAmount.toString() ?? null,
      };
    }),
    truncated: lines.length === MAX_LINES_PER_PAYOUT,
  });
});
