import { prisma } from "../src/lib/prisma.js";
import { resolveDateRange } from "../src/lib/dateRange.js";
import { getRevenueLadder, getRevenueTrend } from "../src/modules/calc/revenueLadder.js";

// Audits GET /metrics/revenue-ladder against the exact set of fields
// app/(dashboard)/revenue/page.js reads, and cross-checks the arithmetic
// against independent SQL. A field that silently goes missing renders as "—"
// or NaN on the page rather than throwing, so absence has to be tested for
// explicitly.
//
// Run with: npx tsx scripts/checkRevenuePage.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// A number the page will render. null is allowed only where the page has an
// explicit fallback; NaN and undefined never are.
function present(label: string, value: unknown, allowNull = false) {
  if (value === undefined) return ok(label, false, "undefined");
  if (value === null) return ok(label, allowNull, allowNull ? "" : "null");
  if (typeof value === "number" && Number.isNaN(value)) return ok(label, false, "NaN");
  return ok(label, true);
}

const rupees = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

async function auditOrg(organizationId: string, orgName: string, timezone: string) {
  console.log(`\n=== ${orgName} ===`);

  const range = resolveDateRange({}, new Date(), timezone);
  const [d, t] = await Promise.all([
    getRevenueLadder(organizationId, range),
    getRevenueTrend(organizationId),
  ]);
  const data = { ...d, trend: t.series, cashCoverage: t.cashCoverage } as Record<string, any>;

  console.log(
    `period ${range.from.toISOString().slice(0, 10)} → ${range.to.toISOString().slice(0, 10)} (${data.orders.total} orders)`
  );

  // --- 1. Every field the page reads ------------------------------------
  console.log("\n[1] fields the page renders");
  present("status", data.status);
  present("dataCompleteness", data.dataCompleteness);
  present("recognitionBasis", data.recognitionBasis);
  present("formulaVersion", data.formulaVersion);
  present("lastCalculatedAt", data.lastCalculatedAt);
  ok("warnings is an array", Array.isArray(data.warnings));

  for (const key of ["gmv", "grossOrderValue", "netOrderValue", "outputGst", "netRevenue"]) {
    present(`ladder.${key}.value`, data.ladder?.[key]?.value);
    present(`ladder.${key}.changePct`, data.ladder?.[key]?.changePct, true);
    present(`ladder.${key}.spec`, data.ladder?.[key]?.spec);
  }

  present("orders.total", data.orders?.total);
  present("orders.recognised", data.orders?.recognised);
  present("orders.cancelled", data.orders?.cancelled);
  present("orders.changePct", data.orders?.changePct, true);

  present("aov.allPlaced", data.aov?.allPlaced, true);
  present("aov.allPlacedPrior", data.aov?.allPlacedPrior, true);
  present("aov.ordered", data.aov?.ordered, true);

  present("refunds.revenueRefundRatePct", data.refunds?.revenueRefundRatePct, true);
  present("refunds.orderRefundRatePct", data.refunds?.orderRefundRatePct, true);
  // Without a prior rate the card can only colour by level, which paints a
  // 0.5% refund rate exactly as red as 40%.
  present("refunds.priorRevenueRefundRatePct", data.refunds?.priorRevenueRefundRatePct, true);
  present("refunds.priorOrderRefundRatePct", data.refunds?.priorOrderRefundRatePct, true);

  present("cancellations.ratePct", data.cancellations?.ratePct, true);
  present("cancellations.valueRatePct", data.cancellations?.valueRatePct, true);
  present("cancellations.priorRatePct", data.cancellations?.priorRatePct, true);
  present("cancellations.priorValueRatePct", data.cancellations?.priorValueRatePct, true);
  present("cancellations.count", data.cancellations?.count);

  ok("waterfall is a non-empty array", Array.isArray(data.waterfall) && data.waterfall.length > 0);
  for (const step of data.waterfall ?? []) {
    present(`waterfall[${step.label}].value`, step.value);
    present(`waterfall[${step.label}].spec`, step.spec);
    present(`waterfall[${step.label}].kind`, step.kind);
  }

  ok("trend is an array", Array.isArray(data.trend));
  for (const m of data.trend ?? []) {
    present(`trend[${m.label}].netRevenue`, m.netRevenue);
    // null is CORRECT here for a month with no bank visibility — it renders as
    // a gap rather than a zero. What must never happen is undefined or NaN.
    present(`trend[${m.label}].cashReceived`, m.cashReceived, true);
  }
  present("cashCoverage.hasBankConnection", data.cashCoverage?.hasBankConnection);
  present("cashCoverage.note", data.cashCoverage?.note);
  present("cashCoverage.coveredMonths", data.cashCoverage?.coveredMonths);

  ok("byChannel is an array", Array.isArray(data.byChannel));
  for (const c of data.byChannel ?? []) {
    present(`byChannel[${c.channel}].orders`, c.orders);
    present(`byChannel[${c.channel}].gmv.value`, c.gmv?.value);
    present(`byChannel[${c.channel}].netRevenue.value`, c.netRevenue?.value);
    present(`byChannel[${c.channel}].sharePct`, c.sharePct, true);
  }

  for (const k of ["codPct", "codValuePct", "prepaidValuePct", "codCount", "prepaidPct", "prepaidCount", "unknownCount"]) {
    present(`paymentMix.${k}`, data.paymentMix?.[k], true);
  }
  const mixValueSum = (data.paymentMix?.codValuePct ?? 0) + (data.paymentMix?.prepaidValuePct ?? 0);
  ok("COD + prepaid value shares sum to 100%", data.orders.total === 0 || Math.abs(mixValueSum - 100) < 0.2, `${mixValueSum}%`);

  present("repeatCustomers.ratePct", data.repeatCustomers?.ratePct, true);
  present("repeatCustomers.repeat", data.repeatCustomers?.repeat);
  present("repeatCustomers.customers", data.repeatCustomers?.customers);

  // --- 2. Internal consistency ------------------------------------------
  console.log("\n[2] internal consistency");
  const l = data.ladder;
  console.log(
    `  GMV ${rupees(l.gmv.value)} → GOV ${rupees(l.grossOrderValue.value)} → NOV ${rupees(l.netOrderValue.value)} → net revenue ${rupees(l.netRevenue.value)} (GST ${rupees(l.outputGst.value)})`
  );

  // §6: gross order value = GMV + shipping.
  ok("GOV >= GMV (shipping is additive)", l.grossOrderValue.value >= l.gmv.value,
     `${l.grossOrderValue.value} vs ${l.gmv.value}`);
  // §7: net order value = GMV − discounts + shipping, so it cannot exceed GOV.
  ok("NOV <= GOV (discounts only reduce)", l.netOrderValue.value <= l.grossOrderValue.value,
     `${l.netOrderValue.value} vs ${l.grossOrderValue.value}`);
  // §11: net revenue drops cancellations and refunds out of net order value.
  ok("net revenue <= NOV", l.netRevenue.value <= l.netOrderValue.value,
     `${l.netRevenue.value} vs ${l.netOrderValue.value}`);

  // The waterfall must actually add up — it is the page's headline explanation
  // of where order value goes, and a waterfall that doesn't reconcile is worse
  // than no waterfall.
  const steps = data.waterfall;
  const walked = steps.slice(0, -1).reduce((sum: number, s: any) => sum + s.value, 0);
  const stated = steps[steps.length - 1].value;
  const drift = Math.abs(walked - stated);
  ok("waterfall steps sum to net revenue", drift < 1, `walk ${rupees(walked)} vs stated ${rupees(stated)}, drift ${rupees(drift)}`);

  const orderSum = data.orders.recognised + data.orders.cancelled;
  ok("recognised + cancelled = total orders", orderSum === data.orders.total,
     `${data.orders.recognised} + ${data.orders.cancelled} = ${orderSum} vs ${data.orders.total}`);

  const mixSum = (data.paymentMix.codCount ?? 0) + (data.paymentMix.prepaidCount ?? 0) + (data.paymentMix.unknownCount ?? 0);
  ok("payment mix counts sum to recognised orders", mixSum === data.orders.recognised || mixSum === data.orders.total,
     `${mixSum} vs recognised ${data.orders.recognised} / total ${data.orders.total}`);

  const channelNet = (data.byChannel ?? []).reduce((s: number, c: any) => s + c.netRevenue.value, 0);
  ok("byChannel net revenue sums to ladder net revenue", Math.abs(channelNet - l.netRevenue.value) < 1,
     `${rupees(channelNet)} vs ${rupees(l.netRevenue.value)}`);

  const shareSum = (data.byChannel ?? []).reduce((s: number, c: any) => s + (c.sharePct ?? 0), 0);
  ok("channel shares sum to ~100%", data.byChannel.length === 0 || Math.abs(shareSum - 100) < 1.5, `${shareSum}%`);

  ok("repeat customers <= total customers", data.repeatCustomers.repeat <= data.repeatCustomers.customers,
     `${data.repeatCustomers.repeat} / ${data.repeatCustomers.customers}`);

  // --- 3. Against independent SQL ---------------------------------------
  console.log("\n[3] cross-check against SQL");
  const sql = await prisma.$queryRaw<
    { total: bigint; cancelled: bigint; gross: bigint; shipping: bigint; tax: bigint; refunded: bigint; cod: bigint; prepaid: bigint; unknown: bigint }[]
  >`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE o."cancelledAt" IS NOT NULL) AS cancelled,
           sum(o."grossAmount")::bigint AS gross,
           sum(o."shippingAmount")::bigint AS shipping,
           sum(o."taxAmount")::bigint AS tax,
           sum(o."refundedAmount")::bigint AS refunded,
           count(*) FILTER (WHERE o."paymentMode" = 'COD') AS cod,
           count(*) FILTER (WHERE o."paymentMode" = 'PREPAID') AS prepaid,
           count(*) FILTER (WHERE o."paymentMode" NOT IN ('COD','PREPAID') OR o."paymentMode" IS NULL) AS unknown
    FROM orders o
    WHERE o."organizationId" = ${organizationId}
      AND o."placedAt" >= ${range.from} AND o."placedAt" <= ${range.to}`;

  const s = sql[0]!;
  ok("order count matches SQL", Number(s.total) === data.orders.total, `${s.total} vs ${data.orders.total}`);
  ok("cancelled count matches SQL", Number(s.cancelled) === data.orders.cancelled, `${s.cancelled} vs ${data.orders.cancelled}`);

  // Payment mix is on the RECOGNISED basis (§16) — a cancelled order never
  // ships, so it carries neither RTO risk nor remittance lag and does not
  // belong in a mix that exists to describe those economics. So the comparison
  // has to exclude cancelled orders too; comparing against all placed orders
  // was the bug in an earlier version of this check, not a bug in the ladder.
  const recognisedSql = await prisma.$queryRaw<{ cod: bigint; prepaid: bigint; unknown: bigint }[]>`
    SELECT count(*) FILTER (WHERE o."paymentMode" = 'COD') AS cod,
           count(*) FILTER (WHERE o."paymentMode" = 'PREPAID') AS prepaid,
           count(*) FILTER (WHERE o."paymentMode" NOT IN ('COD','PREPAID') OR o."paymentMode" IS NULL) AS unknown
    FROM orders o
    WHERE o."organizationId" = ${organizationId}
      AND o."cancelledAt" IS NULL
      AND o."placedAt" >= ${range.from} AND o."placedAt" <= ${range.to}`;
  const r = recognisedSql[0]!;
  ok("COD count matches SQL (recognised basis)", Number(r.cod) === data.paymentMix.codCount,
     `${r.cod} vs ${data.paymentMix.codCount}`);
  ok("prepaid count matches SQL (recognised basis)", Number(r.prepaid) === data.paymentMix.prepaidCount,
     `${r.prepaid} vs ${data.paymentMix.prepaidCount}`);
  ok("unknown-mode count matches SQL (recognised basis)", Number(r.unknown) === data.paymentMix.unknownCount,
     `${r.unknown} vs ${data.paymentMix.unknownCount}`);

  // The exact §7 identity. netOrderValue = taxExclusiveSale + shipping, and
  // taxExclusiveSale = grossAmount − shipping − tax, so shipping cancels and
  // net order value must equal Σgross − Σtax TO THE PAISE. This is the check
  // that actually proves GST is being stripped correctly.
  const grossInclusive = Number(s.gross) / 100;
  const taxAll = Number(s.tax) / 100;
  const shipping = Number(s.shipping) / 100;
  const expectedNov = Math.round((grossInclusive - taxAll) * 100) / 100;
  console.log(`  Σgross(incl GST) ${rupees(grossInclusive)} − Σtax ${rupees(taxAll)} = ${rupees(expectedNov)}`);
  ok("net order value == Σgross − Σtax exactly", Math.abs(expectedNov - l.netOrderValue.value) < 0.02,
     `expected ${rupees(expectedNov)}, ladder says ${rupees(l.netOrderValue.value)}`);

  // GOV is BEFORE discounts, so it can legitimately exceed what customers
  // actually paid whenever discounts outweigh GST — which is exactly the case
  // on this store. The identity that must hold is GOV − discounts = NOV.
  const discounts = data.discounts.value;
  console.log(
    `  GOV(ex GST, pre-discount) ${rupees(l.grossOrderValue.value)} − discounts ${rupees(discounts)} = ${rupees(l.grossOrderValue.value - discounts)}`
  );
  ok("gross order value − discounts == net order value",
     Math.abs(l.grossOrderValue.value - discounts - l.netOrderValue.value) < 0.02,
     `${rupees(l.grossOrderValue.value - discounts)} vs ${rupees(l.netOrderValue.value)}`);
  ok("gross order value == GMV + shipping",
     Math.abs(l.gmv.value + shipping - l.grossOrderValue.value) < 0.02,
     `${rupees(l.gmv.value + shipping)} vs ${rupees(l.grossOrderValue.value)}`);

  // Output GST is on the recognised basis, so it must be at or below the tax
  // collected across every order placed.
  const gst = l.outputGst.value;
  ok("output GST <= total tax on all placed orders", gst <= taxAll + 0.02, `${rupees(gst)} vs ${rupees(taxAll)}`);
  ok("output GST is a plausible share of order value", gst > 0 && gst / grossInclusive < 0.30,
     `GST is ${((gst / grossInclusive) * 100).toFixed(1)}% of what customers paid`);

  // --- 4. Trend ----------------------------------------------------------
  console.log("\n[4] trend series");
  console.log(`  net revenue:   ${data.trend.map((t: any) => `${t.label}=${rupees(t.netRevenue)}`).join(", ")}`);
  console.log(
    `  cash received: ${data.trend.map((t: any) => `${t.label}=${t.cashReceived === null ? "no visibility" : rupees(t.cashReceived)}`).join(", ")}`
  );

  // The chart plots "Net revenue vs cash received" as two comparable lines.
  // If no bank data exists, the cash line is a flat zero — which reads as "no
  // money arrived" rather than "we cannot see the bank", and that is a §110
  // trust failure, not a data point.
  console.log(`  coverage: ${data.cashCoverage.note}`);
  const bankConnections = await prisma.connection.count({
    where: { organizationId, provider: { in: ["BANK", "BANK_AA"] }, status: "ACTIVE" },
  });
  ok("cashCoverage.hasBankConnection matches reality", data.cashCoverage.hasBankConnection === (bankConnections > 0),
     `${data.cashCoverage.hasBankConnection} vs ${bankConnections} connection(s)`);
  // With no bank connection every month must be null, never 0 — a zero is a
  // claim that no money arrived.
  if (!data.cashCoverage.hasBankConnection) {
    ok("no bank connection ⇒ every cash point is null",
       data.trend.every((m: any) => m.cashReceived === null),
       `${data.trend.filter((m: any) => m.cashReceived !== null).length} non-null point(s)`);
  }
  ok("covered month count matches the non-null points",
     data.cashCoverage.coveredMonths === data.trend.filter((m: any) => m.cashReceived !== null).length,
     `${data.cashCoverage.coveredMonths} vs ${data.trend.filter((m: any) => m.cashReceived !== null).length}`);
  ok("trend has 6 buckets (page subtitle says trailing 6 months)", data.trend.length === 6, `${data.trend.length}`);
  ok("trend months are unique", new Set(data.trend.map((t: any) => t.month)).size === data.trend.length);
  ok("every trend bucket has a label", data.trend.every((t: any) => typeof t.label === "string" && t.label.length > 0));

  // --- 5. A custom range, to prove the filter is wired -------------------
  console.log("\n[5] custom range");
  const custom = resolveDateRange({ from: "2026-07-01", to: "2026-07-31" }, new Date(), timezone);
  const july = await getRevenueLadder(organizationId, custom);
  console.log(
    `  July: ${july.orders.total} orders, GMV ${rupees(july.ladder.gmv.value)}, net revenue ${rupees(july.ladder.netRevenue.value)}`
  );
  const julySql = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM orders o
    WHERE o."organizationId" = ${organizationId}
      AND o."placedAt" >= ${custom.from} AND o."placedAt" <= ${custom.to}`;
  ok("custom range order count matches SQL", Number(julySql[0]!.n) === july.orders.total,
     `${julySql[0]!.n} vs ${july.orders.total}`);
  ok("custom range differs from MTD", july.orders.total !== data.orders.total);
}

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true, timezone: true } });
  for (const org of orgs) {
    const n = await prisma.order.count({ where: { organizationId: org.id } });
    if (n === 0) continue;
    await auditOrg(org.id, org.name, org.timezone);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
