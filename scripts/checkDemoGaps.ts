import { prisma } from "../src/lib/prisma.js";

// Asserts what seedDemoGaps.ts produced, against the real database.
//
// The reason this exists rather than a note saying "I checked": the first run
// of that seeder silently gave 534 marketplace orders a SECOND payment, which
// double-counted their cash. Nothing failed. The import reported success, the
// row counts looked plausible, and the only way it surfaced was counting
// payments per order on purpose.
//
// Every assertion below is one that would have caught a mistake I actually
// made while writing the seeder.
//
// Run with: npx tsx scripts/checkDemoGaps.ts

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

async function main() {
  const demo = await prisma.organization.findFirst({
    where: { name: { startsWith: "DEMO — " } },
    select: { id: true, name: true },
  });
  if (!demo) {
    console.log("no DEMO organisation — nothing to check");
    await prisma.$disconnect();
    return;
  }
  const org = demo.id;
  console.log(`\ntarget: ${demo.name}\n`);

  // ---------------------------------------------------------------------------
  console.log("[1] Fabricated data is confined to the demo org");
  // ---------------------------------------------------------------------------
  // The whole safety argument rests on this. If a freight invoice from this
  // seeder ever appears in an org without the DEMO prefix, the guard failed and
  // someone is looking at invented freight costs believing they are measured.
  const realOrgs = await prisma.organization.findMany({
    where: { name: { not: { startsWith: "DEMO — " } } },
    select: { id: true, name: true },
  });
  for (const r of realOrgs) {
    const invoices = await prisma.freightInvoice.count({
      where: { organizationId: r.id, invoiceNo: { startsWith: "DEMO" } },
    });
    const settlements = await prisma.settlement.count({
      where: { organizationId: r.id, externalSettlementId: { startsWith: "DEMOGAP" } },
    });
    ok(`"${r.name}" holds no seeded rows`, invoices === 0 && settlements === 0, `${invoices} invoices, ${settlements} settlements`);
  }

  // ---------------------------------------------------------------------------
  console.log("\n[2] One sale, one receipt");
  // ---------------------------------------------------------------------------
  // The bug this file was written for.
  const multiPay = await prisma.$queryRaw<Array<{ orders: bigint }>>`
    SELECT COUNT(*)::bigint AS orders FROM (
      SELECT o.id FROM orders o JOIN payments p ON p."orderId" = o.id
      WHERE o."organizationId" = ${org}
      GROUP BY o.id HAVING COUNT(p.id) > 1
    ) t`;
  const dupes = Number(multiPay[0]?.orders ?? 0n);
  ok("no order carries more than one payment", dupes === 0, `${dupes} orders with 2+`);

  // ---------------------------------------------------------------------------
  console.log("\n[3] Freight invoices carry the three row kinds that matter");
  // ---------------------------------------------------------------------------
  const invoiceCount = await prisma.freightInvoice.count({ where: { organizationId: org } });
  ok("freight invoices exist", invoiceCount > 0, `${invoiceCount}`);

  // A return leg is the ONLY place reverse shipping is ever stated. Without
  // these rows the reverseShipping and rtoCost layers have no source and P6.5
  // is unbuildable — which was the point of seeding them.
  const returnLegs = await prisma.freightInvoiceLine.count({ where: { organizationId: org, isReturnLeg: true } });
  ok("return legs are billed", returnLegs > 0, `${returnLegs}`);

  // An RTO must be billed freight TWICE. If a return leg exists for an AWB that
  // has no outbound leg, the seeder built a return in isolation and the "RTO
  // costs double" property it is meant to demonstrate is not there.
  const orphanReturns = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM freight_invoice_lines r
    WHERE r."organizationId" = ${org} AND r."isReturnLeg" = true
      AND NOT EXISTS (
        SELECT 1 FROM freight_invoice_lines o
        WHERE o."organizationId" = ${org} AND o.awb = r.awb AND o."isReturnLeg" = false
      )`;
  ok("every return leg has an outbound leg on the same AWB", Number(orphanReturns[0]?.n ?? 0n) === 0, `${orphanReturns[0]?.n} orphans`);

  // Signed amounts. The model documents that negative rows are credits; if none
  // exist, that path has never been executed by anything.
  const credits = await prisma.freightInvoiceLine.count({ where: { organizationId: org, amount: { lt: 0 } } });
  ok("credit notes are present (negative amounts)", credits > 0, `${credits}`);

  // Couriers bill for parcels that were never booked through us. It is the only
  // place that money-leaving-for-nothing surfaces, so the demo must contain it.
  const unmatched = await prisma.freightInvoiceLine.count({ where: { organizationId: org, shipmentId: null } });
  ok("some billed AWBs match no shipment", unmatched > 0, `${unmatched}`);

  // The invoice header must not silently disagree with its own lines.
  const invoices = await prisma.freightInvoice.findMany({
    where: { organizationId: org },
    select: { invoiceNo: true, lineTotal: true, grandTotal: true, lines: { select: { amount: true } } },
  });
  let mismatched = 0;
  for (const inv of invoices) {
    const summed = inv.lines.reduce((s, l) => s + l.amount, 0n);
    if (summed !== inv.lineTotal) mismatched += 1;
  }
  ok("each invoice's lineTotal equals the sum of its lines", mismatched === 0, `${mismatched} mismatched`);
  // Grand total carries GST on top, so it must EXCEED the line total. Equal
  // would mean the distinction the model draws is not being exercised.
  const grandEqualsLine = invoices.filter((i) => i.grandTotal !== null && i.grandTotal === i.lineTotal).length;
  ok("grand total exceeds line total (GST on top)", grandEqualsLine === 0, `${grandEqualsLine} equal`);

  // ---------------------------------------------------------------------------
  console.log("\n[4] Payouts have composition, and it balances");
  // ---------------------------------------------------------------------------
  const byType = await prisma.settlementLine.groupBy({ by: ["type"], where: { organizationId: org }, _count: true });
  const counts = Object.fromEntries(byType.map((t) => [t.type, t._count]));
  ok("PAYMENT lines exist", (counts.PAYMENT ?? 0) > 0, `${counts.PAYMENT ?? 0}`);
  ok("SHIPMENT_COD lines exist", (counts.SHIPMENT_COD ?? 0) > 0, `${counts.SHIPMENT_COD ?? 0}`);
  // Without adjustment rows a payout's lines cannot sum to its total, and the
  // gap gets absorbed as an unexplained difference.
  ok("ADJUSTMENT lines exist", (counts.ADJUSTMENT ?? 0) > 0, `${counts.ADJUSTMENT ?? 0}`);

  // An unresolved line is a real and reportable state, but a demo where NONE
  // resolve means the reference column is wrong — which is exactly what the
  // first seeding run did, silently, for all 2,627 lines.
  const payLines = await prisma.settlementLine.count({ where: { organizationId: org, type: "PAYMENT" } });
  const payResolved = await prisma.settlementLine.count({ where: { organizationId: org, type: "PAYMENT", paymentId: { not: null } } });
  ok("PAYMENT lines resolve to a payment", payLines > 0 && payResolved === payLines, `${payResolved}/${payLines}`);

  // Every line's own arithmetic.
  const badLines = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM settlement_lines
    WHERE "organizationId" = ${org} AND "grossAmount" - "feeAmount" <> "netAmount"`;
  ok("gross − fee = net on every line", Number(badLines[0]?.n ?? 0n) === 0, `${badLines[0]?.n} broken`);

  // ---------------------------------------------------------------------------
  console.log("\n[5] Marketplace orders cost something to sell");
  // ---------------------------------------------------------------------------
  const mpOrders = await prisma.order.count({ where: { organizationId: org, channel: { in: ["amazon", "flipkart"] } } });
  const mpPaid = await prisma.payment.count({
    where: { organizationId: org, order: { channel: { in: ["amazon", "flipkart"] } }, feeAmount: { gt: 0 } },
  });
  ok("marketplace orders exist", mpOrders > 0, `${mpOrders}`);
  ok("marketplace payments carry a fee", mpPaid > 0, `${mpPaid} of ${mpOrders} orders`);

  // A marketplace fee of zero is the misleading default this seeding exists to
  // remove; a fee at 100% would mean the rate was applied to the wrong base.
  const feeAgg = await prisma.payment.aggregate({
    where: { organizationId: org, order: { channel: { in: ["amazon", "flipkart"] } }, feeAmount: { gt: 0 } },
    _sum: { feeAmount: true, amount: true },
  });
  const fees = Number(feeAgg._sum.feeAmount ?? 0n);
  const net = Number(feeAgg._sum.amount ?? 0n);
  const takeRate = net + fees === 0 ? 0 : (fees / (net + fees)) * 100;
  ok("blended take rate is plausible (8–30%)", takeRate >= 8 && takeRate <= 30, `${takeRate.toFixed(1)}%`);

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
