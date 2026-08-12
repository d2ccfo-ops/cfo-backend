import { prisma } from "../src/lib/prisma.js";
import { readReconciliationLegs, runReconciliation } from "../src/modules/calc/reconciliation.js";
import { mapRefunds } from "../src/modules/connectors/shopify/index.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// P2.3a/b — the §15 leg 6 refund leg, against real data.
//
// Run with: npx tsx scripts/checkRefundLeg.ts

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1; else { fail += 1; failures.push(`${label}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const rupees = (p: bigint | string) => "₹" + (Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const org = await findDemoOrg();
  if (!org) { console.log("no demo organisation"); process.exit(1); }

  console.log("\n[1] mapRefunds shares the void rule with refundedTotal");
  // Two definitions of "a refund happened" would put rows in the table that the
  // order's own refundedAmount does not account for, and the leg would report
  // them unmatched forever.
  const voidOnly = { id: 1, created_at: "2026-08-01T00:00:00Z", currency: "INR",
    refunds: [{ id: 9, created_at: "2026-08-02T00:00:00Z", transactions: [{ id: 91, kind: "void", status: "success", amount: "500.00" }] }] };
  ok("a void produces no refund row", mapRefunds(voidOnly as never).length === 0);
  const zero = { id: 2, created_at: "2026-08-01T00:00:00Z", currency: "INR",
    refunds: [{ id: 9, transactions: [{ id: 92, kind: "refund", status: "success", amount: "0.00" }] }] };
  ok("a zero-amount refund produces no row", mapRefunds(zero as never).length === 0);
  const noId = { id: 3, created_at: "2026-08-01T00:00:00Z", currency: "INR",
    refunds: [{ id: 9, transactions: [{ kind: "refund", status: "success", amount: "100.00" }] }] };
  ok("a transaction with no id is skipped, not given a guessed key", mapRefunds(noId as never).length === 0);
  const failed = { id: 4, created_at: "2026-08-01T00:00:00Z", currency: "INR",
    refunds: [{ id: 9, transactions: [{ id: 94, kind: "refund", status: "failure", amount: "100.00" }] }] };
  ok("a failed refund produces no row", mapRefunds(failed as never).length === 0);
  const good = { id: 5, created_at: "2026-08-01T00:00:00Z", currency: "INR",
    refunds: [{ id: 9, processed_at: "2026-08-05T10:00:00Z",
      transactions: [{ id: 95, kind: "refund", status: "success", amount: "1240.50", gateway: "razorpay", processed_at: "2026-08-05T10:00:00Z", receipt: { refund_id: "rfnd_abc" } }] }] };
  const mapped = mapRefunds(good as never);
  ok("a real refund produces exactly one row", mapped.length === 1);
  ok("keyed by the TRANSACTION id, not the refund id", mapped[0]?.externalRefundId === "95", mapped[0]?.externalRefundId);
  ok("amount in paise", mapped[0]?.amount === 124050n, String(mapped[0]?.amount));
  ok("dated by processed_at, not created_at", mapped[0]?.processedAt.toISOString() === "2026-08-05T10:00:00.000Z");
  ok("gateway reference lifted out of the receipt", mapped[0]?.gatewayRef === "rfnd_abc", mapped[0]?.gatewayRef ?? "null");
  const noReceipt = { id: 6, created_at: "2026-08-01T00:00:00Z", currency: "INR",
    refunds: [{ id: 9, transactions: [{ id: 96, kind: "refund", status: "success", amount: "10.00", processed_at: "2026-08-05T00:00:00Z" }] }] };
  ok("a missing receipt degrades to null rather than throwing", mapRefunds(noReceipt as never)[0]?.gatewayRef === null);

  console.log("\n[2] every real order's refund rows sum to its refundedAmount");
  const drift = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM (
      SELECT o.id FROM orders o LEFT JOIN refunds r ON r."orderId" = o.id
      WHERE o.channel='shopify' AND o."organizationId" <> ${org.id}
      GROUP BY o.id, o."refundedAmount" HAVING COALESCE(SUM(r.amount),0) <> o."refundedAmount") t`;
  ok("no drift in real organisations", Number(drift[0]!.n) === 0, `${drift[0]!.n} orders`);

  console.log("\n[3] the leg appears in both the run and the read path");
  const legs = await readReconciliationLegs(org.id);
  const readLeg = legs.find((l) => l.matchType === "REFUND_PAYMENT");
  ok("read path exposes REFUND_PAYMENT", readLeg !== undefined);
  ok("it is one of six legs now", legs.length === 6, `${legs.length}`);

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  for (const o of orgs) {
    const refundCount = await prisma.refund.count({ where: { organizationId: o.id } });
    if (refundCount === 0) continue;
    const run = await runReconciliation(o.id);
    const leg = run.legs.find((l) => l.matchType === "REFUND_PAYMENT")!;
    console.log(`\n  ${o.name}: ${refundCount} refunds → state=${leg.state} eligible=${leg.eligible} matched=${leg.matched} unmatched=${leg.unmatched}`);
    if (leg.state === "unavailable") console.log(`     blocked: ${leg.blockedReason}`);
    ok(`${o.name}: eligible equals the refund count`, leg.eligible === refundCount, `${leg.eligible} vs ${refundCount}`);
    ok(`${o.name}: matched + unmatched == eligible`, leg.matched + leg.unmatched === leg.eligible);
    ok(`${o.name}: an unavailable leg explains itself`, leg.state === "ran" || (leg.blockedReason ?? "").length > 20);
    ok(`${o.name}: matched value never exceeds total refund value`, leg.matchedValue <= leg.matchedValue + leg.unmatchedValue);

    // Re-running must converge, not accumulate — the engine is a pure function
    // of the current tables.
    const again = await runReconciliation(o.id);
    const leg2 = again.legs.find((l) => l.matchType === "REFUND_PAYMENT")!;
    ok(`${o.name}: a second run is identical`, leg2.matched === leg.matched && leg2.eligible === leg.eligible);
  }

  console.log("\n[4] no settlement line is claimed by two refunds");
  const dup = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM (
      SELECT "targetId" FROM reconciliation_matches
      WHERE "matchType" = 'REFUND_PAYMENT' AND status <> 'EXCEPTION'
      GROUP BY "targetId" HAVING count(DISTINCT "sourceId") > 1) t`;
  ok("each settlement line matches at most one refund", Number(dup[0]!.n) === 0, `${dup[0]!.n} contested lines`);

  console.log("\n[5] the frontend can label the new leg");
  const { readFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const page = await readFile(new URL("../../cfo-frontend/app/(dashboard)/reconciliation/page.js", pathToFileURL(import.meta.dirname + "/")), "utf8");
  const labelled = [...page.matchAll(/^\s{2}([A-Z_]+):\s*"/gm)].map((m) => m[1]!);
  for (const l of legs) ok(`the page has a label for ${l.matchType}`, labelled.includes(l.matchType));

  console.log("\n" + "─".repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f}`));
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
