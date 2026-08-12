import { resolveDateRange, shouldPersistSnapshot, type ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { paiseToRupees, sumPaise } from "./money.js";

// Cash received = sum of CREDIT bank transactions for the period. This is
// deliberately *not* "available cash" (that needs an opening balance, which
// nothing in the schema models yet) and *not* "settled payouts across
// channels" (that would mean trusting Payment/Settlement records before
// they're reconciled against what actually landed in the bank). Money that
// hit a bank account, per BankTransaction, is the most trustworthy number
// available without a reconciliation engine — see modules/calc/revenue.ts
// for the same "the calc engine, never the AI, does the arithmetic" rule.

const FORMULA_VERSION = "v1";

export async function getCashReceivedSummary(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({})
) {
  const now = new Date();
  const periodStart = range.from;
  const periodEnd = range.to;

  const [currentCredits, priorCredits] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { organizationId, direction: "CREDIT", valueDate: { gte: periodStart, lte: periodEnd } },
      select: { amount: true },
    }),
    prisma.bankTransaction.findMany({
      where: { organizationId, direction: "CREDIT", valueDate: { gte: range.priorFrom, lte: range.priorTo } },
      select: { amount: true },
    }),
  ]);

  const current = sumPaise(currentCredits.map((t) => t.amount));
  const prior = sumPaise(priorCredits.map((t) => t.amount));
  const changePct = prior === 0n ? null : Math.round((Number(current - prior) / Number(prior)) * 1000) / 10;

  // Same manual findFirst+create/update as revenue.ts/shipments.ts — Prisma
  // can't .upsert() against this compound key with legalEntityId: null.
  // Default period only (see shouldPersistSnapshot in lib/dateRange.ts).
  if (shouldPersistSnapshot(range)) {
    const existingSnapshot = await prisma.metricSnapshot.findFirst({
      where: {
        organizationId,
        legalEntityId: null,
        metricKey: "cash_received_mtd",
        granularity: "MONTHLY",
        periodStart,
        formulaVersion: FORMULA_VERSION,
      },
      select: { id: true },
    });
    if (existingSnapshot) {
      await prisma.metricSnapshot.update({
        where: { id: existingSnapshot.id },
        data: { periodEnd: now, valueMinor: current, computedAt: new Date() },
      });
    } else {
      await prisma.metricSnapshot.create({
        data: {
          organizationId,
          metricKey: "cash_received_mtd",
          granularity: "MONTHLY",
          periodStart,
          periodEnd: now,
          valueMinor: current,
          formulaVersion: FORMULA_VERSION,
          confidence: "ESTIMATED",
        },
      });
    }
  }

  return {
    metricKey: "cash_received_mtd",
    currency: "INR",
    valueMinor: current.toString(),
    value: paiseToRupees(current),
    priorValueMinor: prior.toString(),
    priorValue: paiseToRupees(prior),
    changePct,
    transactionCount: currentCredits.length,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    periodFiltered: true,
    comparison: range.comparison,
    formulaVersion: FORMULA_VERSION,
  };
}

// Available cash = opening balance (a founder-entered anchor, since nothing
// upstream gives us a running balance) plus every BankTransaction since that
// anchor date, per bank connection (BANK or BANK_AA — the CSV upload and
// Setu Account Aggregator paths both land rows in the same BankTransaction
// table, see modules/connectors/setu), summed across all of them. A
// connection with no opening balance set contributes nothing and is listed
// separately in `missingOpeningBalance` — silently treating it as zero would
// understate available cash and nobody would know why.
//
// Deliberately excludes gateway-reported balances (e.g. "Razorpay settled
// balance", which the pre-existing mock card included as a component) —
// that would mean trusting Razorpay's own balance figure instead of money
// that's actually reconciled into a bank account. Once a reconciliation
// engine exists, a settled-but-not-yet-banked component could be added back
// as a clearly-labeled separate line, not folded into this number silently.
const AVAILABLE_CASH_FORMULA_VERSION = "v1";

async function netMovementSince(connectionId: string, from: Date, to: Date): Promise<bigint> {
  const txns = await prisma.bankTransaction.findMany({
    where: { connectionId, valueDate: { gte: from, lte: to } },
    select: { amount: true, direction: true },
  });
  return sumPaise(txns.map((t) => (t.direction === "CREDIT" ? t.amount : -t.amount)));
}

