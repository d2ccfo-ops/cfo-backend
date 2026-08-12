import { prisma } from "../src/lib/prisma.js";
import { BLUEDART_COD_STATEMENT } from "../src/modules/connectors/bluedart/index.js";
import { GOKWIK_SETTLEMENT_STATEMENT } from "../src/modules/connectors/gokwik/index.js";
import { ingestStatement, parseStatement } from "../src/modules/connectors/remittance/statement.js";
import { runReconciliation } from "../src/modules/calc/reconciliation.js";
import { ensureDemoNamePrefix, findDemoOrg } from "./lib/demoOrg.js";

// Proves the COD leg actually closes, end to end, against the demo org:
//
//   delivered COD shipment  →  remittance statement line  →  payout  →  bank
//
// Before this existed, reconciliation reported COD_REMITTANCE as `unavailable`
// with the reason "couriers remit many shipments in one transfer, so individual
// shipments cannot be tied to a bank credit without it". That was correct and it
// was the only thing missing. This builds a real statement out of the demo org's
// own delivered COD shipments, imports it through the same code path a real
// Bluedart MIS would take, and checks that the leg flips to `ran`.
//
// It also checks the refusals, which matter more than the happy path: an
// out-of-balance batch must be REJECTED rather than imported with a warning,
// because a misread column produces a reconciliation that is confidently wrong.
//
// Run with: npx tsx scripts/checkRemittanceReconciliation.ts

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
const inr = (p: bigint | number) => "₹" + (Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const org = await findDemoOrg();
  if (!org) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }
  await ensureDemoNamePrefix(org);
  const entity = await prisma.legalEntity.findFirst({ where: { organizationId: org.id }, select: { id: true } });
  console.log(`\n=== ${org.name} ===`);

  // --- 0. Baseline: what the engine says with no statement imported --------
  console.log("\n[0] before any statement is imported");
  await prisma.settlementLine.deleteMany({ where: { organizationId: org.id } });
  await prisma.reconciliationMatch.deleteMany({
    where: { organizationId: org.id, matchType: { in: ["COD_REMITTANCE", "PAYMENT_SETTLEMENT"] } },
  });
  const before = await runReconciliation(org.id);
  const codBefore = before.legs.find((l) => l.matchType === "COD_REMITTANCE")!;
  ok("COD leg starts unavailable", codBefore.state === "unavailable", codBefore.state);
  ok("…and says why", (codBefore.blockedReason ?? "").includes("remittance statement"), codBefore.blockedReason ?? "");
  console.log(`  ${codBefore.eligible} delivered COD shipments worth ${inr(codBefore.unmatchedValue)} — none attributable`);

  // --- 1. Build a real Bluedart MIS from the org's own shipments -----------
  const delivered = await prisma.shipment.findMany({
    where: { organizationId: org.id, status: "DELIVERED", codAmount: { gt: 0 }, awbCode: { not: null } },
    select: { awbCode: true, codAmount: true, deliveredAt: true },
    orderBy: { deliveredAt: "asc" },
    take: 400,
  });
  ok("demo org has delivered COD shipments to remit", delivered.length > 0, String(delivered.length));
  if (delivered.length === 0) return finish();

  // Couriers remit weekly, deducting a per-shipment COD handling fee. Batching
  // is the entire reason this leg needed a statement, so the fixture batches.
  const FEE_PAISE = 2_000n; // ₹20 per shipment, typical COD handling
  const batches = new Map<string, typeof delivered>();
  for (const s of delivered) {
    const week = new Date(s.deliveredAt!);
    week.setUTCDate(week.getUTCDate() - week.getUTCDay());
    const key = `BDCOD-${week.toISOString().slice(0, 10).replaceAll("-", "")}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key)!.push(s);
  }

  const header = "Remittance No,UTR,Remittance Date,Waybill No,COD Amount,COD Charges,Net Amount,Total Remittance";
  const rows: string[] = [header];
  for (const [batchId, items] of batches) {
    const total = items.reduce((a, s) => a + (s.codAmount ?? 0n) - FEE_PAISE, 0n);
    const paidOn = new Date(items[items.length - 1]!.deliveredAt!);
    paidOn.setUTCDate(paidOn.getUTCDate() + 2); // T+2 remittance
    for (const s of items) {
      const gross = s.codAmount ?? 0n;
      rows.push(
        [
          batchId,
          `UTR${batchId.slice(-8)}`,
          paidOn.toISOString().slice(0, 10),
          s.awbCode,
          (Number(gross) / 100).toFixed(2),
          (Number(FEE_PAISE) / 100).toFixed(2),
          (Number(gross - FEE_PAISE) / 100).toFixed(2),
          (Number(total) / 100).toFixed(2),
        ].join(",")
      );
    }
  }
  const csv = rows.join("\n");
  console.log(`\n[1] built a ${batches.size}-batch Bluedart MIS covering ${delivered.length} AWBs`);

  // --- 2. Parse ------------------------------------------------------------
  console.log("\n[2] parsing");
  const parsed = parseStatement(csv, BLUEDART_COD_STATEMENT);
  ok("no parse errors", parsed.errors.length === 0, parsed.errors.slice(0, 2).join("; "));
  ok("every batch parsed", parsed.batches.length === batches.size, `${parsed.batches.length} of ${batches.size}`);
  ok(
    "line count survives parsing",
    parsed.batches.reduce((a, b) => a + b.lines.length, 0) === delivered.length
  );
  ok(
    "every batch balances against its stated total",
    parsed.batches.every((b) => b.statedTotalPaise === b.netPaise),
    parsed.batches.filter((b) => b.statedTotalPaise !== b.netPaise).map((b) => b.batchId).join(", ")
  );

  // Header spellings differ between report versions; the resolver accepts a
  // list precisely so a renamed column does not become a support ticket.
  const renamed = csv.replace("Waybill No", "AWB No").replace("Remittance Date", "Payout Date");
  ok("an alternative column spelling still parses", parseStatement(renamed, BLUEDART_COD_STATEMENT).errors.length === 0);

  // A file whose headers do not match at all must fail LOUDLY and name what it
  // saw — a silent zero-row import is the worst outcome here.
  const wrong = parseStatement("foo,bar\n1,2", BLUEDART_COD_STATEMENT);
  ok("an unrecognised file is rejected", wrong.batches.length === 0 && wrong.errors.length > 0);
  ok("…and the error names the headers it found", wrong.errors[0]!.includes("Found: foo, bar"), wrong.errors[0]);

  // --- 3. The refusal that matters -----------------------------------------
  console.log("\n[3] an out-of-balance batch is refused, not imported");
  // Two distinct corruptions, because they fail two different checks. The first
  // run of this test only tampered with GROSS and passed — which is how the gap
  // was found: the batch-total check validates NET only, so a misread gross
  // column balanced perfectly and would have attributed the wrong amount to
  // every shipment in the payout.
  const cols = (line: string) => line.split(",");
  const grossTampered = csv.split("\n");
  {
    const f = cols(grossTampered[1]!);
    f[4] = "999999.00"; // COD Amount — gross − fee no longer equals net
    grossTampered[1] = f.join(",");
  }
  const netTampered = csv.split("\n");
  {
    const f = cols(netTampered[1]!);
    f[6] = "999999.00"; // Net Amount — lines no longer sum to the stated total
    f[4] = String(Number(f[6]) + Number(f[5])); // keep the line self-consistent
    netTampered[1] = f.join(",");
  }
  const tampered = grossTampered;
  const conn = await prisma.connection.upsert({
    where: {
      organizationId_provider_externalAccountId: {
        organizationId: org.id,
        provider: "BLUEDART",
        externalAccountId: "demo-bluedart",
      },
    },
    create: {
      organizationId: org.id,
      legalEntityId: entity!.id,
      provider: "BLUEDART",
      status: "ACTIVE",
      externalAccountId: "demo-bluedart",
      credentialsRef: "demo-seed:bluedart",
    },
    update: {},
  });
  const ctx = { connectionId: conn.id, organizationId: org.id, legalEntityId: entity!.id };
  const bad = await ingestStatement(ctx, tampered.join("\n"), BLUEDART_COD_STATEMENT);
  ok("a misread GROSS column is rejected", bad.rejected.length === 1, `${bad.rejected.length} rejected`);
  ok("…as a line mismatch", bad.rejected[0]?.reason === "line_mismatch", bad.rejected[0]?.reason ?? "none");
  ok("…and the rejection says which line", (bad.rejected[0]?.detail ?? "").includes("gross − fee"), bad.rejected[0]?.detail ?? "");

  const bad2 = await ingestStatement(ctx, netTampered.join("\n"), BLUEDART_COD_STATEMENT);
  ok("a misread NET column is rejected", bad2.rejected.length === 1, `${bad2.rejected.length} rejected`);
  ok("…as a total mismatch", bad2.rejected[0]?.reason === "total_mismatch", bad2.rejected[0]?.reason ?? "none");
  ok("…and the rejection quantifies the gap", (bad2.rejected[0]?.detail ?? "").includes("differ by"), bad2.rejected[0]?.detail ?? "");
  const importedFromBad = await prisma.settlementLine.count({
    where: { settlement: { externalSettlementId: bad.rejected[0]?.batchId ?? "" } },
  });
  ok("nothing from the rejected batch reached the database", importedFromBad === 0, String(importedFromBad));

  // --- 4. Import the clean statement ---------------------------------------
  console.log("\n[4] importing the clean statement");
  const res = await ingestStatement(ctx, csv, BLUEDART_COD_STATEMENT);
  ok("no rejections", res.rejected.length === 0, JSON.stringify(res.rejected.slice(0, 1)));
  ok("no errors", res.errors.length === 0, res.errors.slice(0, 2).join("; "));
  ok("every batch imported", res.batchesImported === batches.size, `${res.batchesImported}/${batches.size}`);
  ok("every line imported", res.linesImported === delivered.length, `${res.linesImported}/${delivered.length}`);
  ok("every AWB resolved to a shipment we hold", res.linesUnresolved === 0, `${res.linesUnresolved} unresolved`);
  console.log(`  ${res.batchesImported} payouts, ${res.linesImported} lines, ${inr(res.amountImportedPaise)} remitted`);

  // Re-importing the same file must update in place, not stack (§94).
  const again = await ingestStatement(ctx, csv, BLUEDART_COD_STATEMENT);
  const lineCount = await prisma.settlementLine.count({ where: { organizationId: org.id } });
  ok("re-importing is idempotent", lineCount === delivered.length, `${lineCount} lines after two imports`);
  ok("…and reports the same totals", again.linesImported === res.linesImported);

  // --- 5. The leg now runs --------------------------------------------------
  console.log("\n[5] reconciliation after import");
  const after = await runReconciliation(org.id);
  const cod = after.legs.find((l) => l.matchType === "COD_REMITTANCE")!;
  ok("COD leg now runs", cod.state === "ran", cod.state);
  ok("it produced matches", cod.matched > 0, String(cod.matched));
  ok("matched count equals the lines we imported", cod.matched === delivered.length, `${cod.matched} vs ${delivered.length}`);
  ok("no amount disagreements", cod.needsReview === 0, `${cod.needsReview} need review`);
  console.log(
    `  ${cod.matched} of ${cod.eligible} delivered COD shipments attributed, ${inr(cod.matchedValue)} traced to a payout`
  );

  // The match rows themselves — a leg that reports matches but writes none is
  // the failure this check is really guarding against.
  const written = await prisma.reconciliationMatch.count({
    where: { organizationId: org.id, matchType: "COD_REMITTANCE" },
  });
  ok("match rows were actually written", written === cod.matched, `${written} rows vs ${cod.matched} reported`);
  const sample = await prisma.reconciliationMatch.findFirst({
    where: { organizationId: org.id, matchType: "COD_REMITTANCE" },
    select: { sourceType: true, targetType: true, confidence: true },
  });
  ok("matches point SHIPMENT → SETTLEMENT", sample?.sourceType === "SHIPMENT" && sample?.targetType === "SETTLEMENT");
  ok("stated-by-provider matches are HIGH confidence", sample?.confidence === "HIGH", sample?.confidence);

  // --- 6. GoKwik's format goes through the same path -----------------------
  console.log("\n[6] the same importer reads GoKwik's report");
  const gkHeader = "Settlement Id,UTR,Settlement Date,AWB,Order Amount,Commission,Settled Amount,Total Settlement";
  const gkRows = [gkHeader];
  const gkItems = delivered.slice(0, 25);
  const gkTotal = gkItems.reduce((a, s) => a + (s.codAmount ?? 0n) - FEE_PAISE, 0n);
  for (const s of gkItems) {
    const gross = s.codAmount ?? 0n;
    gkRows.push(
      ["GK-PAYOUT-1", "UTRGK000001", "2026-08-01", s.awbCode, (Number(gross) / 100).toFixed(2),
       (Number(FEE_PAISE) / 100).toFixed(2), (Number(gross - FEE_PAISE) / 100).toFixed(2), (Number(gkTotal) / 100).toFixed(2)].join(",")
    );
  }
  const gkParsed = parseStatement(gkRows.join("\n"), GOKWIK_SETTLEMENT_STATEMENT);
  ok("GoKwik report parses with no errors", gkParsed.errors.length === 0, gkParsed.errors.slice(0, 2).join("; "));
  ok("GoKwik batch balances", gkParsed.batches[0]?.statedTotalPaise === gkParsed.batches[0]?.netPaise);
  ok("GoKwik lines carry the AWBs", gkParsed.batches[0]?.lines.length === gkItems.length);

  // --- 7. Containment -------------------------------------------------------
  console.log("\n[7] containment");
  // Scoped to the batches THIS SCRIPT fabricates ("BDCOD-…", "GK-PAYOUT-…"),
  // not to every settlement line in the database.
  //
  // It used to assert that no settlement line existed outside the demo org at
  // all, which conflated two different things: "this test leaked into a real
  // org" (a bug) and "a real org has settlement data" (the product working). It
  // started failing the moment a real GoKwik export was imported into the live
  // org — 95 genuine lines with real Axis UTRs — reporting success as a defect.
  // What must never happen is THIS script writing outside the demo org.
  const strayLines = await prisma.settlementLine.count({
    where: {
      organizationId: { not: org.id },
      settlement: { externalSettlementId: { startsWith: "BDCOD-" } },
    },
  });
  const strayGk = await prisma.settlementLine.count({
    where: {
      organizationId: { not: org.id },
      settlement: { externalSettlementId: { startsWith: "GK-PAYOUT-" } },
    },
  });
  ok("this script wrote no settlement lines outside the demo org", strayLines + strayGk === 0, String(strayLines + strayGk));

  finish();
}

function finish(): never {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length > 0) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  • ${f}`);
  }
  void prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
