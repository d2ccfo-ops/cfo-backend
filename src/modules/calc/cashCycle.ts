import { prisma } from "../../lib/prisma.js";
import type { ResolvedRange } from "../../lib/dateRange.js";
import { getInventoryValueSummary } from "./inventory.js";
import { getPayablesSummary } from "./payables.js";
import { paiseToRupees } from "./money.js";

// §14 cash conversion cycle (P6.2).
//
// CCC = DIO + DSO − DPO. How many days a rupee is tied up between paying for
// stock and being paid for it. For a D2C brand it is the single number that
// explains why a profitable month can still leave the bank account emptier.
//
// EVERY COMPONENT HERE IS EITHER MEASURED OR ABSENT. This is the calculation
// most likely to be quietly wrong, because each of the three terms has a
// denominator that can be zero and a numerator that can be missing, and the
// conventional response is to substitute an industry figure. That is how a
// dashboard ends up reporting a 47-day cycle for a business nobody measured.
//
// So: a term with no data is null, the whole CCC is null when any term is
// null, and the reason is stated per term. A partial cycle is not reported as
// a cycle.

// v2 (2026-08-13, §92): DIO values stock at LANDED COST. v1 divided a
// retail-priced inventory by a cost-priced COGS, overstating DIO — and
// therefore CCC — by the gross-margin multiple, while reporting both as
// measured. Every v1 DIO/CCC figure is wrong by that factor, so a v1 snapshot
// must not be compared against a v2 one.
export const CASH_CYCLE_VERSION = "v2";

// COVERAGE THRESHOLDS, and the reason they exist is a bug this module had on
// its first run against real data: it reported DIO of 1,684,116 days and DSO
// of 724 days. Both were arithmetically correct. Both were meaningless.
//
// DIO divides inventory by daily COGS, and COGS came from the 0.4% of order
// lines that carry a cost — so the denominator was a sample and the quotient
// was the ratio between a real inventory and a fictional one. DSO divides
// unreceived revenue by daily revenue, and with 19 bank transactions in the
// database almost all revenue reads as unreceived, so DSO converged on the
// length of the window: it was measuring the missing bank feed, not the
// collection period.
//
// Guarding a ZERO denominator is not enough. A denominator built from 0.4% of
// the population is not zero and is not usable either, and a number that is
// wrong by three orders of magnitude is more dangerous than a blank — nobody
// audits a figure that has already been rendered.
const MIN_COGS_LINE_COVERAGE_PCT = 60;
const MIN_RECEIPT_COVERAGE_PCT = 40;

// A LAST GUARD, on the OUTPUT rather than the inputs.
//
// After excluding placeholder stock quantities (see inventory.ts) the pilot
// org's DIO fell from 1,684,116 days to 41,432. Still absurd — and the
// temptation at that point is to keep tightening the input thresholds until
// the number looks plausible, which is precisely the failure this module was
// written to prevent. Tuning until it looks right IS fabrication, just slower.
//
// So there is a bound on the answer itself. Two years of stock is already
// far beyond any real D2C position; past that, the inventory snapshot and the
// period's COGS are describing incompatible populations — a current catalogue
// against a costed sample — and the ratio between them means nothing however
// carefully each side was computed. Both inputs are reported so the reader can
// see which one is wrong.
const MAX_PLAUSIBLE_DIO_DAYS = 730;
const MAX_PLAUSIBLE_DPO_DAYS = 365;

export interface CycleTerm {
  key: "dio" | "dso" | "dpo";
  label: string;
  /** Null when it cannot be measured. Never a default or an industry figure. */
  days: number | null;
  /** What it is made of, so the number can be argued with. */
  numerator: number | null;
  denominator: number | null;
  reason: string | null;
}

export interface CashConversionCycle {
  metricKey: "cash_conversion_cycle";
  formulaVersion: string;
  period: { from: string; to: string; days: number };
  /** What the terms were computed from, so a null can be acted on. */
  coverage: { cogsLinePct: number; receiptPct: number; minCogsLinePct: number; minReceiptPct: number };
  terms: CycleTerm[];
  /** Null when ANY term is null. A partial cycle is not a cycle. */
  cycleDays: number | null;
  interpretation: string;
  warnings: string[];
}

