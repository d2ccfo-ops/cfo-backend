import { prisma } from "../src/lib/prisma.js";
import { stampCogs } from "../src/modules/calc/cogs.js";

// PLACEHOLDER product costs, so contribution margin can be SEEN before real
// costs are entered. Every row is marked source=ESTIMATED — the lowest
// confidence tier — and priced at a random 30–50% of the SKU's OWN average
// selling price, which lands gross margin in a believable 50–70% band rather
// than the 85–95% a flat 5–15% would have invented.
//
// This is fabricated data on a real org, done at the user's explicit request
// and against the usual "no invented numbers in a real org" rule — so it is
// (a) tagged ESTIMATED and (b) removed in one command:
//
//   npx tsx scripts/seedEstimatedCosts.ts           # seed
//   npx tsx scripts/seedEstimatedCosts.ts --wipe     # remove every ESTIMATED cost + re-stamp
//
// The moment a real cost file is uploaded (source CSV_IMPORT/MANUAL), those
// rows win on their own effectiveFrom and these placeholders should be wiped.

const ORG = "cmsirmi2f0000uusqp83kus59"; // Hrtiik pvt ltd
const EPOCH = new Date("1970-01-01T00:00:00.000Z");
const MIN_PCT = 0.3;
const MAX_PCT = 0.5;

async function wipe() {
  const del = await prisma.productCost.deleteMany({ where: { organizationId: ORG, source: "ESTIMATED" } });
  console.log(`removed ${del.count} ESTIMATED cost rows`);
  // Re-stamp so order lines drop the estimated COGS they were carrying.
  const stamp = await stampCogs(ORG);
  console.log(`re-stamped: ${JSON.stringify(stamp)}`);
  await prisma.$disconnect();
}

async function seed() {
  // Average selling price per SKU, from real order lines. unitPrice is paise.
  const rows = await prisma.$queryRawUnsafe<Array<{ sku: string; avg_price: number }>>(
    `SELECT li.sku, avg(li."unitPrice")::float AS avg_price
     FROM order_line_items li JOIN orders o ON o.id = li."orderId"
     WHERE o."organizationId" = $1 AND li.sku IS NOT NULL AND li.sku <> ''
     GROUP BY li.sku`,
    ORG
  );
  console.log(`${rows.length} distinct SKUs to estimate`);

  // SKUs that already carry a REAL cost (anything but ESTIMATED) are left
  // untouched — a placeholder must never overwrite a number the user entered.
  const realCosted = new Set(
    (
      await prisma.productCost.findMany({
        where: { organizationId: ORG, source: { not: "ESTIMATED" } },
        select: { sku: true },
      })
    ).map((c) => c.sku)
  );

  let seeded = 0;
  let skippedReal = 0;
  for (const r of rows) {
    if (realCosted.has(r.sku)) {
      skippedReal += 1;
      continue;
    }
    const avgPricePaise = Math.round(r.avg_price);
    if (avgPricePaise <= 0) continue;
    // A price with no cost is meaningless; a 0-price line (free gift) gets no
    // estimate rather than a ₹0 cost that would read as 100% margin.
    const pct = MIN_PCT + Math.random() * (MAX_PCT - MIN_PCT);
    const purchaseCost = BigInt(Math.round(avgPricePaise * pct));
    await prisma.productCost.upsert({
      where: { organizationId_sku_effectiveFrom: { organizationId: ORG, sku: r.sku, effectiveFrom: EPOCH } },
      create: {
        organizationId: ORG,
        sku: r.sku,
        effectiveFrom: EPOCH,
        purchaseCost,
        landedCost: purchaseCost,
        source: "ESTIMATED",
        note: `placeholder ${Math.round(pct * 100)}% of avg price — replace with real cost`,
      },
      update: {
        // Only overwrite an existing ESTIMATED row; never clobber a real cost.
        // (A real CSV_IMPORT/MANUAL row on the same effectiveFrom is left as-is
        //  by skipping when the existing source is not ESTIMATED.)
        purchaseCost,
        landedCost: purchaseCost,
        source: "ESTIMATED",
        note: `placeholder ${Math.round(pct * 100)}% of avg price — replace with real cost`,
      },
    });
    seeded += 1;
  }
  console.log(`seeded ${seeded} ESTIMATED costs (30–50% of each SKU's avg price)${skippedReal ? `, skipped ${skippedReal} already-real-costed SKUs` : ""}`);

  const stamp = await stampCogs(ORG);
  console.log(`re-stamped order lines: ${JSON.stringify(stamp)}`);
  await prisma.$disconnect();
}

const run = process.argv.includes("--wipe") ? wipe : seed;
run().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
