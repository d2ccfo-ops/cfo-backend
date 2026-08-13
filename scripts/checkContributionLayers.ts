import { resolveDateRange } from "../src/lib/dateRange.js";
import { prisma } from "../src/lib/prisma.js";
import { getContributionMargin } from "../src/modules/calc/contribution.js";
import { getFreightSplit, getTransactionFees } from "../src/modules/calc/fulfilmentCosts.js";

// P6.5's layers, asserted against the real database rather than a fixture.
//
// The property that matters most here is NOT that the numbers are right — it is
// that no rupee is counted twice. Four of these layers were built in one pass
// and three of them draw on overlapping sources:
//
//   · Shipment.freightAmount is the sum of BOTH legs, so a naive reverse layer
//     double-counts every return against forward shipping.
//   · Payment.feeAmount carries gateway AND marketplace fees, so splitting them
//     by provider is the only thing stopping CM2 being deducted twice.
//   · RTO cost is built from freight that is already inside two other layers.
//
// Each of those would produce a lower margin that looks entirely reasonable.
// None would throw. So each gets an assertion that compares the layers against
// the underlying rows directly.
//
// Run with: npx tsx scripts/checkContributionLayers.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const inr = (minor: bigint | string) => `₹${(Number(BigInt(minor)) / 100).toLocaleString("en-IN")}`;