export async function getCashConversionCycle(
  organizationId: string,
  range: ResolvedRange
): Promise<CashConversionCycle> {
  const periodDays = Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000));

  const [inventory, payables, orders, cogsRows, receipts, totalLines] = await Promise.all([
    getInventoryValueSummary(organizationId),
    getPayablesSummary(organizationId),
    prisma.order.aggregate({
      where: { organizationId, placedAt: { gte: range.from, lte: range.to }, cancelledAt: null },
      _sum: { grossAmount: true, taxAmount: true, refundedAmount: true },
      _count: { _all: true },
    }),
    // COGS over the period, from the line items that HAVE a cost. Lines
    // without one are excluded rather than counted as zero — a zero-cost line
    // would understate COGS and inflate DIO by exactly the cost nobody entered.
    prisma.orderLineItem.aggregate({
      where: { order: { organizationId, placedAt: { gte: range.from, lte: range.to }, cancelledAt: null }, cogsAmount: { not: null } },
      _sum: { cogsAmount: true },
      _count: { _all: true },
    }),
    prisma.bankTransaction.aggregate({
      where: { organizationId, direction: "CREDIT", valueDate: { gte: range.from, lte: range.to } },
      _sum: { amount: true },
    }),
    // The denominator of the denominator: how many order lines exist at all,
    // so a COGS sum can be judged against the population it was drawn from.
    prisma.orderLineItem.count({
      where: { order: { organizationId, placedAt: { gte: range.from, lte: range.to }, cancelledAt: null } },
    }),
  ]);

  const netRevenueMinor =
    (orders._sum.grossAmount ?? 0n) - (orders._sum.taxAmount ?? 0n) - (orders._sum.refundedAmount ?? 0n);
  const cogsMinor = cogsRows._sum.cogsAmount ?? 0n;
  // ---------------------------------------------------------------------------
  // COST BASIS, NOT RETAIL — the two sides of DIO must be in the same units
  // ---------------------------------------------------------------------------
  // This read `inventory.valueMinor`, which values stock at the Shopify SELLING
  // price, and divided it by a landed-cost COGS. Numerator at retail over
  // denominator at cost overstates DIO by the gross-margin multiple: a brand on
  // 60% margins read roughly 2.5x too many days, CCC inherited it, and all
  // three terms were presented as measured with reason: null.
  //
  // The evidence envelope compounded it by describing the correct behaviour
  // rather than the actual one — "Stock on hand valued at landed cost" — so a
  // reader checking the definition was told the bug was not there.
  const inventoryMinor = BigInt(inventory.costValueMinor ?? "0");
  const inventoryCostedUnits = inventory.costedUnits ?? 0;
  const inventoryUncostedUnits = inventory.uncostedUnits ?? 0;
  const inventoryUnits = inventoryCostedUnits + inventoryUncostedUnits;
  // A cost-basis total covering a fraction of the stock is not a smaller
  // inventory — it is an unknown one, and dividing by COGS would understate DIO
  // by exactly the share of units with no cost. Same refusal the COGS-coverage
  // gate below already makes for the denominator.
  const inventoryCostCoveragePct =
    inventoryUnits === 0 ? 0 : Math.round((inventoryCostedUnits / inventoryUnits) * 1000) / 10;
  const payablesMinor = BigInt(payables.totalOutstandingMinor ?? "0");
  const receiptsMinor = receipts._sum.amount ?? 0n;

  const terms: CycleTerm[] = [];
  const warnings: string[] = [];

  const cogsCoveragePct = totalLines === 0 ? 0 : Math.round((cogsRows._count._all / totalLines) * 1000) / 10;
  const receiptCoveragePct =
    netRevenueMinor === 0n ? 0 : Math.round((Number(receiptsMinor) / Number(netRevenueMinor)) * 1000) / 10;
  const cogsUsable = cogsMinor > 0n && cogsCoveragePct >= MIN_COGS_LINE_COVERAGE_PCT;
  // The numerator needs the same standard as the denominator. Reusing the COGS
  // threshold on purpose: both answer "is enough of this population costed for
  // the total to mean anything", and a second, different number here would be
  // one more constant nobody could justify.
  const inventoryUsable = inventoryUnits > 0 && inventoryCostCoveragePct >= MIN_COGS_LINE_COVERAGE_PCT;
  const receiptsUsable = receiptsMinor > 0n && receiptCoveragePct >= MIN_RECEIPT_COVERAGE_PCT;

  // ---- DIO: how long stock sits before it sells. -----------------------------
  if (!cogsUsable || !inventoryUsable) {
    terms.push({
      key: "dio",
      label: "Days inventory outstanding",
      days: null,
      numerator: paiseToRupees(inventoryMinor),
      denominator: paiseToRupees(cogsMinor),
      reason: !inventoryUsable
        ? inventoryUnits === 0
          ? "No stock on hand to value, so there is nothing to divide."
          : `Only ${inventoryCostCoveragePct}% of units on hand carry a product cost, so stock cannot be valued at cost. Valuing the rest at its selling price and dividing by a cost-based COGS would overstate DIO by the whole gross margin. ${MIN_COGS_LINE_COVERAGE_PCT}% coverage is needed.`
        : cogsMinor === 0n
          ? "No costed order lines in this period, so there is no cost of goods sold to divide by. Enter product costs on the Costs page."
          : `Only ${cogsCoveragePct}% of order lines carry a product cost, so the cost of goods sold here is a sample of ${cogsRows._count._all} lines out of ${totalLines}, not the period's COGS. Dividing inventory by it would report a number wrong by orders of magnitude. ${MIN_COGS_LINE_COVERAGE_PCT}% coverage is needed.`,
    });
  } else {
    const dailyCogs = Number(cogsMinor) / periodDays;
    const dioDays = Math.round((Number(inventoryMinor) / dailyCogs) * 10) / 10;
    terms.push(
      dioDays > MAX_PLAUSIBLE_DIO_DAYS
        ? {
            key: "dio",
            label: "Days inventory outstanding",
            days: null,
            numerator: paiseToRupees(inventoryMinor),
            denominator: paiseToRupees(cogsMinor),
            reason: `The arithmetic gives ${dioDays.toLocaleString("en-IN")} days, which is not a stock position — past ${MAX_PLAUSIBLE_DIO_DAYS} days the inventory snapshot and the period's cost of goods sold are describing incompatible populations. Inventory reads as ₹${paiseToRupees(inventoryMinor).toLocaleString("en-IN")} against ₹${paiseToRupees(cogsMinor).toLocaleString("en-IN")} of COGS over ${periodDays} days; one of those two is wrong and the ratio cannot say which.`,
          }
        : {
            key: "dio",
            label: "Days inventory outstanding",
            days: dioDays,
            numerator: paiseToRupees(inventoryMinor),
            denominator: paiseToRupees(cogsMinor),
            reason: null,
          }
    );
  }

  // ---- DSO: how long money takes to arrive after a sale. ---------------------
  if (netRevenueMinor === 0n) {
    terms.push({
      key: "dso",
      label: "Days sales outstanding",
      days: null,
      numerator: null,
      denominator: 0,
      reason: "No net revenue in this period, so there is nothing to be outstanding.",
    });
  } else if (!receiptsUsable) {
    terms.push({
      key: "dso",
      label: "Days sales outstanding",
      days: null,
      numerator: null,
      denominator: paiseToRupees(netRevenueMinor),
      reason:
        receiptsMinor === 0n
          ? "No bank credits in this period, so how long money takes to arrive cannot be measured. Connect a bank account or upload a statement."
          : `Bank credits cover only ${receiptCoveragePct}% of net revenue, so almost all of it reads as unreceived and DSO would converge on the length of the window — measuring the missing bank feed rather than the collection period. ${MIN_RECEIPT_COVERAGE_PCT}% coverage is needed.`,
    });
  } else {
    // Receivable = revenue recognised that has not yet been received. Bounded
    // at zero: receipts can exceed period revenue when an earlier month's
    // settlements land inside this window, and a negative DSO is meaningless.
    const outstanding = netRevenueMinor > receiptsMinor ? netRevenueMinor - receiptsMinor : 0n;
    const dailyRevenue = Number(netRevenueMinor) / periodDays;
    terms.push({
      key: "dso",
      label: "Days sales outstanding",
      days: Math.round((Number(outstanding) / dailyRevenue) * 10) / 10,
      numerator: paiseToRupees(outstanding),
      denominator: paiseToRupees(netRevenueMinor),
      reason: null,
    });
    if (receiptsMinor > netRevenueMinor) {
      warnings.push(
        "Bank credits exceeded net revenue in this period, which usually means earlier settlements landed inside the window. DSO is reported as 0 rather than negative."
      );
    }
  }

  // ---- DPO: how long we take to pay suppliers. -------------------------------
  if (!cogsUsable) {
    terms.push({
      key: "dpo",
      label: "Days payables outstanding",
      days: null,
      numerator: paiseToRupees(payablesMinor),
      denominator: paiseToRupees(cogsMinor),
      reason:
        cogsMinor === 0n
          ? "No costed order lines in this period, so there is no purchase cost to divide by."
          : `Only ${cogsCoveragePct}% of order lines carry a product cost — too thin a denominator to divide payables by.`,
    });
  } else if (payablesMinor === 0n) {
    terms.push({
      key: "dpo",
      label: "Days payables outstanding",
      days: null,
      numerator: 0,
      denominator: paiseToRupees(cogsMinor),
      reason:
        "No outstanding supplier bills are recorded. That is either genuinely nothing owed or no accounting feed — the two are indistinguishable from here, so this is reported as unknown rather than as zero days.",
    });
  } else {
    const dailyCogs = Number(cogsMinor) / periodDays;
    const dpoDays = Math.round((Number(payablesMinor) / dailyCogs) * 10) / 10;
    terms.push(
      dpoDays > MAX_PLAUSIBLE_DPO_DAYS
        ? {
            key: "dpo",
            label: "Days payables outstanding",
            days: null,
            numerator: paiseToRupees(payablesMinor),
            denominator: paiseToRupees(cogsMinor),
            reason: `The arithmetic gives ${dpoDays.toLocaleString("en-IN")} days. No supplier waits a year; the payables balance and the period's purchase cost are not describing the same population.`,
          }
        : {
            key: "dpo",
            label: "Days payables outstanding",
            days: dpoDays,
            numerator: paiseToRupees(payablesMinor),
            denominator: paiseToRupees(cogsMinor),
            reason: null,
          }
    );
  }

  const dio = terms.find((t) => t.key === "dio")!.days;
  const dso = terms.find((t) => t.key === "dso")!.days;
  const dpo = terms.find((t) => t.key === "dpo")!.days;

  // Null when ANY term is null. A cycle missing a term is not a shorter cycle,
  // it is an unknown one, and reporting DIO + DSO as "the cycle" would flatter
  // the business by exactly however long it takes to pay its suppliers.
  const cycleDays = dio === null || dso === null || dpo === null ? null : Math.round((dio + dso - dpo) * 10) / 10;

  const missing = terms.filter((t) => t.days === null).map((t) => t.label);
  if (missing.length > 0) {
    warnings.push(
      `The cycle cannot be computed: ${missing.join(" and ")} could not be measured. A cycle missing a term is not a shorter cycle, it is an unknown one.`
    );
  }

  return {
    metricKey: "cash_conversion_cycle",
    formulaVersion: CASH_CYCLE_VERSION,
    period: { from: range.from.toISOString(), to: range.to.toISOString(), days: periodDays },
    coverage: {
      cogsLinePct: cogsCoveragePct,
      receiptPct: receiptCoveragePct,
      minCogsLinePct: MIN_COGS_LINE_COVERAGE_PCT,
      minReceiptPct: MIN_RECEIPT_COVERAGE_PCT,
    },
    terms,
    cycleDays,
    interpretation:
      cycleDays === null
        ? "Not enough measured inputs to state a cycle."
        : cycleDays <= 0
          ? `Cash comes in ${Math.abs(cycleDays)} days before it goes out. Suppliers and customers are effectively funding the working capital.`
          : `A rupee is tied up for ${cycleDays} days between paying for stock and being paid for it. Growing faster consumes cash at that rate.`,
    warnings,
  };
}
