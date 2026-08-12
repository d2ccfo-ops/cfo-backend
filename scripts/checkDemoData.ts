import { prisma } from "../src/lib/prisma.js";
import { resolveDateRange } from "../src/lib/dateRange.js";
import { getRevenueLadder, getRevenueTrend } from "../src/modules/calc/revenueLadder.js";
import { getContributionMargin } from "../src/modules/calc/contribution.js";
import { getAdEfficiencySummary, getAdSpendSummary } from "../src/modules/calc/ads.js";
import { getPayablesSummary } from "../src/modules/calc/payables.js";
import { getAvailableCashSummary, getCashReceivedSummary } from "../src/modules/calc/cash.js";
import { getRtoRateSummary } from "../src/modules/calc/shipments.js";
import { getInventoryCoverSummary, getInventoryValueSummary } from "../src/modules/calc/inventory.js";
import { getProductProfitability } from "../src/modules/calc/productProfitability.js";
import { ensureDemoNamePrefix, findDemoOrg } from "./lib/demoOrg.js";

// Checks that the generated demo data actually EXERCISES the paths it claims to,
// rather than merely existing.
//
// A seed where every order is paid, every parcel is delivered, every SKU is
// costed and the bank goes back to day one produces a dashboard on which every
// warning state is unreachable — so the demo would look perfect and test
// nothing. These assertions are all range checks with both a floor and a
// ceiling for that reason: "some RTO" and "not absurd amounts of RTO".
//
// Run with: npx tsx scripts/checkDemoData.ts

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
const inRange = (label: string, v: number, lo: number, hi: number, unit = "") =>
  ok(`${label} within [${lo}, ${hi}]${unit}`, v >= lo && v <= hi, `${v}${unit}`);