// A balance, not a sum over a period — so a date filter can't mean "add up
// the range". It means "what was the balance at the end of it", which is what
// asOf below is. The comparison point moves with the range for the same
// reason: against a custom range it's the instant before the range started,
// so the delta answers "how much did the balance move over the window you
// picked". (Before date filtering existed this compared against a flat
// now-minus-30-days; for the default month-to-date range the new basis is the
// same calendar day of the previous month, which is a few days' difference at
// most and consistent with every other card on the page.)
export async function getAvailableCashSummary(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({})
) {
  const now = new Date();
  const asOf = range.to;
  const priorAsOf = range.priorTo;
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const bankConnections = await prisma.connection.findMany({
    where: { organizationId, provider: { in: ["BANK", "BANK_AA"] }, status: "ACTIVE" },
    select: { id: true, externalAccountId: true, openingBalanceMinor: true, openingBalanceDate: true },
  });

  const withOpeningBalance = bankConnections.filter(
    (c): c is typeof c & { openingBalanceMinor: bigint; openingBalanceDate: Date } =>
      c.openingBalanceMinor != null && c.openingBalanceDate != null
  );
  const missingOpeningBalance = bankConnections
    .filter((c) => c.openingBalanceMinor == null || c.openingBalanceDate == null)
    .map((c) => ({ connectionId: c.id, label: c.externalAccountId ?? "Bank account" }));

  const perConnection = await Promise.all(
    withOpeningBalance.map(async (c) => {
      const movement = await netMovementSince(c.id, c.openingBalanceDate, asOf);
      const balance = c.openingBalanceMinor + movement;
      const priorEligible = c.openingBalanceDate <= priorAsOf;
      let priorBalance: bigint | null = null;
      if (priorEligible) {
        const priorMovement = await netMovementSince(c.id, c.openingBalanceDate, priorAsOf);
        priorBalance = c.openingBalanceMinor + priorMovement;
      }
      return { connectionId: c.id, label: c.externalAccountId ?? "Bank account", balance, priorBalance, priorEligible };
    })
  );

  const current = sumPaise(perConnection.map((c) => c.balance));
  const priorEligibleConnections = perConnection.filter((c) => c.priorEligible);
  // Only defined if every connection contributing to `current` also has a
  // usable prior figure — otherwise the % change would compare unlike sets
  // of accounts (e.g. one bank added mid-period) and mislead more than help.
  const priorComplete = priorEligibleConnections.length === perConnection.length && perConnection.length > 0;
  const prior = priorComplete ? sumPaise(perConnection.map((c) => c.priorBalance as bigint)) : null;
  const changePct = prior == null || prior === 0n ? null : Math.round((Number(current - prior) / Number(prior)) * 1000) / 10;

  // Today's snapshot means today's balance. Writing one from a request that
  // asked for the balance as of some past date would stamp a historical figure
  // onto today's row — so this only persists for the default (as-of-now) case.
  if (shouldPersistSnapshot(range)) {
    const existingSnapshot = await prisma.metricSnapshot.findFirst({
      where: {
        organizationId,
        legalEntityId: null,
        metricKey: "available_cash",
        granularity: "DAILY",
        periodStart: todayStart,
        formulaVersion: AVAILABLE_CASH_FORMULA_VERSION,
      },
      select: { id: true },
    });
    if (existingSnapshot) {
      await prisma.metricSnapshot.update({
        where: { id: existingSnapshot.id },
        data: { periodEnd: now, valueMinor: current, computedAt: new Date() },
      });
    } else {
      await prisma.metricSnapshot.create({
        data: {
          organizationId,
          metricKey: "available_cash",
          granularity: "DAILY",
          periodStart: todayStart,
          periodEnd: now,
          valueMinor: current,
          formulaVersion: AVAILABLE_CASH_FORMULA_VERSION,
          confidence: missingOpeningBalance.length > 0 ? "ESTIMATED" : "PROVISIONAL",
        },
      });
    }
  }

  return {
    metricKey: "available_cash",
    currency: "INR",
    valueMinor: current.toString(),
    value: paiseToRupees(current),
    priorValueMinor: prior == null ? null : prior.toString(),
    priorValue: prior == null ? null : paiseToRupees(prior),
    priorComplete,
    changePct,
    asOf: asOf.toISOString(),
    // A balance responds to the range's end date, not its length — the UI
    // should say "as of <date>", never "for <range>".
    periodFiltered: true,
    pointInTime: true,
    comparison: range.comparison,
    connections: perConnection.map((c) => ({
      connectionId: c.connectionId,
      label: c.label,
      balanceMinor: c.balance.toString(),
      balance: paiseToRupees(c.balance),
    })),
    missingOpeningBalance,
    formulaVersion: AVAILABLE_CASH_FORMULA_VERSION,
  };
}
