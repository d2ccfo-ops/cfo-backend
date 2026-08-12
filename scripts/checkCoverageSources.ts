import { getCostCoverage } from "../src/modules/calc/cogs.js";
import { prisma } from "../src/lib/prisma.js";

// P0.1e verification: the coverage payload now says WHOSE numbers these are —
// how many costed SKUs rest on a fabricated ESTIMATED placeholder.
async function main() {
  const c = await getCostCoverage("cmsirmi2f0000uusqp83kus59");
  console.log(
    JSON.stringify({
      costedSkuCount: c.costedSkuCount,
      estimatedSkuCount: c.estimatedSkuCount,
      lineCoveragePct: c.lineCoveragePct,
      valueCoveragePct: c.valueCoveragePct,
      uncostableLineCount: c.uncostableLineCount,
    })
  );
  if (c.costedSkuCount < c.estimatedSkuCount) throw new Error("estimated exceeds costed — impossible");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
