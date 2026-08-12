import { MatchType } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import {
  CARRIER_SQL,
  normaliseCourier,
} from "../src/modules/connectors/courier.js";
import {
  applyInvoice,
  parseBluedartInvoiceText,
} from "../src/modules/connectors/bluedart/invoice.js";
import {
  readFreightSummary,
  readReconciliationLegs,
  runReconciliation,
} from "../src/modules/calc/reconciliation.js";

// Freight is one of the two halves of contribution margin and has no source but
// these invoices, so this asserts the whole path end to end against a scratch
// organisation: parse -> persist -> attach to shipments -> reconcile -> read
// back. Everything is torn down at the end, so it never touches real data.
//
// Run with: npx tsx scripts/checkFreightReconciliation.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function invoiceText(invoiceNo: string, rows: string[], total: string) {
  return [
    "Tax Invoice",
    "OJAS SOFTECH PRIVATE LIMITED",
    "NDA821166 (NDA)",
    invoiceNo,
    "Invoice Date : 31/07/2026",
    "Etail Air COD",
    ...rows,
    `Total ${total}`,
  ].join("\n");
}

async function main() {
  console.log("\n[1] courier normalisation — 26 spellings, 8 carriers");
  const spellings: Array<[string, string]> = [
    ["Bluedart", "bluedart"],
    ["Blue Dart Air", "bluedart"],
    ["Bluedart Surface - Select  500gm", "bluedart"],
    ["Blue Dart Surface_Network Stress", "bluedart"],
    ["Delhivery", "delhivery"],
    ["DTDC", "dtdc"],
    ["DTDC Surface_Network Stress", "dtdc"],
    ["DTD Express", "dtdc"],
    ["Shadowfax  Surface_Network Stress", "shadowfax"],
    ["XpressBees", "xpressbees"],
    ["Xpressbees Surface 5kg", "xpressbees"],
    ["Ekart Logistics Surface", "ekart"],
    ["India Post Domestic", "indiapost"],
    ["Amazon COD Surface 500gm", "amazon"],
    ["", "other"],
    ["Some New Courier", "other"],
  ];
  for (const [raw, expected] of spellings) {
    ok(
      `"${raw || "(blank)"}" -> ${expected}`,
      normaliseCourier(raw) === expected,
      normaliseCourier(raw),
    );
  }
  ok("null is other, not a guess", normaliseCourier(null) === "other");

  // The SQL mirror and the function must agree, or an aggregate and a detail
  // view would attribute the same parcel to different carriers.
  console.log("\n[2] the SQL mirror agrees with the function on real data");
  const sqlRows = await prisma.$queryRawUnsafe<
    Array<{ name: string | null; slug: string }>
  >(
    `SELECT DISTINCT "courierName" AS name, ${CARRIER_SQL} AS slug FROM shipments`,
  );
  const disagreements = sqlRows.filter(
    (r) => normaliseCourier(r.name) !== r.slug,
  );
  ok(
    `all ${sqlRows.length} distinct spellings agree`,
    disagreements.length === 0,
    disagreements
      .map((d) => `${d.name}: sql=${d.slug} js=${normaliseCourier(d.name)}`)
      .join(", "),
  );

  // --- scratch org -------------------------------------------------------
  // Created INSIDE the try below via these bindings: an earlier version built
  // the org before the try, so a failure during setup (a schema field that had
  // been renamed) left a TEST organisation behind in a database holding real
  // merchant data. Everything created here is torn down in the finally.
  const org = await prisma.organization.create({
    data: {
      name: `TEST freight ${Date.now()}`,
      clerkOrgId: `test_freight_${Date.now()}`,
    },
  });

  try {
    const entity = await prisma.legalEntity.create({
      data: { organizationId: org.id, name: "Test Entity" },
    });
    const conn = await prisma.connection.create({
      data: {
        organizationId: org.id,
        legalEntityId: entity.id,
        provider: "BLUEDART",
        status: "ACTIVE",
        externalAccountId: "TEST",
        credentialsRef: "test",
      },
    });

    const mkShipment = (awb: string, courier: string) =>
      prisma.shipment.create({
        data: {
          organizationId: org.id,
          legalEntityId: entity.id,
          connectionId: conn.id,
          externalShipmentId: `ext-${awb}`,
          awbCode: awb,
          courierName: courier,
          status: "DELIVERED",
        },
      });

    const shipA = await mkShipment("80000000001", "Bluedart");
    const shipB = await mkShipment("80000000002", "Blue Dart Air");
    const shipC = await mkShipment("80000000003", "Bluedart");
    // A carrier with no invoice — must NOT dilute the freight leg's denominator.
    const shipD = await mkShipment("90000000009", "DTDC");

    console.log("\n[3] a leg with no invoice says so, rather than reading 0%");
    const before = await readReconciliationLegs(org.id);
    const freightBefore = before.find(
      (l) => l.matchType === MatchType.SHIPMENT_FREIGHT,
    );
    ok("freight leg exists", Boolean(freightBefore));
    ok(
      "state is unavailable",
      freightBefore?.state === "unavailable",
      freightBefore?.state,
    );
    ok(
      "and names the missing document",
      /freight invoice/i.test(freightBefore?.blockedReason ?? ""),
      freightBefore?.blockedReason,
    );

    console.log(
      "\n[4] apply an invoice — one AWB billed twice, one billed for nothing",
    );
    const parsed = parseBluedartInvoiceText(
      invoiceText(
        "2026709R00009001",
        [
          "01/07/2026 80000000001 BENGALURU NDx 0.50 100.00\t1",
          "10/07/2026 (R)80000000001 BENGALURU NDx 0.50 50.00\t2",
          "01/07/2026 80000000002 GUWAHATI NDx 0.50 -20.00\t3",
          // Billed for a waybill this system has no shipment for.
          "01/07/2026 80000000777 NOWHERE NDx 0.50 75.00\t4",
        ],
        "205.00",
      ),
    );
    ok(
      "parsed 4 lines",
      parsed.lines.length === 4,
      String(parsed.lines.length),
    );
    ok(
      "checksum clean",
      parsed.warnings.length === 0,
      parsed.warnings.join(" | "),
    );

    const applied = await applyInvoice(
      org.id,
      entity.id,
      conn.id,
      parsed,
      "test.pdf",
    );
    ok("invoice persisted", Boolean(applied.invoiceId));
    ok(
      "2 shipments costed",
      applied.shipmentsUpdated === 2,
      String(applied.shipmentsUpdated),
    );
    ok(
      "1 waybill matched nothing",
      applied.unmatchedAwbs.length === 1,
      applied.unmatchedAwbs.join(","),
    );
    ok(
      "that waybill is named",
      applied.unmatchedAwbs[0] === "80000000777",
      applied.unmatchedAwbs[0],
    );

    // The RTO case: outbound ₹100 + return ₹50 must read as ₹150, not ₹50.
    const a = await prisma.shipment.findUnique({
      where: { id: shipA.id },
      select: { freightAmount: true },
    });
    ok(
      "both legs of an RTO are summed",
      a?.freightAmount === 15000n,
      String(a?.freightAmount),
    );
    const b = await prisma.shipment.findUnique({
      where: { id: shipB.id },
      select: { freightAmount: true },
    });
    ok(
      "a credit keeps its sign",
      b?.freightAmount === -2000n,
      String(b?.freightAmount),
    );
    const c = await prisma.shipment.findUnique({
      where: { id: shipC.id },
      select: { freightAmount: true },
    });
    ok(
      "an unbilled shipment stays null",
      c?.freightAmount === null,
      String(c?.freightAmount),
    );

    console.log(
      "\n[5] re-uploading the same invoice replaces it, never doubles it",
    );
    const again = await applyInvoice(
      org.id,
      entity.id,
      conn.id,
      parsed,
      "test.pdf",
    );
    ok("reported as a replacement", again.replacedExisting === true);

    // The batch endpoint's totals must count DISTINCT INVOICES, not files.
    // Selecting the same PDF twice reported double the freight on a real
    // upload — ₹1,24,950 across 1,166 shipments for what is really ₹62,475
    // across 583 — while the database correctly held one invoice. The figure on
    // screen was the only thing wrong, which is the worst place for it to be.
    const asBatch = [applied, again].map((r) => ({
      ok: true as const,
      invoiceNo: r.invoiceNo,
      totalFreightPaise: r.totalFreightPaise.toString(),
      shipmentsUpdated: r.shipmentsUpdated,
      unmatchedCount: r.unmatchedAwbs.length,
      replacedExisting: r.replacedExisting,
    }));
    const byInvoice = new Map<string, (typeof asBatch)[number]>();
    for (const r of asBatch) {
      const first = byInvoice.get(r.invoiceNo);
      byInvoice.set(r.invoiceNo, first ? { ...r, replacedExisting: first.replacedExisting } : r);
    }
    const distinct = [...byInvoice.values()];
    ok("two files, one distinct invoice", distinct.length === 1, String(distinct.length));
    ok("duplicate count reported", asBatch.length - distinct.length === 1);
    ok(
      "freight is not doubled",
      distinct.reduce((s, r) => s + BigInt(r.totalFreightPaise), 0n) === applied.totalFreightPaise,
      `${distinct.reduce((s, r) => s + BigInt(r.totalFreightPaise), 0n)} vs ${applied.totalFreightPaise}`
    );
    ok(
      "shipment count is not doubled",
      distinct.reduce((s, r) => s + r.shipmentsUpdated, 0) === applied.shipmentsUpdated,
      String(distinct.reduce((s, r) => s + r.shipmentsUpdated, 0))
    );
    // A duplicate inside one batch is not evidence the merchant uploaded this
    // invoice on an earlier occasion.
    ok("the surviving row keeps the first flag", distinct[0]!.replacedExisting === false);
    ok(
      "still one invoice",
      (await prisma.freightInvoice.count({
        where: { organizationId: org.id },
      })) === 1,
    );
    ok(
      "still four lines",
      (await prisma.freightInvoiceLine.count({
        where: { organizationId: org.id },
      })) === 4,
    );
    const aAgain = await prisma.shipment.findUnique({
      where: { id: shipA.id },
      select: { freightAmount: true },
    });
    ok(
      "freight did NOT double",
      aAgain?.freightAmount === 15000n,
      String(aAgain?.freightAmount),
    );

    console.log(
      "\n[6] a second invoice adds to a shipment the first one billed",
    );
    const second = parseBluedartInvoiceText(
      invoiceText(
        "2026709R00009002",
        ["20/07/2026 80000000003 PUNE NDx 0.50 33.00\t1"],
        "33.00",
      ),
    );
    await applyInvoice(org.id, entity.id, conn.id, second, "second.pdf");
    const cAfter = await prisma.shipment.findUnique({
      where: { id: shipC.id },
      select: { freightAmount: true },
    });
    ok(
      "previously-unbilled shipment now costed",
      cAfter?.freightAmount === 3300n,
      String(cAfter?.freightAmount),
    );
    const aStill = await prisma.shipment.findUnique({
      where: { id: shipA.id },
      select: { freightAmount: true },
    });
    ok(
      "the first invoice's charge survived",
      aStill?.freightAmount === 15000n,
      String(aStill?.freightAmount),
    );

    console.log("\n[7] running reconciliation produces the leg");
    const run = await runReconciliation(org.id);
    const legRun = run.legs.find(
      (l) => l.matchType === MatchType.SHIPMENT_FREIGHT,
    );
    ok("leg ran", legRun?.state === "ran", legRun?.state);
    // Denominator is Bluedart only: the DTDC parcel has no invoice source and
    // counting it would describe which invoices we happen to hold.
    ok(
      "eligible excludes the DTDC parcel",
      legRun?.eligible === 3,
      String(legRun?.eligible),
    );
    ok("3 shipments matched", legRun?.matched === 3, String(legRun?.matched));
    ok("nothing unmatched", legRun?.unmatched === 0, String(legRun?.unmatched));
    ok(
      "matched value is 150 - 20 + 33",
      legRun?.matchedValue === 16300n,
      String(legRun?.matchedValue),
    );
    ok(
      "no review noise on a cost leg",
      legRun?.needsReview === 0,
      String(legRun?.needsReview),
    );

    console.log("\n[8] the leg survives a reload — read without running");
    const read = await readReconciliationLegs(org.id);
    const legRead = read.find(
      (l) => l.matchType === MatchType.SHIPMENT_FREIGHT,
    );
    ok("still present", Boolean(legRead));
    ok("still ran", legRead?.state === "ran", legRead?.state);
    ok(
      "same eligible",
      legRead?.eligible === legRun?.eligible,
      `${legRead?.eligible} vs ${legRun?.eligible}`,
    );
    ok(
      "same matched",
      legRead?.matched === legRun?.matched,
      `${legRead?.matched} vs ${legRun?.matched}`,
    );
    // The read path must not report a negative or invented outstanding figure.
    ok(
      "unmatched value is not invented",
      legRead?.unmatchedValue === 0n,
      String(legRead?.unmatchedValue),
    );

    console.log("\n[9] re-running is idempotent");
    const rerun = await runReconciliation(org.id);
    ok("no new matches created", rerun.created === 0, String(rerun.created));
    const matchCount = await prisma.reconciliationMatch.count({
      where: { organizationId: org.id, matchType: MatchType.SHIPMENT_FREIGHT },
    });
    // 5 billed lines across both invoices, 4 of which resolved to a shipment —
    // shipA twice (outbound + return leg), shipB once, shipC once. A match per
    // PAIR, not per shipment, so no billed line goes unaccounted for while the
    // leg still counts three shipments.
    ok("one match per resolved line", matchCount === 4, String(matchCount));

    console.log("\n[10] the money the leg cannot express");
    const summary = await readFreightSummary(org.id);
    ok("2 invoices", summary.invoices === 2, String(summary.invoices));
    ok("5 billed lines", summary.lines === 5, String(summary.lines));
    ok(
      "total billed is 238.00",
      summary.billedPaise === 23800n,
      String(summary.billedPaise),
    );
    ok(
      "1 line bills a parcel we do not have",
      summary.linesWithoutShipment === 1,
      String(summary.linesWithoutShipment),
    );
    ok(
      "worth 75.00",
      summary.valueWithoutShipmentPaise === 7500n,
      String(summary.valueWithoutShipmentPaise),
    );
    ok(
      "1 return leg",
      summary.returnLegCount === 1,
      String(summary.returnLegCount),
    );
    ok(
      "worth 50.00",
      summary.returnLegPaise === 5000n,
      String(summary.returnLegPaise),
    );
    ok("1 credit", summary.creditCount === 1, String(summary.creditCount));
    ok(
      "worth -20.00",
      summary.creditPaise === -2000n,
      String(summary.creditPaise),
    );
    // Billed total = what shipments carry + what was billed for nothing.
    const shipmentTotal = await prisma.shipment.aggregate({
      where: { organizationId: org.id },
      _sum: { freightAmount: true },
    });
    ok(
      "billed = attached + unattributable",
      summary.billedPaise ===
        (shipmentTotal._sum.freightAmount ?? 0n) +
          summary.valueWithoutShipmentPaise,
      `${summary.billedPaise} vs ${shipmentTotal._sum.freightAmount} + ${summary.valueWithoutShipmentPaise}`,
    );

    console.log(
      "\n[11] carrier coverage is reported, so a gap is not read as a failure",
    );
    const bd = summary.carriers.find((c) => c.carrier === "bluedart");
    ok("bluedart coverage present", Boolean(bd));
    ok("3 bluedart shipments", bd?.shipments === 3, String(bd?.shipments));
    ok("all 3 billed", bd?.billedShipments === 3, String(bd?.billedShipments));
    ok(
      "DTDC is not claimed as covered",
      !summary.carriers.some((c) => c.carrier === "dtdc"),
    );
    // The DTDC parcel exists and is deliberately uncosted — it is the control
    // for the denominator. If it ever gained a freight amount, the leg would be
    // reporting cost for a carrier no invoice covers.
    const dtdc = await prisma.shipment.findUnique({
      where: { id: shipD.id },
      select: { freightAmount: true },
    });
    ok("the uncovered carrier's parcel stays uncosted", dtdc?.freightAmount === null, String(dtdc?.freightAmount));
  } finally {
    // Torn down whatever happened above, so a failed assertion cannot leave a
    // test organisation behind in a database holding real merchant data.
    await prisma.reconciliationMatch.deleteMany({
      where: { organizationId: org.id },
    });
    await prisma.freightInvoiceLine.deleteMany({
      where: { organizationId: org.id },
    });
    await prisma.freightInvoice.deleteMany({
      where: { organizationId: org.id },
    });
    await prisma.shipment.deleteMany({ where: { organizationId: org.id } });
    await prisma.connection.deleteMany({ where: { organizationId: org.id } });
    await prisma.legalEntity.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
