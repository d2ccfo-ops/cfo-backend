import { prisma } from "../src/lib/prisma.js";
import { processReconItem } from "../src/modules/connectors/razorpay/index.js";
import { runReconciliation } from "../src/modules/calc/reconciliation.js";
import { MatchType } from "@prisma/client";
import { toConnectorContext } from "../src/modules/connectors/types.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// P1.4: settlement items + reversals/disputes + GST-on-fee, verified against
// the DEMO org (there is no live Razorpay account to test this against — see
// RazorpayReconItem's header comment in modules/connectors/razorpay/index.ts).
// Exercises processReconItem() directly with hand-built recon items rather
// than mocking HTTP, the same way checkAdSpendCsv.ts exercises
// importAdSpendCsv() directly — the fetch/pagination wrapper around it has
// nothing provider-specific left to get wrong once the mapping is right.
//
// Also proves the claim the plan makes: PAYMENT_SETTLEMENT was ALREADY fully
// implemented in modules/calc/reconciliation.ts, waiting on SettlementLine
// rows nothing wrote — so this ends by running real reconciliation and
// checking the leg actually matches, not just that rows landed.
//
// Run with: npx tsx scripts/checkRazorpaySettlementRecon.ts

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
  const org = await findDemoOrg();
  if (!org || !org.legalEntityId) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }

  const conn = await prisma.connection.create({
    data: {
      organizationId: org.id,
      legalEntityId: org.legalEntityId,
      provider: "RAZORPAY",
      status: "ACTIVE",
      externalAccountId: null,
      credentialsRef: "demo-seed:razorpay-recon-check",
    },
  });
  const ctx = toConnectorContext(conn);

  try {
    // A captured payment already sitting in Payment, as the existing
    // /payments pull would have written it — GST-on-fee included, proving
    // that half of P1.4 (previously fetched and dropped) is now stored.
    const payment = await prisma.payment.create({
      data: {
        organizationId: org.id,
        legalEntityId: org.legalEntityId,
        connectionId: conn.id,
        externalPaymentId: "pay_reconcheck1",
        amount: 500000n,
        status: "captured",
        feeAmount: 9440n,
        taxAmount: 1440n, // 18% GST on a ₹80 fee
        raw: {},
      },
    });
    const settlement = await prisma.settlement.create({
      data: {
        organizationId: org.id,
        legalEntityId: org.legalEntityId,
        connectionId: conn.id,
        externalSettlementId: "setl_reconcheck1",
        amount: 490560n,
        feeAmount: 9440n,
        taxAmount: 1440n,
        status: "processed",
        provider: "RAZORPAY",
        kind: "GATEWAY",
      },
    });

    console.log("\n[1] a payment-type recon item links Payment -> Settlement");
    const r1 = await processReconItem(ctx, {
      entity_id: "pay_reconcheck1",
      type: "payment",
      debit: 0,
      credit: 490560,
      amount: 500000,
      fee: 9440,
      tax: 1440,
      settlement_id: "setl_reconcheck1",
    });
    ok("imported", r1.imported === true, JSON.stringify(r1));
    const line1 = await prisma.settlementLine.findFirst({
      where: { settlementId: settlement.id, type: "PAYMENT", externalReference: "pay_reconcheck1" },
    });
    ok("line type is PAYMENT", line1?.type === "PAYMENT");
    ok("resolved to the internal Payment row", line1?.paymentId === payment.id);
    ok("grossAmount is the item's stated amount", line1?.grossAmount === 500000n, String(line1?.grossAmount));
    ok("feeAmount + taxAmount carried through as the fee breakdown", line1?.feeAmount === 9440n && line1?.taxAmount === 1440n);
    ok("netAmount is credit - debit, not amount - fee", line1?.netAmount === 490560n, String(line1?.netAmount));

    console.log("\n[2] a refund lands as an ADJUSTMENT line, not silently dropped");
    const r2 = await processReconItem(ctx, {
      entity_id: "rfnd_reconcheck1",
      type: "refund",
      debit: 150000,
      credit: 0,
      amount: 150000,
      fee: 0,
      tax: 0,
      settlement_id: "setl_reconcheck1",
    });
    ok("imported", r2.imported === true, JSON.stringify(r2));
    const line2 = await prisma.settlementLine.findFirst({
      where: { settlementId: settlement.id, type: "ADJUSTMENT", externalReference: "rfnd_reconcheck1" },
    });
    ok("refund line type is ADJUSTMENT", line2?.type === "ADJUSTMENT");
    ok("refund line has no payment FK (its own entity, not the original payment)", line2?.paymentId === null);
    ok("refund's negative contribution is captured as a negative netAmount", line2?.netAmount === -150000n, String(line2?.netAmount));
    ok("raw payload keeps the original 'refund' type for anyone reading it back", (line2?.raw as { type?: string } | null)?.type === "refund");

    console.log("\n[3] a dispute/chargeback (type: adjustment) is also kept, not dropped");
    const r3 = await processReconItem(ctx, {
      entity_id: "adj_reconcheck1",
      type: "adjustment",
      debit: 5000,
      credit: 0,
      amount: 5000,
      fee: 0,
      tax: 0,
      settlement_id: "setl_reconcheck1",
    });
    ok("imported", r3.imported === true, JSON.stringify(r3));
    ok(
      "dispute line exists as ADJUSTMENT",
      (await prisma.settlementLine.count({ where: { settlementId: settlement.id, type: "ADJUSTMENT", externalReference: "adj_reconcheck1" } })) === 1
    );

    console.log("\n[4] re-processing the same item updates in place, not a duplicate row");
    await processReconItem(ctx, {
      entity_id: "pay_reconcheck1",
      type: "payment",
      debit: 0,
      credit: 490560,
      amount: 500000,
      fee: 9440,
      tax: 1440,
      settlement_id: "setl_reconcheck1",
    });
    ok(
      "still exactly one line for pay_reconcheck1",
      (await prisma.settlementLine.count({ where: { settlementId: settlement.id, externalReference: "pay_reconcheck1" } })) === 1
    );

    console.log("\n[5] an item still on hold (no settlement_id yet) is skipped, not guessed at");
    const r5 = await processReconItem(ctx, {
      entity_id: "pay_onhold1",
      type: "payment",
      debit: 0,
      credit: 90000,
      amount: 90000,
      fee: 1800,
      tax: 275,
      settlement_id: null,
    });
    ok("not imported", r5.imported === false && r5.reason === "not_settled", JSON.stringify(r5));

    console.log("\n[6] an item naming a settlement we haven't pulled yet is skipped, not fabricated");
    const r6 = await processReconItem(ctx, {
      entity_id: "pay_futuresettle1",
      type: "payment",
      debit: 0,
      credit: 90000,
      amount: 90000,
      fee: 1800,
      tax: 275,
      settlement_id: "setl_not_yet_synced",
    });
    ok("not imported", r6.imported === false && r6.reason === "settlement_not_found", JSON.stringify(r6));

    console.log("\n[7] the leg the plan said was already built now actually matches");
    // This is the claim P1.4 makes: runPaymentSettlementLeg has been fully
    // written since before this session and was only ever "unavailable" for
    // want of SettlementLine rows. Prove it end to end, not just that a row
    // exists in isolation.
    await prisma.reconciliationMatch.deleteMany({ where: { organizationId: org.id, matchType: MatchType.PAYMENT_SETTLEMENT, sourceId: payment.id } });
    const result = await runReconciliation(org.id);
    const leg = result.legs.find((l) => l.matchType === MatchType.PAYMENT_SETTLEMENT);
    ok("leg state is 'ran', not 'unavailable'", leg?.state === "ran", `state=${leg?.state} blockedReason=${leg?.blockedReason ?? "none"}`);
    const match = await prisma.reconciliationMatch.findFirst({
      where: { organizationId: org.id, matchType: MatchType.PAYMENT_SETTLEMENT, sourceId: payment.id },
    });
    ok("our seeded payment has a HIGH-confidence match", match?.confidence === "HIGH", `confidence=${match?.confidence}`);
    ok("matched to the right settlement", match?.targetId === settlement.id, `targetId=${match?.targetId}`);
  } finally {
    // ReconciliationMatch has no FK to Payment/Settlement (sourceId/targetId
    // are polymorphic strings, matched against whichever table sourceType
    // names) — cleaned up explicitly so the demo org's match table doesn't
    // accumulate rows pointing at rows this script is about to delete.
    const scratchPaymentIds = (await prisma.payment.findMany({ where: { connectionId: conn.id }, select: { id: true } })).map((p) => p.id);
    await prisma.reconciliationMatch.deleteMany({
      where: { organizationId: org.id, matchType: MatchType.PAYMENT_SETTLEMENT, sourceType: "PAYMENT", sourceId: { in: scratchPaymentIds } },
    });
    // Settlement's onDelete: Cascade takes SettlementLine with it.
    await prisma.settlement.deleteMany({ where: { connectionId: conn.id } });
    await prisma.payment.deleteMany({ where: { connectionId: conn.id } });
    await prisma.rawEvent.deleteMany({ where: { connectionId: conn.id } });
    await prisma.connection.delete({ where: { id: conn.id } });
  }

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