async function checkOrg(orgId: string, orgName: string) {
  console.log(`\n=== ${orgName}`);
  const range = resolveDateRange({ from: "2025-08-01", to: "2026-08-12" });
  const cm = await getContributionMargin(orgId, range);
  const byKey = new Map(cm.layers.map((l) => [l.key, l]));

  const layer = (k: string) => byKey.get(k)!;
  const amt = (k: string) => BigInt(layer(k).amountMinor);

  // ---------------------------------------------------------------------------
  // NO RUPEE COUNTED TWICE
  // ---------------------------------------------------------------------------
  const split = await getFreightSplit(orgId, range);

  // Forward + reverse must equal the total freight billed. If forward were
  // still reading raw freightAmount, this sum would exceed the total by exactly
  // the reverse amount — which is the bug, stated as arithmetic.
  const totalBilled = await prisma.shipment.aggregate({
    where: { organizationId: orgId, createdAt: { gte: range.from, lte: range.to }, freightAmount: { not: null } },
    _sum: { freightAmount: true },
  });
  const billedSum = totalBilled._sum.freightAmount ?? 0n;
  ok(
    "forward + reverse shipping = total freight billed",
    amt("forwardShipping") + amt("reverseShipping") === billedSum,
    `${inr(amt("forwardShipping"))} + ${inr(amt("reverseShipping"))} vs ${inr(billedSum)}`
  );

  // Reverse must equal the return-leg rows, not a share of anything.
  // FreightInvoiceLine carries shipmentId but no `shipment` relation, so the
  // in-period shipments are resolved first and matched by id.
  const inPeriodShipments = await prisma.shipment.findMany({
    where: { organizationId: orgId, createdAt: { gte: range.from, lte: range.to }, freightAmount: { not: null } },
    select: { id: true },
  });
  const returnLegSum = await prisma.freightInvoiceLine.aggregate({
    where: {
      organizationId: orgId,
      isReturnLeg: true,
      shipmentId: { in: inPeriodShipments.map((s) => s.id) },
    },
    _sum: { amount: true },
  });
  ok(
    "reverse shipping equals the billed return legs exactly",
    amt("reverseShipping") === (returnLegSum._sum.amount ?? 0n),
    `${inr(amt("reverseShipping"))} vs ${inr(returnLegSum._sum.amount ?? 0n)}`
  );
  ok("forward shipping is never negative", amt("forwardShipping") >= 0n, inr(amt("forwardShipping")));

  // Gateway and marketplace must partition the payments, not overlap.
  const fees = await getTransactionFees(orgId, range);
  const allPaymentFees = await prisma.payment.aggregate({
    where: { organizationId: orgId, capturedAt: { gte: range.from, lte: range.to } },
    _sum: { feeAmount: true },
    _count: true,
  });
  // A gateway fee is stated either on the capture (Razorpay) or on the payout
  // line that settled it (GoKwik) — so the total is the union of both sources
  // with the payment's own figure winning, never their sum. This asserts
  // exactly that: everything Payment states, plus the settlement fees for
  // payments that state nothing.
  const settlementOnlyFees = await prisma.settlementLine.findMany({
    where: {
      organizationId: orgId,
      type: "PAYMENT",
      paymentId: { not: null },
      // > 0 mirrors the calc: feeAmount defaults to 0, so a zero cannot be told
      // apart from a file that never had a fee column.
      feeAmount: { gt: 0 },
      settlement: { settledAt: { gte: range.from, lte: range.to } },
      payment: { feeAmount: null, capturedAt: { gte: range.from, lte: range.to } },
    },
    select: { paymentId: true, feeAmount: true },
  });
  const expectedFees =
    (allPaymentFees._sum.feeAmount ?? 0n) + settlementOnlyFees.reduce((s, l) => s + (l.feeAmount ?? 0n), 0n);
  ok(
    "gateway + marketplace fees = every stated fee, counted once",
    fees.gatewayMinor + fees.marketplaceMinor === expectedFees,
    `${inr(fees.gatewayMinor)} + ${inr(fees.marketplaceMinor)} vs ${inr(expectedFees)}`
  );
  // The double count this replaced the old assertion to catch: a payment whose
  // fee is stated in BOTH places must contribute its rupees once.
  const feeStatedTwice = await prisma.settlementLine.count({
    where: {
      organizationId: orgId,
      type: "PAYMENT",
      feeAmount: { gt: 0 },
      payment: { feeAmount: { not: null }, capturedAt: { gte: range.from, lte: range.to } },
    },
  });
  ok(
    "a fee stated on both the capture and the payout is counted once",
    fees.gatewayMinor + fees.marketplaceMinor <= expectedFees,
    `${feeStatedTwice} payments state it twice`
  );
  ok(
    "gateway + marketplace payment counts partition the total",
    fees.gatewayPayments + fees.marketplacePayments === allPaymentFees._count,
    `${fees.gatewayPayments} + ${fees.marketplacePayments} vs ${allPaymentFees._count}`
  );

  // ---------------------------------------------------------------------------
  // THE MEMO IS NOT DEDUCTED
  // ---------------------------------------------------------------------------
  ok("RTO cost is flagged as a memo", layer("rtoCost").memo === true);
  const cm0 = BigInt(cm.levels.cm0.valueMinor);
  const cm1 = BigInt(cm.levels.cm1.valueMinor);
  const expectedCm1 = cm0 - amt("packaging") - amt("forwardShipping") - amt("reverseShipping");
  ok("CM1 excludes the RTO memo", cm1 === expectedCm1, `${inr(cm1)} vs ${inr(expectedCm1)}`);
  if (amt("rtoCost") > 0n) {
    // Stated as an inequality rather than an equality: if the memo WERE
    // deducted, CM1 would be exactly this much lower.
    ok(
      "CM1 is not silently reduced by the memo amount",
      cm1 !== expectedCm1 - amt("rtoCost"),
      `memo ${inr(amt("rtoCost"))}`
    );
  }

  // A memo with no source must not drag CM1's reliability down — every rupee it
  // would carry is already measured in the layers above.
  if (!layer("rtoCost").hasSource && layer("packaging").covered && layer("forwardShipping").covered && layer("reverseShipping").covered) {
    ok("an unmeasurable memo does not make CM1 unreliable", cm.levels.cm1.reliable === true);
  }

  // ---------------------------------------------------------------------------
  // MISSING IS NOT ZERO
  // ---------------------------------------------------------------------------
  for (const key of ["packaging", "reverseShipping", "codFees", "marketplaceFees"]) {
    const l = layer(key);
    // The rule the whole honesty layer rests on: a layer contributing zero must
    // either be measured as zero or declare itself uncovered. Silent zero is
    // the failure mode.
    if (BigInt(l.amountMinor) === 0n) {
      ok(`${l.label}: a zero is either measured or declared`, l.covered || !l.hasSource, l.note.slice(0, 70));
    }
    // Whatever it says, the note must never be empty — an uncovered layer with
    // no explanation sends someone hunting for a bug that is a missing upload.
    ok(`${l.label}: says why`, l.note.length > 10);
  }

  // COD's period-vs-org distinction, the subtlest one here: an org that
  // uploaded a statement last March does not thereby know August's COD cost.
  if (fees.codOrders > 0 && fees.codLines === 0) {
    ok(
      "COD fees are uncovered when this period's remittance is missing",
      layer("codFees").covered === false,
      `${fees.codOrders} COD orders, 0 remittance lines`
    );
    ok("…and the note names the number of uncovered orders", layer("codFees").note.includes(String(fees.codOrders)));
  }

  // ---------------------------------------------------------------------------
  // THE CHAIN STILL DESCENDS
  // ---------------------------------------------------------------------------
  const cm2 = BigInt(cm.levels.cm2.valueMinor);
  const cm3 = BigInt(cm.levels.cm3.valueMinor);
  ok("CM0 ≥ CM1 ≥ CM2 ≥ CM3", cm0 >= cm1 && cm1 >= cm2 && cm2 >= cm3);
  ok("reliability is cumulative, never improving downward", [
    cm.levels.cm0.reliable, cm.levels.cm1.reliable, cm.levels.cm2.reliable, cm.levels.cm3.reliable,
  ].every((v, i, a) => i === 0 || !v || a[i - 1]));

  console.log(
    `  · packaging ${inr(amt("packaging"))} | fwd ${inr(amt("forwardShipping"))} | rev ${inr(amt("reverseShipping"))} | ` +
      `rto(memo) ${inr(amt("rtoCost"))} | gw ${inr(amt("gatewayFees"))} | cod ${inr(amt("codFees"))} | mp ${inr(amt("marketplaceFees"))}`
  );
}

async function main() {
  // Both a data-rich org and a data-poor one. The layers have to behave in both
  // states, and the data-poor case is the one that ships to a new customer.
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  const withOrders: Array<{ id: string; name: string }> = [];
  for (const o of orgs) {
    const n = await prisma.order.count({ where: { organizationId: o.id } });
    if (n > 0) withOrders.push(o);
  }
  ok("there are organisations with orders to check", withOrders.length > 0, `${withOrders.length}`);

  for (const o of withOrders) await checkOrg(o.id, o.name);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
