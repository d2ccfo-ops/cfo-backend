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

// EVERY demo org, not the first one found.
//
// This used to be a bare findFirst() with no ordering, which was fine while one
// org carried the prefix. It stopped being fine the moment a second did: which
// org got checked became whatever order Postgres felt like returning, so a
// failure could appear and vanish between identical runs, and two of the three
// seeded orgs were never checked at all.
async function main() {
  const demoOrgs = await prisma.organization.findMany({
    where: { name: { startsWith: "DEMO — " } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  if (demoOrgs.length === 0) {
    console.log("no DEMO organisation — nothing to check");
    await prisma.$disconnect();
    return;
  }

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

  for (const demo of demoOrgs) await checkOrg(demo.id, demo.name);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

async function checkOrg(org: string, name: string) {
  console.log(`\n════ ${name}`);

  // ---------------------------------------------------------------------------
  console.log("\n[2] One sale, one receipt");
  // ---------------------------------------------------------------------------
  // The bug this file was written for.
  // OVERPAYMENT, not payment count.
  //
  // This asserted "no order carries more than one payment", which caught the
  // bug it was written for — a seeding pass that gave 534 marketplace orders a
  // second full-value payment and doubled the cash — but condemns something
  // entirely legitimate alongside it. A partly-prepaid order lands from Shopify
  // as two captures (₹21 taken at checkout, ₹16,307 on delivery) that sum to
  // exactly the order's gross. That is one sale and one receipt, split across
  // two rows, and there is nothing wrong with it.
  //
  // What actually matters is whether the money adds up. An order receiving MORE
  // than it was worth is the double count; an order receiving less is a partial
  // settlement, which reconciliation reports rather than treats as corruption.
  // SEEDED PAYMENTS ONLY. The 534-order bug was seeder-made marketplace
  // payments landing on orders that already had one, so scoping to demo
  // connections keeps the whole regression guard intact.
  //
  // Widening it to every payment made this fail on source-data variance it has
  // no business policing: seven Shopify orders here were paid their
  // pre-discount total (₹549 against a ₹494.10 gross), which is a genuine
  // reconciliation exception the amount_mismatch detector reports — not a
  // defect in generated data, and not something re-running the seeder fixes.
  const overpaid = await prisma.$queryRaw<Array<{ orders: bigint }>>`
    SELECT COUNT(*)::bigint AS orders FROM (
      SELECT o.id
      FROM orders o
      JOIN payments p ON p."orderId" = o.id
      JOIN connections c ON c.id = p."connectionId"
      WHERE o."organizationId" = ${org} AND c."credentialsRef" LIKE 'demo-seed:%'
      GROUP BY o.id, o."grossAmount" HAVING SUM(p.amount) > o."grossAmount"
    ) t`;
  const dupes = Number(overpaid[0]?.orders ?? 0n);
  ok("no seeded payment leaves an order paid more than it was worth", dupes === 0, `${dupes} overpaid`);

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
  //
  // SEEDED INVOICES ONLY — the "DEMO" prefix. An org that also holds real
  // courier invoices will legitimately have orphan return legs: a parcel
  // dispatched in a month whose invoice was never uploaded, then returned in a
  // month whose invoice was, bills only the return. That is a fact about
  // incomplete invoice coverage, not a defect in generated data, and asserting
  // over both populations makes this file fail for a reason it cannot fix.
  const orphanReturns = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n
    FROM freight_invoice_lines r
    JOIN freight_invoices ri ON ri.id = r."invoiceId"
    WHERE r."organizationId" = ${org} AND r."isReturnLeg" = true
      AND ri."invoiceNo" LIKE 'DEMO%'
      AND NOT EXISTS (
        SELECT 1 FROM freight_invoice_lines o
        WHERE o."organizationId" = ${org} AND o.awb = r.awb AND o."isReturnLeg" = false
      )`;
  ok("every seeded return leg has an outbound leg on the same AWB", Number(orphanReturns[0]?.n ?? 0n) === 0, `${orphanReturns[0]?.n} orphans`);

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
  //
  // SEEDED PAYOUTS ONLY — "DEMOGAP". An org that also holds real imported
  // statements has genuinely unresolvable lines in them: GoKwik states a
  // temporary id ("tmp_KWIK01YMU7KD9666296") for a capture whose order never
  // synced, and a statement can cover an order this system does not hold at
  // all. Those are findings for the exception taxonomy to report, not defects
  // in generated data — and demanding 100% here made this file fail for
  // something re-running the seeder cannot change.
  const seededPayouts = { settlement: { externalSettlementId: { startsWith: "DEMOGAP" } } };
  const payLines = await prisma.settlementLine.count({ where: { organizationId: org, type: "PAYMENT", ...seededPayouts } });
  const payResolved = await prisma.settlementLine.count({
    where: { organizationId: org, type: "PAYMENT", paymentId: { not: null }, ...seededPayouts },
  });
  ok("every seeded PAYMENT line resolves to a payment", payLines > 0 && payResolved === payLines, `${payResolved}/${payLines}`);

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
  // NO MARKETPLACE ORDERS IS NOT A FAILURE. A D2C-only brand selling entirely
  // through its own store is the common case, and demanding Amazon orders of
  // every demo org would fail an org that is simply modelling a real shape.
  // What must never happen is a marketplace order that cost nothing to sell —
  // Amazon does not carry stock for free, and a zero there is the misleading
  // default this section exists to catch.
  if (mpOrders === 0) {
    console.log("  · no marketplace orders — a D2C-only brand, nothing to charge a referral fee on");
    return;
  }
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
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
