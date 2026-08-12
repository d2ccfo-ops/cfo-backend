import { prisma } from "../../lib/prisma.js";
import { paiseToRupees, sumPaise } from "./money.js";

// §57 accounts payable, plus the ageing the Overview's "Upcoming payments" card
// needs. Reads VendorBill, which today only the Zoho Books connector writes.
//
// AP Outstanding = invoice total − payments applied − credit notes. The
// accounting system has already done that arithmetic and reports it as
// `balance`, so this uses the balance rather than recomputing it from payments
// we don't have — recomputing would be guessing at something the books already
// know exactly.

export const FORMULA_VERSION = "v1";

// Bills in these states are not liabilities: a draft isn't owed yet and a void
// never was. Counting them would inflate payables with amounts nobody will pay.
const NON_PAYABLE_STATUSES = new Set(["draft", "void", "voided", "cancelled", "paid"]);

const AGEING_BUCKETS = [
  { key: "overdue", label: "Overdue", from: -Infinity, to: -1 },
  { key: "due_0_7", label: "Due in 0–7 days", from: 0, to: 7 },
  { key: "due_8_15", label: "Due in 8–15 days", from: 8, to: 15 },
  { key: "due_16_30", label: "Due in 16–30 days", from: 16, to: 30 },
  { key: "due_30_plus", label: "Due in 30+ days", from: 31, to: Infinity },
];

export async function getPayablesSummary(organizationId: string) {
  const bills = await prisma.vendorBill.findMany({
    where: { organizationId },
    select: {
      vendorName: true,
      billNumber: true,
      dueDate: true,
      billDate: true,
      balanceAmount: true,
      totalAmount: true,
      currency: true,
      status: true,
    },
  });

  const outstanding = bills.filter(
    (b) => !NON_PAYABLE_STATUSES.has(b.status) && b.balanceAmount > 0n
  );

  // Multi-currency guard, same rule as ad spend: summing a USD bill into a
  // rupee total produces a confident, meaningless number. Converting would need
  // an FX rate for the correct date, which nothing here has.
  const byCurrency = new Map<string, bigint>();
  for (const b of outstanding) {
    byCurrency.set(b.currency, (byCurrency.get(b.currency) ?? 0n) + b.balanceAmount);
  }
  const currencies = [...byCurrency.keys()].sort();
  const mixedCurrency = currencies.length > 1;
  const currency = mixedCurrency ? null : (currencies[0] ?? "INR");
  const total = mixedCurrency ? null : sumPaise(outstanding.map((b) => b.balanceAmount));

  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  let noDueDateCount = 0;
  const buckets = AGEING_BUCKETS.map((b) => ({ ...b, amount: 0n, count: 0 }));

  for (const bill of outstanding) {
    if (!bill.dueDate) {
      // A bill with no due date can't be aged. Counted separately rather than
      // dumped into "overdue" (alarming) or "30+ days" (falsely reassuring).
      noDueDateCount += 1;
      continue;
    }
    const days = Math.floor((bill.dueDate.getTime() - startOfToday.getTime()) / (24 * 60 * 60 * 1000));
    const bucket = buckets.find((b) => days >= b.from && days <= b.to);
    if (bucket) {
      bucket.amount += bill.balanceAmount;
      bucket.count += 1;
    }
  }

  // The card headline: what's actually due in the next week, which is the
  // question "upcoming payments" is asking.
  const dueNext7 = buckets.find((b) => b.key === "due_0_7");
  const overdue = buckets.find((b) => b.key === "overdue");

  const upcoming = outstanding
    .filter((b) => b.dueDate !== null)
    .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
    .slice(0, 10)
    .map((b) => ({
      vendorName: b.vendorName,
      billNumber: b.billNumber,
      dueDate: b.dueDate!.toISOString().slice(0, 10),
      balanceMinor: b.balanceAmount.toString(),
      balance: paiseToRupees(b.balanceAmount),
      currency: b.currency,
    }));

  const warnings: string[] = [];
  if (mixedCurrency) {
    warnings.push(
      `Bills span ${currencies.length} currencies (${currencies.join(", ")}); no single total is shown because converting needs an FX rate this system doesn't have.`
    );
  }
  if (noDueDateCount > 0) {
    warnings.push(`${noDueDateCount} outstanding bill(s) have no due date and are excluded from ageing.`);
  }

  return {
    metric: "accounts_payable",
    formulaVersion: FORMULA_VERSION,
    lastCalculatedAt: new Date().toISOString(),
    // Straight from the books rather than derived, but still not reconciled
    // against bank payments — §90.
    status: bills.length === 0 ? "INCOMPLETE" : "ESTIMATED",
    connected: bills.length > 0,
    currency,
    mixedCurrency,
    byCurrency: Object.fromEntries([...byCurrency].map(([c, v]) => [c, v.toString()])),
    totalOutstandingMinor: total?.toString() ?? null,
    totalOutstanding: total == null ? null : paiseToRupees(total),
    billCount: outstanding.length,
    dueNext7Minor: dueNext7 ? dueNext7.amount.toString() : "0",
    dueNext7: dueNext7 ? paiseToRupees(dueNext7.amount) : 0,
    dueNext7Count: dueNext7?.count ?? 0,
    overdueMinor: overdue ? overdue.amount.toString() : "0",
    overdue: overdue ? paiseToRupees(overdue.amount) : 0,
    overdueCount: overdue?.count ?? 0,
    ageing: buckets.map((b) => ({
      key: b.key,
      label: b.label,
      amountMinor: b.amount.toString(),
      amount: paiseToRupees(b.amount),
      count: b.count,
    })),
    upcoming,
    noDueDateCount,
    warnings,
  };
}