const rupees = (n: number | bigint) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const org = await findDemoOrg();
  if (!org) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }
  await ensureDemoNamePrefix(org);

  console.log(`\n=== ${org.name} ===`);
  const range = resolveDateRange({}, new Date(), org.timezone);

  // [1] Every source the dashboard reads has rows
  console.log("\n[1] every source is populated");
  const counts = {
    orders: await prisma.order.count({ where: { organizationId: org.id } }),
    lineItems: await prisma.orderLineItem.count({ where: { order: { organizationId: org.id } } }),
    payments: await prisma.payment.count({ where: { organizationId: org.id } }),
    settlements: await prisma.settlement.count({ where: { organizationId: org.id } }),
    shipments: await prisma.shipment.count({ where: { organizationId: org.id } }),
    bank: await prisma.bankTransaction.count({ where: { organizationId: org.id } }),
    adSpend: await prisma.adSpend.count({ where: { organizationId: org.id } }),
    products: await prisma.product.count({ where: { organizationId: org.id } }),
    costs: await prisma.productCost.count({ where: { organizationId: org.id } }),
    bills: await prisma.vendorBill.count({ where: { organizationId: org.id } }),
    expenses: await prisma.expense.count({ where: { organizationId: org.id } }),
  };
  for (const [name, n] of Object.entries(counts)) ok(`${name} present`, n > 0, String(n));
  console.log("  " + Object.entries(counts).map(([k, v]) => `${k} ${v.toLocaleString("en-IN")}`).join(" · "));

  // [2] The mix is Indian D2C, not a coin flip
  console.log("\n[2] order mix looks like an Indian D2C brand");
  const cod = await prisma.order.count({ where: { organizationId: org.id, paymentMode: "COD" } });
  const codPct = Math.round((cod / counts.orders) * 100);
  inRange("COD share", codPct, 50, 66, "%");

  const cancelled = await prisma.order.count({ where: { organizationId: org.id, cancelledAt: { not: null } } });
  inRange("cancellation rate", Math.round((cancelled / counts.orders) * 1000) / 10, 1.5, 4, "%");

  const refunded = await prisma.order.count({ where: { organizationId: org.id, refundedAmount: { gt: 0 } } });
  inRange("orders with a refund", Math.round((refunded / counts.orders) * 1000) / 10, 1.5, 5, "%");

  // [3] Shipment outcomes — RTO is the number that decides Indian D2C economics
  console.log("\n[3] shipment outcomes");
  const rto = await getRtoRateSummary(org.id, range);
  ok("RTO rate is measurable", rto.rtoRatePct != null, JSON.stringify(rto.rtoRatePct));
  if (rto.rtoRatePct != null) inRange("RTO rate", rto.rtoRatePct, 6, 22, "%");
  const inFlight = await prisma.shipment.count({
    where: { organizationId: org.id, status: { in: ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"] } },
  });
  ok("some parcels are still in flight", inFlight > 0, String(inFlight));

  // [4] Reconciliation reaches every branch of the classifier. This is the one
  //     that matters most: three of the seven statuses only exist because of
  //     deliberately-imperfect payments, and a clean seed would hide them.
  console.log("\n[4] reconciliation reaches every status");
  const statuses = await prisma.$queryRaw<{ status: string; n: bigint }[]>`
    SELECT CASE
      WHEN m.id IS NOT NULL AND m.status = 'RESOLVED' THEN 'written_off'
      WHEN o."cancelledAt" IS NOT NULL AND m.id IS NULL THEN 'cancelled'
      WHEN m.id IS NOT NULL AND m."amountDeltaAbs" > 100 THEN 'review'
      WHEN m.id IS NOT NULL AND m.confidence IN ('MEDIUM','LOW') THEN 'review'
      WHEN m.id IS NOT NULL THEN 'matched'
      WHEN o."paymentMode" = 'COD' THEN 'cod_pending'
      WHEN (o.raw->'payment_terms' IS NOT NULL AND o.raw->'payment_terms' <> 'null'::jsonb) THEN 'invoiced'
      ELSE 'unmatched'
    END AS status, count(*) AS n
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT rm.id, rm.status, rm.confidence, rm."amountDeltaAbs"
      FROM reconciliation_matches rm
      WHERE rm."sourceType" = 'ORDER' AND rm."sourceId" = o.id AND rm."matchType" = 'ORDER_PAYMENT'
      ORDER BY rm."createdAt" DESC LIMIT 1
    ) m ON true
    WHERE o."organizationId" = ${org.id}
    GROUP BY 1 ORDER BY 2 DESC`;
  const byStatus = new Map(statuses.map((s) => [s.status, Number(s.n)]));
  console.log("  " + statuses.map((s) => `${s.status} ${s.n}`).join(" · "));
  for (const s of ["matched", "review", "unmatched", "cod_pending", "invoiced", "cancelled"]) {
    ok(`status "${s}" is reachable`, (byStatus.get(s) ?? 0) > 0, "0 rows");
  }

  // [5] Cash: the bank starts partway through, so the trend has a real gap
  console.log("\n[5] bank visibility begins partway through");
  const trend = await getRevenueTrend(org.id);
  const visible = trend.series.filter((m) => m.cashVisible).length;
  ok("some months have cash visibility", visible > 0, String(visible));
  ok("not every month does", visible < trend.series.length, `${visible}/${trend.series.length}`);
  ok(
    "invisible months carry null, never 0",
    trend.series.filter((m) => !m.cashVisible).every((m) => m.cashReceived === null)
  );
  const cash = await getCashReceivedSummary(org.id, range);
  ok("cash received is a real figure", (cash.value ?? 0) > 0, rupees(cash.value ?? 0));
  const available = await getAvailableCashSummary(org.id);
  ok("available cash is computable (opening balance is set)", available.value != null, JSON.stringify(available));

  // [6] Costs: coverage above the 95% threshold, but not a flat 100%
  console.log("\n[6] product cost coverage clears 95% without being perfect");
  const cm = await getContributionMargin(org.id, range);
  const cov = cm.cogsCoverage;
  ok("coverage is reported", cov != null);
  if (cov) {
    // The backend's bar is every line, not 95% — see contribution.ts. The
    // default seed clears it; scripts/seedDemoData.ts --cost-gaps is the run
    // that deliberately does not, to show the guard firing.
    ok("every order line is costed", cov.costedLines === cov.totalLines, `${cov.costedLines}/${cov.totalLines}`);
    inRange("value coverage", cov.valueCoveragePct, 99, 100, "%");
  }
  ok("CM0 is reliable", cm.levels?.cm0?.reliable === true, JSON.stringify(cm.levels?.cm0));
  // CM3 stays unreliable because packaging/shipping/RTO cost have no source in
  // the schema at all. That is a real product gap, not a seeding one — asserted
  // so that it fails loudly if a later change starts silently claiming CM3.
  ok("CM3 is honestly marked unreliable", cm.levels?.cm3?.reliable === false, JSON.stringify(cm.levels?.cm3));

  // [7] The cards that were dark before now have numbers
  console.log("\n[7] previously-dark cards now compute");
  const ads = await getAdSpendSummary(org.id, range);
  ok("ad spend has a value", (ads.value ?? 0) > 0, rupees(ads.value ?? 0));
  ok("ad spend is single-currency by default", ads.mixedCurrency === false);
  const eff = await getAdEfficiencySummary(org.id, range);
  ok("ROAS is computable", eff.roas != null, JSON.stringify(eff.roas));
  const pay = await getPayablesSummary(org.id);
  ok("payables is connected", pay.connected === true);
  ok("payables has open bills", pay.billCount > 0, String(pay.billCount));
  ok("payables has something overdue", pay.overdueCount > 0, String(pay.overdueCount));

  const inv = await getInventoryValueSummary(org.id);
  ok("inventory value is computable", (inv.value ?? 0) > 0, rupees(inv.value ?? 0));
  const cover = await getInventoryCoverSummary(org.id);
  ok("some SKUs are at stockout risk", cover.skusAtStockoutRisk.count > 0, String(cover.skusAtStockoutRisk.count));
  ok("some stock is slow-moving", cover.slowMovingStockValue.count > 0, String(cover.slowMovingStockValue.count));

  const prod = await getProductProfitability(org.id, range);
  ok("products can be ranked by margin", prod.canRankByMargin === true);
  ok("every sold SKU is costed", prod.costedSkuCount === prod.skuCount, `${prod.costedSkuCount}/${prod.skuCount}`);

  // [8] The ladder still holds together on generated data
  console.log("\n[8] the revenue ladder is internally consistent");
  const ladder = await getRevenueLadder(org.id, range);
  const l = ladder.ladder;
  const v = (x: { value: number }) => x.value;
  ok("GMV > 0", v(l.gmv) > 0, rupees(v(l.gmv)));
  ok("gross order value ≥ GMV", v(l.grossOrderValue) >= v(l.gmv));
  ok("net order value ≤ gross order value", v(l.netOrderValue) <= v(l.grossOrderValue));
  ok("net revenue ≤ net order value", v(l.netRevenue) <= v(l.netOrderValue));
  ok("net revenue > 0", v(l.netRevenue) > 0, rupees(v(l.netRevenue)));
  console.log(
    `  GMV ${rupees(v(l.gmv))} → GOV ${rupees(v(l.grossOrderValue))} → NOV ${rupees(v(l.netOrderValue))} → net revenue ${rupees(v(l.netRevenue))}`
  );

  // [9] Nothing leaked into a real organisation
  console.log("\n[9] containment");
  const demoConns = await prisma.connection.findMany({
    where: { credentialsRef: { startsWith: "demo-seed:" } },
    select: { organizationId: true },
  });
  const orgs = new Set(demoConns.map((c) => c.organizationId));
  ok("demo connections live in exactly one organisation", orgs.size === 1, `${orgs.size} orgs`);
  ok("…and it is the DEMO-prefixed one", orgs.has(org.id));
  const strayOrders = await prisma.order.count({
    where: { organizationId: { not: org.id }, externalOrderId: { startsWith: "demo-" } },
  });
  ok("no demo orders in any other organisation", strayOrders === 0, String(strayOrders));

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  • ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
