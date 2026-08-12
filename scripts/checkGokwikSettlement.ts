import { prisma } from "../src/lib/prisma.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { GOKWIK_SETTLEMENT_STATEMENT, encodeCredentials, ingestSettlementReport } from "../src/modules/connectors/gokwik/index.js";
import { parseStatement } from "../src/modules/connectors/remittance/statement.js";
import { toConnectorContext } from "../src/modules/connectors/types.js";
import { runReconciliation } from "../src/modules/calc/reconciliation.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// Proves the GoKwik path a merchant actually walks:
//
//   POST /connections/gokwik/connect       → a GOKWIK Connection row
//   POST /connections/gokwik/:id/settlement → SettlementLines
//   reconciliation                          → COD leg flips to `ran`
//
// checkRemittanceReconciliation.ts proves the same chain for Bluedart and only
// PARSES GoKwik's format. That is a real gap: parsing proves the columns are
// understood, not that the rows resolve against shipments this org holds, and
// GoKwik references orders by the merchant's own order number where Bluedart
// references AWBs. Those are different lookups and only one of them was tested.
//
// This deliberately calls ingestSettlementReport() — the exact function the
// route handler calls — rather than ingestStatement() directly, so the
// connector's own wiring is on the tested path too.
//
// Run with: npx tsx scripts/checkGokwikSettlement.ts

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
const inr = (p: bigint | number) => "₹" + (Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const org = await findDemoOrg();
  if (!org) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }
  const entity = await prisma.legalEntity.findFirst({ where: { organizationId: org.id }, select: { id: true } });
  console.log(`\n=== ${org.name} ===`);

  // --- 1. What /connect does -------------------------------------------
  console.log("\n[1] connecting GoKwik (what POST /connections/gokwik/connect writes)");
  const credentialsRef = encryptSecret(
    encodeCredentials({ merchantId: "demo-merchant", appId: "demo-app", appSecret: "demo-secret" })
  );
  let connection = await prisma.connection.findFirst({ where: { organizationId: org.id, provider: "GOKWIK" } });
  connection = connection
    ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
    : await prisma.connection.create({
        data: {
          organizationId: org.id,
          legalEntityId: entity!.id,
          provider: "GOKWIK",
          status: "ACTIVE",
          externalAccountId: "demo-merchant",
          credentialsRef,
        },
      });
  ok("GOKWIK connection is ACTIVE", connection.status === "ACTIVE", connection.status);
  ok("credentials are encrypted at rest", !credentialsRef.includes("demo-secret"));

  // --- 2. Build a settlement report out of this org's own COD orders ----
  console.log("\n[2] building a GoKwik settlement report from real demo COD orders");
  await prisma.settlementLine.deleteMany({ where: { organizationId: org.id, settlement: { provider: "GOKWIK" } } });
  await prisma.settlement.deleteMany({ where: { organizationId: org.id, provider: "GOKWIK" } });

  const codOrders = await prisma.order.findMany({
    where: { organizationId: org.id, paymentMode: "COD" },
    select: { orderNumber: true, grossAmount: true, shipments: { select: { id: true } } },
    orderBy: { placedAt: "asc" },
    take: 240,
  });
  // An order with no shipment, or with several, CANNOT be attributed to one
  // parcel — and the importer refuses to guess rather than pinning real money
  // to an arbitrary shipment. So the expected unresolved count is not zero, it
  // is exactly the number of such orders. Asserting zero would have forced the
  // resolver to guess; asserting this number proves it declined to.
  const ambiguous = codOrders.filter((o) => o.shipments.length !== 1).length;
  if (codOrders.length === 0) {
    console.log("  no COD orders in the demo org — nothing to prove");
    process.exit(1);
  }
  console.log(`  ${codOrders.length} COD orders available`);

  // GoKwik settles daily; group into payouts of 40 so multiple batches are
  // exercised (a single-batch test cannot catch a per-batch balance bug).
  const BATCH = 40;
  const header = "Settlement Id,UTR,Settlement Date,Order Id,Order Amount,Commission,Settled Amount,Total Settlement";
  const rows: string[] = [header];
  let expectedLines = 0;
  let expectedNetPaise = 0n;

  for (let b = 0; b * BATCH < codOrders.length; b += 1) {
    const slice = codOrders.slice(b * BATCH, (b + 1) * BATCH);
    const settlementId = `GK-STL-${String(b + 1).padStart(3, "0")}`;
    const utr = `UTRGK${String(100000 + b)}`;
    const paidOn = `2026-0${(b % 9) + 1}-15`;
    // 2% commission, mirroring GoKwik's own deduction on COD collection.
    const lines = slice.map((o) => {
      const gross = o.grossAmount;
      const fee = BigInt(Math.round(Number(gross) * 0.02));
      return { ref: o.orderNumber, gross, fee, net: gross - fee };
    });
    const batchNet = lines.reduce((s, l) => s + l.net, 0n);
    for (const [i, l] of lines.entries()) {
      // The stated batch total goes on the first row only, exactly as GoKwik's
      // report lays it out.
      rows.push(
        [
          settlementId,
          utr,
          paidOn,
          l.ref,
          (Number(l.gross) / 100).toFixed(2),
          (Number(l.fee) / 100).toFixed(2),
          (Number(l.net) / 100).toFixed(2),
          i === 0 ? (Number(batchNet) / 100).toFixed(2) : "",
        ].join(",")
      );
    }
    expectedLines += lines.length;
    expectedNetPaise += batchNet;
  }
  const csv = rows.join("\n");
  console.log(`  ${Math.ceil(codOrders.length / BATCH)} payouts, ${expectedLines} lines, ${inr(expectedNetPaise)}`);

  // --- 3. Import through the connector's own entry point ----------------
  console.log("\n[3] importing (what POST /connections/gokwik/:id/settlement calls)");
  const result = await ingestSettlementReport(toConnectorContext(connection), csv);
  ok("no errors", result.errors.length === 0, result.errors.join("; "));
  ok("no batch rejected", result.rejected.length === 0, JSON.stringify(result.rejected.slice(0, 2)));
  ok("every line imported", result.linesImported === expectedLines, `${result.linesImported}/${expectedLines}`);
  ok("amount matches the report", result.amountImportedPaise === expectedNetPaise,
    `${inr(result.amountImportedPaise)} vs ${inr(expectedNetPaise)}`);
  ok(
    "every attributable line resolved by ORDER NUMBER",
    result.linesUnresolved === ambiguous,
    `${result.linesUnresolved} unresolved, expected exactly ${ambiguous} (orders with no single shipment)`
  );
  ok("…and the rest resolved, not silently dropped", result.linesImported - result.linesUnresolved === expectedLines - ambiguous);
  console.log(`  imported ${result.batchesImported} payouts, ${result.linesImported} lines, ${inr(result.amountImportedPaise)}`);

  // --- 4. Idempotency: re-importing the same file changes nothing -------
  console.log("\n[4] re-importing the identical file");
  const linesBefore = await prisma.settlementLine.count({ where: { organizationId: org.id } });
  await ingestSettlementReport(toConnectorContext(connection), csv);
  const linesAfter = await prisma.settlementLine.count({ where: { organizationId: org.id } });
  ok("no duplicate lines created", linesAfter === linesBefore, `${linesBefore} → ${linesAfter}`);

  // --- 5. A corrupted batch must be REFUSED, not warned about -----------
  console.log("\n[5] tampering: a payout whose lines do not sum to its stated total");
  const tampered = rows.slice();
  const firstTotalRow = tampered.findIndex((r, i) => i > 0 && r.split(",")[7] !== "");
  const cells = tampered[firstTotalRow]!.split(",");
  cells[7] = (Number(cells[7]) + 5000).toFixed(2); // overstate the payout by ₹5,000
  tampered[firstTotalRow] = cells.join(",");
  const tamperResult = await ingestSettlementReport(toConnectorContext(connection), tampered.join("\n"));
  ok("out-of-balance payout is rejected", tamperResult.rejected.length > 0,
    `${tamperResult.rejected.length} rejected`);
  ok("rejection names the reason", tamperResult.rejected[0]?.reason === "total_mismatch",
    tamperResult.rejected[0]?.reason ?? "none");

  // --- 6. Does the COD leg actually move? -------------------------------
  console.log("\n[6] reconciliation");
  const recon = await runReconciliation(org.id);
  const cod = recon.legs.find((l) => l.matchType === "COD_REMITTANCE")!;
  ok("COD leg ran", cod.state === "ran", cod.state === "ran" ? "" : (cod.blockedReason ?? cod.state));
  ok("it matched something", cod.matched > 0, `${cod.matched} matched`);
  console.log(`  ${cod.matched} matched of ${cod.eligible} eligible; ${inr(cod.matchedValue)} traced to a payout`);

  // --- 7. MIXED payout: prepaid captures and COD cash in one file ---------
  // GoKwik runs the whole checkout, so a prepaid customer pays GoKwik too and
  // both land in the same payout. If every row were treated as COD, prepaid
  // card money would be matched against parcels.
  console.log("\n[7] a payout mixing prepaid and COD (GoKwik runs the whole checkout)");
  const prepaidOrders = await prisma.order.findMany({
    where: { organizationId: org.id, paymentMode: "PREPAID", payments: { some: {} } },
    select: { orderNumber: true, grossAmount: true, payments: { select: { id: true } } },
    take: 30,
  });
  const codForMix = codOrders.filter((o) => o.shipments.length === 1).slice(0, 30);
  if (prepaidOrders.length === 0) {
    console.log("  no prepaid orders with payments in the demo org — skipping");
  } else {
    const mixHeader = "Settlement Id,UTR,Settlement Date,Payment Mode,Order Id,Order Amount,Commission,Settled Amount,Total Settlement";
    const mixRows: string[] = [mixHeader];
    const entries = [
      ...prepaidOrders.map((o) => ({ mode: "Prepaid", ref: o.orderNumber, gross: o.grossAmount })),
      ...codForMix.map((o) => ({ mode: "COD", ref: o.orderNumber, gross: o.grossAmount })),
    ];
    const priced = entries.map((e) => {
      const fee = BigInt(Math.round(Number(e.gross) * 0.02));
      return { ...e, fee, net: e.gross - fee };
    });
    const total = priced.reduce((s, l) => s + l.net, 0n);
    priced.forEach((l, i) => {
      mixRows.push(
        ["GK-MIX-001", "UTRGKMIX01", "2026-06-20", l.mode, l.ref,
          (Number(l.gross) / 100).toFixed(2), (Number(l.fee) / 100).toFixed(2), (Number(l.net) / 100).toFixed(2),
          i === 0 ? (Number(total) / 100).toFixed(2) : ""].join(",")
      );
    });
    const mixResult = await ingestSettlementReport(toConnectorContext(connection), mixRows.join("\n"));
    ok("mixed payout imports", mixResult.rejected.length === 0 && mixResult.errors.length === 0,
      [...mixResult.errors, ...mixResult.rejected.map((r) => r.reason)].join("; "));

    const mixSettlement = await prisma.settlement.findFirst({
      where: { organizationId: org.id, externalSettlementId: "GK-MIX-001" },
      select: { id: true, kind: true },
    });
    const payLines = await prisma.settlementLine.count({ where: { settlementId: mixSettlement!.id, type: "PAYMENT" } });
    const codLines = await prisma.settlementLine.count({ where: { settlementId: mixSettlement!.id, type: "SHIPMENT_COD" } });
    ok("prepaid rows stored as PAYMENT lines", payLines === prepaidOrders.length, `${payLines}/${prepaidOrders.length}`);
    ok("COD rows stored as SHIPMENT_COD lines", codLines === codForMix.length, `${codLines}/${codForMix.length}`);
    ok("a payout containing prepaid is kind=GATEWAY", mixSettlement!.kind === "GATEWAY", mixSettlement!.kind);

    // The part that actually matters: a prepaid line must attach to a PAYMENT
    // and never to a shipment, or card money gets attributed to a parcel.
    const crossed = await prisma.settlementLine.count({
      where: { settlementId: mixSettlement!.id, type: "PAYMENT", shipmentId: { not: null } },
    });
    ok("no prepaid line is attached to a shipment", crossed === 0, `${crossed} crossed over`);
    const linkedPayments = await prisma.settlementLine.count({
      where: { settlementId: mixSettlement!.id, type: "PAYMENT", paymentId: { not: null } },
    });
    ok("prepaid lines resolved to real payments", linkedPayments > 0, `${linkedPayments} linked`);
    console.log(`  ${payLines} prepaid + ${codLines} COD in one payout; ${linkedPayments} prepaid lines linked to payments`);

    // An unreadable payment mode is imported as ADJUSTMENT and reported — NOT
    // refused, and NOT defaulted to the format's own line type.
    //
    // This assertion used to require a refusal. That was wrong in practice: a
    // real export used "upi-ba" and every row failed, blocking the whole file
    // over a naming variant. Refusing and defaulting are both bad — one loses
    // the payout, the other files prepaid money as COD. ADJUSTMENT keeps the
    // money in the payout while attaching it to nothing.
    const badMode = [mixHeader, `GK-BAD-001,UTRBAD,2026-06-21,Bitcoin,${priced[0]!.ref},100.00,0.00,100.00,100.00`].join("\n");
    const badResult = await ingestSettlementReport(toConnectorContext(connection), badMode);
    ok("unreadable payment mode does not fail the file", badResult.errors.length === 0, badResult.errors.join("; "));
    ok("…and is reported back by name", badResult.unknownModes.includes("bitcoin"),
      JSON.stringify(badResult.unknownModes));
    const adjLines = await prisma.settlementLine.count({
      where: { organizationId: org.id, type: "ADJUSTMENT", settlement: { externalSettlementId: "GK-BAD-001" } },
    });
    ok("…imported as ADJUSTMENT, not as COD", adjLines === 1, `${adjLines} adjustment lines`);
  }

  // --- 8. THE REAL GoKwik export header --------------------------------
  // Taken verbatim from the merchant's actual settlement export. Everything
  // above used a header I invented; this is the one the product must read.
  // It is a transaction LEDGER, not a payout summary: no settlement-id column
  // (the payout is identified only by "Settlement UTR"), deductions split
  // across five columns, and a Debit/Credit pair carrying refunds.
  console.log("\n[8] the REAL GoKwik export header");
  const REAL_HEADER =
    "S. No.,Transaction Type,Payment Id,Order Id,Amount,Currency,Tax,Fee,Additional Fees,Additional Tax," +
    "gokwik Deduction,Debit,Credit,Payment Method,Transaction Date,Transaction RRN,Merchant Order Id," +
    "Platform Order Id,Shopify Transaction Id,Settlement UTR,Settlement Date,Settled By,Payment Mode,Bank Code,Card Network";
  const realRows = [
    REAL_HEADER,
    "1,Sale,pay_1,5001,1000.00,INR,18.00,100.00,0.00,0.00,0.00,0.00,882.00,UPI,2026-08-01,RRN1,#25916,5001,t1,UTR900001,2026-08-02,GoKwik,Prepaid,HDFC,",
    "2,Sale,pay_3,5003,2000.00,INR,36.00,200.00,0.00,0.00,0.00,0.00,1764.00,COD,2026-08-01,RRN3,#25914,5003,t3,UTR900001,2026-08-02,GoKwik,COD,,",
    "3,Refund,pay_2,5002,500.00,INR,0.00,0.00,0.00,0.00,0.00,500.00,0.00,UPI,2026-08-01,RRN2,#25915,5002,t2,UTR900001,2026-08-02,GoKwik,Prepaid,HDFC,",
  ].join("\n");
  const realParsed = parseStatement(realRows, GOKWIK_SETTLEMENT_STATEMENT);
  ok("real header parses with no errors", realParsed.errors.length === 0, realParsed.errors.join("; "));
  const rb = realParsed.batches[0];
  ok("payout grouped by Settlement UTR", rb?.batchId === "UTR900001", rb?.batchId ?? "none");
  ok("all three rows kept", rb?.lines.length === 3, String(rb?.lines.length));
  // 18 + 100 across five deduction columns — picking one would give 100.
  ok("deduction columns are SUMMED, not picked", rb?.lines[0]?.feePaise === 11800n, String(rb?.lines[0]?.feePaise));
  ok("Payment Mode splits prepaid from COD",
    rb?.lines[0]?.lineType === "PAYMENT" && rb?.lines[1]?.lineType === "SHIPMENT_COD",
    `${rb?.lines[0]?.lineType}/${rb?.lines[1]?.lineType}`);
  // A refund is an outflow. Recorded negative so it REDUCES the payout rather
  // than failing its own gross − fee = net check and rejecting the whole batch.
  ok("refund recorded as a negative line", rb?.lines[2]?.netPaise === -50000n, String(rb?.lines[2]?.netPaise));
  ok("refund does not reject the payout", rb?.imbalances.length === 0, `${rb?.imbalances.length} imbalances`);
  ok("payout nets to 882 + 1764 − 500", rb?.netPaise === 214600n, String(rb?.netPaise));
  console.log(`  ${rb?.lines.length} lines, payout net ${inr(rb?.netPaise ?? 0n)}`);

  // --- 9. Unknown payment modes must not block the file ------------------
  // A real upload failed every row with `unrecognised payment mode "upi-ba"`.
  // Refusing an entire export over a naming variant is the wrong trade: the
  // vocabulary is open-ended and always will be.
  console.log("\n[9] payment modes outside the known vocabulary");
  const modeRows = (mode: string) =>
    [
      REAL_HEADER,
      `1,Sale,pay_1,5001,1000.00,INR,18.00,100.00,0.00,0.00,0.00,0.00,882.00,UPI,2026-08-01,RRN1,#25916,5001,t1,UTRMODE1,2026-08-02,GoKwik,${mode},HDFC,`,
    ].join("\n");

  const upiBa = parseStatement(modeRows("upi-ba"), GOKWIK_SETTLEMENT_STATEMENT);
  ok("'upi-ba' no longer errors", upiBa.errors.length === 0, upiBa.errors.join("; "));
  ok("'upi-ba' classified as a PAYMENT", upiBa.batches[0]?.lines[0]?.lineType === "PAYMENT",
    upiBa.batches[0]?.lines[0]?.lineType ?? "none");

  // A mode in no family is imported as ADJUSTMENT: counted in the payout so the
  // batch still balances, attached to nothing so nothing is misattributed.
  const alien = parseStatement(modeRows("wibble-pay"), GOKWIK_SETTLEMENT_STATEMENT);
  ok("an unknown mode does not fail the file", alien.errors.length === 0, alien.errors.join("; "));
  ok("…the row is still imported", alien.batches[0]?.lines.length === 1, String(alien.batches[0]?.lines.length));
  ok("…as ADJUSTMENT, attached to nothing", alien.batches[0]?.lines[0]?.lineType === "ADJUSTMENT",
    alien.batches[0]?.lines[0]?.lineType ?? "none");
  ok("…and the money still counts toward the payout", alien.batches[0]?.netPaise === 88200n,
    String(alien.batches[0]?.netPaise));
  ok("…and the mode is reported back", alien.unknownModes?.includes("wibble-pay") === true,
    JSON.stringify(alien.unknownModes));

  // PPCOD stays unclassified ON PURPOSE — it has money in both ledgers.
  const ppcod = parseStatement(modeRows("PPCOD"), GOKWIK_SETTLEMENT_STATEMENT);
  ok("PPCOD is still not guessed at", ppcod.batches[0]?.lines[0]?.lineType === "ADJUSTMENT",
    ppcod.batches[0]?.lines[0]?.lineType ?? "none");
  // "cod-upi" mentions a payment rail but is cash on delivery.
  const codUpi = parseStatement(modeRows("cod-upi"), GOKWIK_SETTLEMENT_STATEMENT);
  ok("'cod-upi' reads as COD, not prepaid", codUpi.batches[0]?.lines[0]?.lineType === "SHIPMENT_COD",
    codUpi.batches[0]?.lines[0]?.lineType ?? "none");

  // --- 10. What the merchant's REAL export exposed ----------------------
  // Three bugs, all from assuming what GoKwik's column names meant. Sampled
  // from the live file: Payment Mode blank, Transaction Type "Payment",
  // Merchant Order Id holding Shopify's NUMERIC id and Platform Order Id
  // holding the order name.
  console.log("\n[10] the real export's column semantics");
  const realRow = (paymentMode: string, txType: string) =>
    [
      REAL_HEADER,
      `1,${txType},KWIK66EI8AY10531861MP,KWIK01HAPHUZ0531811,999.0000,INR,0,0,0,0,0,0,999.0000,UPI,` +
        `2026-07-13,RRN9,6973080469675,#25367,,UTRREAL1,2026-07-14,GoKwik,${paymentMode},HDFC,`,
    ].join("\n");

  // Payment Mode BLANK — must fall through to Transaction Type, not to the
  // format default (SHIPMENT_COD), which would file a card payment as cash.
  const blankMode = parseStatement(realRow("", "Payment"), GOKWIK_SETTLEMENT_STATEMENT);
  ok("blank Payment Mode falls through to Transaction Type",
    blankMode.batches[0]?.lines[0]?.lineType === "PAYMENT",
    blankMode.batches[0]?.lines[0]?.lineType ?? "none");
  ok("…and is NOT defaulted to COD", blankMode.batches[0]?.lines[0]?.lineType !== "SHIPMENT_COD");

  // A populated-but-unknown mode must STOP the search, never be overridden by
  // a coarser column further along.
  const ppcodRow = parseStatement(realRow("PPCOD", "Payment"), GOKWIK_SETTLEMENT_STATEMENT);
  ok("PPCOD is not overridden by Transaction Type",
    ppcodRow.batches[0]?.lines[0]?.lineType === "ADJUSTMENT",
    ppcodRow.batches[0]?.lines[0]?.lineType ?? "none");

  // The reference GoKwik states is Shopify's numeric order id, not the name.
  const ref = blankMode.batches[0]?.lines[0]?.reference;
  ok("reference is the Shopify numeric order id", ref === "6973080469675", ref ?? "none");
  const matched = await prisma.order.count({
    where: { organizationId: org.id, OR: [{ orderNumber: ref ?? "" }, { externalOrderId: ref ?? "" }] },
  });
  console.log(`  reference "${ref}" — resolver now searches orderNumber AND externalOrderId (demo match: ${matched})`);

  // --- 11. Re-import replaces a payout's lines --------------------------
  // A line whose TYPE changes between imports would otherwise upsert as a new
  // row and leave the old one behind, double-counting the payout.
  console.log("\n[11] re-importing after a reclassification");
  const rcHeader = "Settlement Id,UTR,Settlement Date,Payment Mode,Order Id,Order Amount,Commission,Settled Amount,Total Settlement";
  const rcRef = codOrders[0]!.orderNumber;
  const asCod = [rcHeader, `GK-RECLASS-1,UTRRC1,2026-06-25,COD,${rcRef},1000.00,0.00,1000.00,1000.00`].join("\n");
  await ingestSettlementReport(toConnectorContext(connection), asCod);
  const afterCod = await prisma.settlementLine.count({ where: { settlement: { externalSettlementId: "GK-RECLASS-1" } } });
  const asPrepaid = [rcHeader, `GK-RECLASS-1,UTRRC1,2026-06-25,Prepaid,${rcRef},1000.00,0.00,1000.00,1000.00`].join("\n");
  const reclassed = await ingestSettlementReport(toConnectorContext(connection), asPrepaid);
  const afterPrepaid = await prisma.settlementLine.count({ where: { settlement: { externalSettlementId: "GK-RECLASS-1" } } });
  ok("first import writes one line", afterCod === 1, String(afterCod));
  ok("re-import does NOT leave the old type behind", afterPrepaid === 1, `${afterPrepaid} lines`);
  ok("…and reports what it replaced", reclassed.linesReplaced === 1, String(reclassed.linesReplaced));

  // --- 12. "na" is a placeholder, not an unknown vocabulary word --------
  // The live export writes "na" in Payment Mode on refund rows, where the
  // concept does not apply. Reporting it as unrecognised asked the merchant to
  // explain a blank; the honest reading is "no value here, try the next column".
  console.log("\n[12] placeholder payment modes");
  const naRefund = parseStatement(
    [
      REAL_HEADER,
      `1,Refund,pay_r,5009,659.12,INR,0,0,0,0,0,659.12,0.00,UPI,2026-07-13,RRNR,6752422920363,#25100,,UTRNA1,2026-07-14,GoKwik,na,HDFC,`,
    ].join("\n"),
    GOKWIK_SETTLEMENT_STATEMENT
  );
  ok('"na" is not reported as an unknown mode', (naRefund.unknownModes ?? []).length === 0,
    JSON.stringify(naRefund.unknownModes));
  ok('"na" falls through to Transaction Type "Refund"',
    naRefund.batches[0]?.lines[0]?.lineType === "ADJUSTMENT",
    naRefund.batches[0]?.lines[0]?.lineType ?? "none");
  ok("the refund is a negative line", naRefund.batches[0]?.lines[0]?.netPaise === -65912n,
    String(naRefund.batches[0]?.lines[0]?.netPaise));

  console.log("\n" + "─".repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f}`));
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
