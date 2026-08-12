// P0.2d — the status-flip test, in an ISOLATED test org (§ plan rule: never
// touch real-data orgs). Two halves:
//
//   1. Pure: buildDataStatusMap() must move margin estimated → provisional →
//      reconciled exactly as its inputs say, and must NEVER mark estimated
//      inputs reconciled (§42.8).
//   2. Live: in a scratch org, a SKU costed ESTIMATED makes the DB-derived
//      status "estimated"; upserting a REAL cost row for that SKU (later
//      effectiveFrom, source MANUAL) flips it off "estimated" with no other
//      change. This proves the DISTINCT ON latest-row logic actually flips.
//
// The scratch org is created and deleted inside this run. It never receives
// demo data and its name is unambiguous about what it is.
import { getDataStatusMap, buildDataStatusMap } from "../src/modules/calc/dataStatus.js";
import { prisma } from "../src/lib/prisma.js";

let failures = 0;
function expect(cond: boolean, label: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
}

const baseInputs = {
  costedSkuCount: 10,
  estimatedSkuCount: 0,
  costedValuePct: 100,
  orderPaymentMatchedPct: 99,
  orderPaymentBlockedReason: null,
  settlementBankMatchedPct: 99,
  settlementBankBlockedReason: null,
  bankCreditCount: 5,
  staleSourceCount: 0,
  totalSourceCount: 3,
};

function pureChecks() {
  // One estimated SKU poisons the margin, §42.8.
  const withEstimate = buildDataStatusMap({ ...baseInputs, estimatedSkuCount: 1 });
  expect(withEstimate.contribution_margin.status === "estimated", "1 estimated SKU → margin estimated");
  expect(withEstimate.product_profitability.status === "estimated", "1 estimated SKU → per-SKU estimated");
  expect(withEstimate.revenue.status === "reconciled", "estimated costs don't drag revenue (separate substrate)");

  const clean = buildDataStatusMap(baseInputs);
  expect(clean.contribution_margin.status === "reconciled", "real costs + reconciled revenue → margin reconciled");
  expect(clean.cash_received.status === "reconciled", "bank-verified settlements → cash reconciled");
  expect(clean.cash_forecast.status === "estimated", "forecast is ALWAYS estimated");

  const partial = buildDataStatusMap({ ...baseInputs, orderPaymentMatchedPct: 87.1 });
  expect(partial.revenue.status === "provisional", "87.1% matched → revenue provisional, not reconciled");
  expect(partial.contribution_margin.status === "provisional", "margin can't outrank its revenue");

  const stale = buildDataStatusMap({ ...baseInputs, staleSourceCount: 2 });
  expect(stale.revenue.status === "provisional", "stale pipeline caps reconciled → provisional");
  expect(stale.revenue.reasons.some((r) => r.includes("have not synced")), "staleness is named in reasons");

  const uncosted = buildDataStatusMap({ ...baseInputs, costedSkuCount: 0 });
  expect(uncosted.contribution_margin.status === "estimated", "no costs at all → margin estimated");

  const noBank = buildDataStatusMap({ ...baseInputs, bankCreditCount: 0 });
  expect(noBank.cash_received.status === "provisional", "no bank statement → cash provisional");
}

async function liveFlip() {
  const org = await prisma.organization.create({
    data: { name: "TEST dataStatus flip (auto-deleted)", clerkOrgId: `test_datastatus_${process.pid}` },
  });
  try {
    const seeded = await prisma.productCost.create({
      data: {
        organizationId: org.id,
        sku: "FLIP-TEST-SKU",
        effectiveFrom: new Date("2026-01-01"),
        purchaseCost: 10000n,
        landedCost: 10000n,
        source: "ESTIMATED",
      },
    });
    const before = await getDataStatusMap(org.id);
    expect(before.contribution_margin.status === "estimated", "live: ESTIMATED cost row → margin estimated");
    expect(
      before.contribution_margin.reasons.some((r) => r.includes("placeholder")),
      "live: reason names the placeholder costs"
    );

    // The real cost lands LATER, so DISTINCT ON (sku) ... ORDER BY
    // effectiveFrom DESC must pick it up and drop the estimate from the count.
    await prisma.productCost.create({
      data: {
        organizationId: org.id,
        sku: "FLIP-TEST-SKU",
        effectiveFrom: new Date("2026-02-01"),
        purchaseCost: 12000n,
        landedCost: 12000n,
        source: "MANUAL",
      },
    });
    const after = await getDataStatusMap(org.id);
    expect(after.contribution_margin.status !== "estimated", "live: real cost upsert flips margin off estimated");

    // Regression guard on the ordering: an EARLIER real row must NOT flip it —
    // the latest row is still the estimate.
    await prisma.productCost.deleteMany({ where: { organizationId: org.id, source: "MANUAL" } });
    await prisma.productCost.create({
      data: {
        organizationId: org.id,
        sku: "FLIP-TEST-SKU",
        effectiveFrom: new Date("2025-12-01"),
        purchaseCost: 9000n,
        landedCost: 9000n,
        source: "MANUAL",
      },
    });
    const earlier = await getDataStatusMap(org.id);
    expect(earlier.contribution_margin.status === "estimated", "live: older real row doesn't outrank newer estimate");
    void seeded;
  } finally {
    await prisma.productCost.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }
}

async function main() {
  pureChecks();
  await liveFlip();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
