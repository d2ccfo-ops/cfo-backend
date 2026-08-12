import { prisma } from "../../lib/prisma.js";
import { paiseToRupees, sumPaise } from "./money.js";
import { getAvailableCashSummary } from "./cash.js";

// §55 daily cash movement and §85 cash runway.
//
// The rule that shapes this module is §85's: **only calculate runway when net
// burn is positive.** A business taking in more cash than it spends has no
// runway — it has infinite runway — and rendering "247 months" or, worse, a
// negative number, is meaningless. This returns runwayMonths: null in that case
// with an explicit reason, rather than dividing and hoping.
//
// Burn comes from BankTransaction (real money in and out) rather than from
// revenue minus costs. §44: the ultimate cash truth is matched bank credit.

export const FORMULA_VERSION = "v1";

const LOOKBACK_DAYS = 90;

export async function getBurnAndRunway(organizationId: string) {
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [txns, cash] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { organizationId, valueDate: { gte: since, lte: now } },
      select: { amount: true, direction: true, valueDate: true },
    }),
    getAvailableCashSummary(organizationId),
  ]);

  const credits = txns.filter((t) => t.direction === "CREDIT");
  const debits = txns.filter((t) => t.direction === "DEBIT");
  const inflow = sumPaise(credits.map((t) => t.amount));
  const outflow = sumPaise(debits.map((t) => t.amount));

  // Actual observed window, not the nominal 90 days — with only a handful of
  // transactions, annualising over a period we have no data for would invent a
  // trend. If the earliest transaction is 12 days old, this is a 12-day rate.
  const dates = txns.map((t) => t.valueDate.getTime());
  const observedDays =
    dates.length === 0 ? 0 : Math.max(1, Math.round((now.getTime() - Math.min(...dates)) / (24 * 60 * 60 * 1000)));

  const netBurn = outflow - inflow; // positive = burning
  const monthlyNetBurn =
    observedDays === 0 ? 0n : (netBurn * 30n) / BigInt(observedDays);

  const availableCash = BigInt(cash.valueMinor);
  const burning = monthlyNetBurn > 0n;

  let runwayMonths: number | null = null;
  let runwayReason: string;
  if (txns.length === 0) {
    runwayReason = "No bank transactions in the last 90 days — nothing to measure burn from.";
  } else if (!burning) {
    // The good case, and it still has to be said out loud rather than shown as
    // a big number.
    runwayReason = "Net cash inflow over the observed period — there is no burn to run out of.";
  } else if (availableCash <= 0n) {
    runwayReason = "No available cash figure — set an opening balance on a bank connection (§54).";
  } else {
    runwayMonths = Math.round((Number(availableCash) / Number(monthlyNetBurn)) * 10) / 10;
    runwayReason = "Available cash ÷ monthly net burn.";
  }

  const warnings: string[] = [];
  if (txns.length > 0 && txns.length < 30) {
    warnings.push(
      `Only ${txns.length} bank transactions in the window — this rate is directional at best, not a reliable burn figure.`
    );
  }
  if (observedDays > 0 && observedDays < 30) {
    warnings.push(`Observed window is ${observedDays} days; the monthly figure is extrapolated from it.`);
  }
  if (cash.missingOpeningBalance.length > 0) {
    warnings.push(
      `${cash.missingOpeningBalance.length} bank connection(s) have no opening balance and are excluded from available cash (§54).`
    );
  }

  return {
    metric: "burn_and_runway",
    currency: "INR",
    formulaVersion: FORMULA_VERSION,
    lastCalculatedAt: new Date().toISOString(),
    status: txns.length < 30 ? "INCOMPLETE" : "ESTIMATED",
    observedDays,
    transactionCount: txns.length,

    // §55
    inflowMinor: inflow.toString(),
    inflow: paiseToRupees(inflow),
    outflowMinor: outflow.toString(),
    outflow: paiseToRupees(outflow),
    netMovementMinor: (inflow - outflow).toString(),
    netMovement: paiseToRupees(inflow - outflow),

    // §85
    burning,
    monthlyNetBurnMinor: monthlyNetBurn.toString(),
    monthlyNetBurn: paiseToRupees(monthlyNetBurn),
    availableCashMinor: availableCash.toString(),
    availableCash: paiseToRupees(availableCash),
    runwayMonths,
    runwayReason,
    warnings,
  };
}
