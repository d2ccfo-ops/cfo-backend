// Read-only probe: prints the data-status map for the real org so the ladder
// can be eyeballed against known ground truth (741 estimated SKUs → margins
// MUST read "estimated"; ~3% payment match → revenue MUST read "provisional").
import { getDataStatusMap } from "../src/modules/calc/dataStatus.js";
import { prisma } from "../src/lib/prisma.js";

const ORG_ID = process.argv[2] ?? "cmsirmi2f0000uusqp83kus59";

async function main() {
  const map = await getDataStatusMap(ORG_ID);
  for (const [key, s] of Object.entries(map)) {
    console.log(`${key}: ${s.status.toUpperCase()}`);
    for (const r of s.reasons) console.log(`  - ${r}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
