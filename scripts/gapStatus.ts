import { prisma } from "../src/lib/prisma.js";
import { getCostCoverage } from "../src/modules/calc/cogs.js";
import { readReconciliationLegs, readFreightSummary, getCodExposure } from "../src/modules/calc/reconciliation.js";

// Read-only. Prints the current state of every "built but starved of data" gap
// line so we can see what the cost seed changed and what is still blocked.
// Values are paise; ₹ figures are derived for display only.

const ORG = "cmsirmi2f0000uusqp83kus59"; // Hrtiik pvt ltd

const rupees = (paise: bigint | number) =>
  "₹" + (Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const [coverage, legs, freight, cod] = await Promise.all([
    getCostCoverage(ORG),
    readReconciliationLegs(ORG),
    readFreightSummary(ORG),
    getCodExposure(ORG),
  ]);

  // Cost source breakdown — how much of the coverage is ESTIMATED vs real.
  const bySource = await prisma.productCost.groupBy({
    by: ["source"],
    where: { organizationId: ORG },
    _count: { _all: true },
  });

  const revenueAgg = await prisma.orderLineItem.aggregate({
    where: { order: { organizationId: ORG } },
    _sum: { totalAmount: true, cogsAmount: true },
  });
  const revenue = revenueAgg._sum.totalAmount ?? 0n;
  const cogs = revenueAgg._sum.cogsAmount ?? 0n;

  const [settlementCount, bankCount, paymentCount, googleSpend, metaSpend] = await Promise.all([
    prisma.settlement.count({ where: { organizationId: ORG } }),
    prisma.bankTransaction.count({ where: { organizationId: ORG } }),
    prisma.payment.count({ where: { organizationId: ORG } }),
    prisma.adSpend.aggregate({ where: { organizationId: ORG, provider: "GOOGLE_ADS" }, _sum: { spendAmount: true }, _count: { _all: true } }),
    prisma.adSpend.aggregate({ where: { organizationId: ORG, provider: "META_ADS" }, _sum: { spendAmount: true }, _count: { _all: true } }),
  ]);

  const legLine = (t: string) => legs.find((l) => l.matchType === t);
  const op = legLine("ORDER_PAYMENT");
  const ps = legLine("PAYMENT_SETTLEMENT");
  const sb = legLine("SETTLEMENT_BANK");
  const cr = legLine("COD_REMITTANCE");
  const sf = legLine("SHIPMENT_FREIGHT");

  const out = {
    "1_contribution_margin": {
      lineCoveragePct: coverage.lineCoveragePct,
      valueCoveragePct: coverage.valueCoveragePct,
      costedLines: coverage.costedLines,
      totalLines: coverage.totalLines,
      missingSkuCount: coverage.missingSkuCount,
      uncostableLineCount: coverage.uncostableLineCount,
      costRowsBySource: bySource.map((b) => ({ source: b.source, count: b._count._all })),
      revenue: rupees(revenue),
      cogs: rupees(cogs),
      grossMargin: rupees(revenue - cogs),
      grossMarginPct: revenue > 0n ? Math.round((Number(revenue - cogs) / Number(revenue)) * 1000) / 10 : null,
    },
    "2_freight_coverage": {
      state: sf?.state,
      matched: sf?.matched,
      eligible: sf?.eligible,
      invoices: freight.invoices,
      lines: freight.lines,
      billed: rupees(freight.billedPaise),
      linesWithoutShipment: freight.linesWithoutShipment,
      valueWithoutShipment: rupees(freight.valueWithoutShipmentPaise),
      carriers: freight.carriers,
    },
    "3_cod_to_bank": {
      state: cr?.state,
      matched: cr?.matched,
      eligible: cr?.eligible,
      blockedReason: cr?.blockedReason,
      deliveredCod: { count: cod.deliveredCount, value: rupees(cod.deliveredValue) },
      unknownStale: { count: cod.unknownCount, value: rupees(cod.unknownValue), oldestDays: cod.unknownOldestDays },
      inFlight: { count: cod.inFlightCount, value: rupees(cod.inFlightValue) },
      rto: { count: cod.rtoCount, value: rupees(cod.rtoValue) },
    },
    "4_settlement_to_bank": {
      state: sb?.state,
      matched: sb?.matched,
      eligible: sb?.eligible,
      blockedReason: sb?.blockedReason,
      settlementCount,
      bankTxnCount: bankCount,
      paymentCount,
      orderPaymentLeg: { state: op?.state, matched: op?.matched, eligible: op?.eligible },
      paymentSettlementLeg: { state: ps?.state, matched: ps?.matched, eligible: ps?.eligible },
    },
    "5_ad_spend": {
      google: { rows: googleSpend._count._all, spend: rupees(googleSpend._sum.spendAmount ?? 0n) },
      meta: { rows: metaSpend._count._all, spend: rupees(metaSpend._sum.spendAmount ?? 0n) },
    },
  };

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
