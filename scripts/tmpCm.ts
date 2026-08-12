import { getContributionMargin } from "../src/modules/calc/contribution.js";
import { resolveDateRange } from "../src/lib/dateRange.js";
import { prisma } from "../src/lib/prisma.js";
const ORGS = [["DEMO", "cmsjubzbw0006uuvbgptdx8cz"], ["REAL", "cmsirmi2f0000uusqp83kus59"]] as const;
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
async function main() {
  for (const [label, id] of ORGS) {
    const range = resolveDateRange({ from: "2026-01-01", to: "2026-08-12" });
    const cm = await getContributionMargin(id, range);
    console.log(`\n===== ${label}  status=${cm.status} completeness=${cm.dataCompleteness}`);
    console.log(`net revenue: ${inr(cm.netRevenue.value)}`);
    for (const l of cm.layers) {
      const mark = l.memo ? "memo" : l.covered ? " ok " : l.hasSource ? "part" : "GAP ";
      console.log(`  [${mark}] ${l.label.padEnd(22)} ${inr(l.amount).padStart(16)}   ${l.note.slice(0, 78)}`);
    }
    for (const [k, v] of Object.entries(cm.levels)) {
      console.log(`  ${k}: ${inr(v.value).padStart(16)}  ${String(v.marginPct).padStart(6)}%  reliable=${v.reliable}`);
    }
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
