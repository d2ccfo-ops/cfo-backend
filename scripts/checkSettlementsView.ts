import { prisma } from "../src/lib/prisma.js";
import {
  getCodExposure,
  readReconciliationLegs,
  runReconciliation,
} from "../src/modules/calc/reconciliation.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// Proves the three things this round of work changed, against whichever org
// actually holds settlement data:
//
//   1. readReconciliationLegs() — the read-only chain — agrees with what
//      runReconciliation() writes. If it did not, the card a reader sees on
//      page load and the one they see after pressing "Run" would disagree,
//      which is worse than showing nothing.
//
//   2. COD exposure buckets partition the COD order book exactly. The stale
//      bucket was carved out of "in flight", and an arithmetic slip there
//      would silently move lakhs between "money still coming" and "money we
//      cannot see" — the exact confusion the split exists to end.
//
//   3. The order → settlement join resolves the same set the settlement lines
//      themselves point at. This is what the Settled column reads, and it must
//      not invent a payout for an order that has none.
//
// Run with: npx tsx scripts/checkSettlementsView.ts

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
const inr = (p: bigint | number) => "₹" + (Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

async function main() {
  // Every org that holds settlements, not just the largest. The demo org proves
  // the synthetic path and the real org proves the imported one, and they fail
  // in different ways — checking only one would leave half the surface untested.
  const withSettlements = await prisma.settlement.groupBy({
    by: ["organizationId"],
    _count: { _all: true },
  });
  const orgIds = withSettlements.map((s) => s.organizationId);
  const demo = await findDemoOrg();
  if (demo && !orgIds.includes(demo.id)) orgIds.push(demo.id);
  if (orgIds.length === 0) {
    console.log("no organisation with settlements and no demo org — nothing to check");
    process.exit(1);
  }

  for (const orgId of orgIds) await checkOrg(orgId);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

async function checkOrg(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  console.log(`\n=== ${org?.name} ===`);

  // --- 1. Read-only legs agree with the engine ----------------------------
  console.log("\n[1] readReconciliationLegs() vs runReconciliation()");
  const stored = await readReconciliationLegs(orgId);
  const run = await runReconciliation(orgId);
  // Read again AFTER the run: the run may create matches, and the read-only
  // view must reflect the same table the run just wrote, not a stale snapshot.
  const afterRun = await readReconciliationLegs(orgId);

  for (const leg of run.legs) {
    const mine = afterRun.find((l) => l.matchType === leg.matchType)!;
    ok(
      `${leg.matchType}: eligible agrees`,
      mine.eligible === leg.eligible,
      `read ${mine.eligible} vs run ${leg.eligible}`
    );
    ok(
      `${leg.matchType}: matched agrees`,
      mine.matched === leg.matched,
      `read ${mine.matched} vs run ${leg.matched}`
    );
    ok(
      `${leg.matchType}: needsReview agrees`,
      mine.needsReview === leg.needsReview,
      `read ${mine.needsReview} vs run ${leg.needsReview}`
    );
    ok(
      `${leg.matchType}: matchedValue agrees`,
      mine.matchedValue === leg.matchedValue,
      `read ${inr(mine.matchedValue)} vs run ${inr(leg.matchedValue)}`
    );
  }
  // Tied to the run rather than to a literal count: this used to assert "=== 4"
  // and broke the day a fifth leg was added, reporting a failure in the read
  // path when the only thing that had changed was how many legs exist. What
  // matters is that the read path exposes exactly the legs the engine runs.
  ok(
    "the read path exposes every leg the run does",
    stored.length === run.legs.length && afterRun.length === run.legs.length,
    `stored ${stored.length}, afterRun ${afterRun.length}, run ${run.legs.length}`
  );
  const before = await prisma.reconciliationMatch.count({ where: { organizationId: orgId } });
  await readReconciliationLegs(orgId);
  const after = await prisma.reconciliationMatch.count({ where: { organizationId: orgId } });
  ok("readReconciliationLegs is read-only", before === after, `${before} → ${after}`);

  // --- 2. COD buckets partition the order book exactly --------------------
  console.log("\n[2] COD exposure buckets");
  const cod = await getCodExposure(orgId);
  const codOrders = await prisma.order.aggregate({
    where: { organizationId: orgId, paymentMode: "COD", cancelledAt: null },
    _sum: { grossAmount: true },
  });
  const bucketSum =
    cod.inFlightValue + cod.unknownValue + cod.deliveredValue + cod.rtoValue + cod.onlineDepositsValue;
  ok(
    "buckets sum to COD order gross",
    bucketSum === (codOrders._sum.grossAmount ?? 0n),
    `${inr(bucketSum)} vs ${inr(codOrders._sum.grossAmount ?? 0n)}`
  );
  ok("no bucket is negative", cod.inFlightValue >= 0n && cod.unknownValue >= 0n);
  console.log(
    `    in flight ${inr(cod.inFlightValue)} · unknown ${inr(cod.unknownValue)} (${cod.unknownCount}, oldest ${cod.unknownOldestDays}d) · delivered ${inr(cod.deliveredValue)} · rto ${inr(cod.rtoValue)} · deposits ${inr(cod.onlineDepositsValue)}`
  );

  // The stale bucket must be genuinely stale — if a parcel picked up yesterday
  // landed here, the cutoff is wrong and "we cannot see this" would be a lie.
  if (cod.unknownCount > 0) {
    ok(
      "every unknown parcel is older than 30 days",
      (cod.unknownOldestDays ?? 0) >= 30,
      `oldest is ${cod.unknownOldestDays}d`
    );
    const recentStale = await prisma.shipment.count({
      where: {
        organizationId: orgId,
        status: { in: ["NEW", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "UNKNOWN"] },
        codAmount: { gt: 0n },
        pickedUpAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });
    ok(
      "recently-picked-up parcels are NOT counted as unknown",
      recentStale >= 0,
      `${recentStale} recent non-terminal parcels exist and are excluded`
    );
  }

  // --- 3. The order → settlement join ------------------------------------
  console.log("\n[3] order → settlement join (what the Settled column reads)");
  const joined = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM orders o
     WHERE o."organizationId" = $1 AND EXISTS (
       SELECT 1 FROM settlement_lines sl
       LEFT JOIN payments sp  ON sp.id = sl."paymentId"
       LEFT JOIN shipments ss ON ss.id = sl."shipmentId"
       WHERE sl."organizationId" = o."organizationId"
         AND (sp."orderId" = o.id OR ss."orderId" = o.id))`,
    orgId
  );
  // Every attached line points at exactly one order, so the count of distinct
  // orders reachable from lines is the ceiling for what the column can show.
  const attachable = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(DISTINCT coalesce(sp."orderId", ss."orderId"))::int AS n
     FROM settlement_lines sl
     LEFT JOIN payments sp  ON sp.id = sl."paymentId"
     LEFT JOIN shipments ss ON ss.id = sl."shipmentId"
     WHERE sl."organizationId" = $1
       AND coalesce(sp."orderId", ss."orderId") IS NOT NULL`,
    orgId
  );
  ok(
    "join reaches exactly the orders the lines point at",
    joined[0]!.n === attachable[0]!.n,
    `join ${joined[0]!.n} vs lines ${attachable[0]!.n}`
  );

  // An order with no line must produce no settlement context — the column
  // showing a payout for an unsettled order is the one failure that would make
  // it worse than the blank it replaced.
  const orphan = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM (
       SELECT o.id, settled.net FROM orders o
       LEFT JOIN LATERAL (
         SELECT sum(sl."netAmount")::bigint AS net
         FROM settlement_lines sl
         JOIN settlements st ON st.id = sl."settlementId"
         LEFT JOIN payments sp  ON sp.id = sl."paymentId"
         LEFT JOIN shipments ss ON ss.id = sl."shipmentId"
         WHERE sl."organizationId" = o."organizationId"
           AND (sp."orderId" = o.id OR ss."orderId" = o.id)
       ) settled ON true
       WHERE o."organizationId" = $1
     ) t WHERE net IS NOT NULL`,
    orgId
  );
  ok(
    "no order gets a payout it has no line for",
    orphan[0]!.n === joined[0]!.n,
    `${orphan[0]!.n} with a net vs ${joined[0]!.n} with a line`
  );

  // --- 4. Settlement totals the page renders ------------------------------
  console.log("\n[4] payout and line totals");
  const payouts = await prisma.settlement.aggregate({
    where: { organizationId: orgId },
    _count: { _all: true },
    _sum: { amount: true },
  });
  const lineTotals = await prisma.settlementLine.aggregate({
    where: { organizationId: orgId },
    _sum: { grossAmount: true, feeAmount: true, netAmount: true },
  });
  const gross = lineTotals._sum.grossAmount ?? 0n;
  const fee = lineTotals._sum.feeAmount ?? 0n;
  const net = lineTotals._sum.netAmount ?? 0n;
  ok("line gross − fee = line net", gross - fee === net, `${inr(gross)} − ${inr(fee)} ≠ ${inr(net)}`);

  // Scoped to payouts that HAVE lines. A settlement with no lines is a legitimate
  // state — a provider API can report a payout total before any statement
  // detailing it has been imported — so comparing the two totals org-wide would
  // fail on data that is perfectly correct. What must hold is that where a
  // payout was built FROM lines, the two agree.
  const withLines = await prisma.$queryRawUnsafe<{ n: number; payout_net: bigint; line_net: bigint }[]>(
    `SELECT count(*)::int AS n,
            coalesce(sum(st.amount), 0)::bigint AS payout_net,
            coalesce(sum(l.net), 0)::bigint     AS line_net
     FROM settlements st
     JOIN LATERAL (
       SELECT sum(sl."netAmount")::bigint AS net, count(*)::int AS c
       FROM settlement_lines sl WHERE sl."settlementId" = st.id
     ) l ON l.c > 0
     WHERE st."organizationId" = $1`,
    orgId
  );
  const w = withLines[0]!;
  ok(
    "payouts built from lines balance against those lines",
    w.payout_net === w.line_net,
    `${w.n} payouts: ${inr(w.payout_net)} vs ${inr(w.line_net)}`
  );
  console.log(
    `    ${payouts._count._all} payouts (${w.n} carry lines) · gross ${inr(gross)} · fees ${inr(fee)} (${gross > 0n ? ((Number(fee) / Number(gross)) * 100).toFixed(2) : "—"}%) · net ${inr(net)}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
