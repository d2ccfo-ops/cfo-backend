import { prisma } from "../src/lib/prisma.js";
import {
  DAILY_SNAPSHOT_METRICS,
  captureDailySnapshot,
  isReconstructable,
} from "../src/modules/calc/dailySnapshot.js";

// Rebuild the nightly snapshot history for days the capture job did not run.
//
// WHY THIS IS NOT FABRICATION, WHICH IS THE ONLY QUESTION THAT MATTERS HERE.
// The sweep deliberately reports gaps rather than filling them, and its own
// comment says why: the position metrics marked asOfCaptureTime read
// CURRENT-state tables — inventory on hand, outstanding payables, COD parcels
// in flight — which hold no history, so a backfill would "write today's
// inventory and payables under a date they were never true of".
//
// That reasoning is exactly right, and it applies to five of the nineteen
// metrics. The other fourteen — every flow, every rate, and available_cash —
// are derived from DATED rows: orders placed that day, payments received that
// day, bank credits and debits with their own value dates. Recomputing those
// for a past day reads the same records the nightly job would have read had it
// been running. That is a measurement taken late, not a number invented.
//
// So this script fills only the half that can be filled. isReconstructable()
// in dailySnapshot.ts is the predicate, and captureDailySnapshot's
// onlyReconstructable option is what enforces it — the filtering does not live
// here, so it cannot drift from the specs it is filtering.
//
// WHY THE HISTORY WAS MISSING. The nightly sweep lives in the worker process,
// and the worker only runs when someone runs it. On a laptop that is most
// nights. In production the worker pool runs continuously and this script
// should never be needed twice.
//
//   npx tsx scripts/backfillDailySnapshots.ts --days 30
//   npx tsx scripts/backfillDailySnapshots.ts --days 30 --dry-run
//   npx tsx scripts/backfillDailySnapshots.ts --org "DEMO — Hrtiik pvt ltd"
//   npx tsx scripts/backfillDailySnapshots.ts --all

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

const DAYS = Number(arg("days") ?? 30);
const DRY = has("dry-run");
const ALL = has("all");
const ORG_NAME = arg("org");

async function main() {
  if (!Number.isFinite(DAYS) || DAYS < 1 || DAYS > 365) {
    throw new Error("--days must be between 1 and 365");
  }

  const reconstructable = DAILY_SNAPSHOT_METRICS.filter(isReconstructable);
  const skipped = DAILY_SNAPSHOT_METRICS.filter((s) => !isReconstructable(s));
  console.log(`Will recompute ${reconstructable.length} metrics; skipping ${skipped.length} that read current state:`);
  console.log(`   skipped: ${skipped.map((s) => s.key).join(", ")}\n`);

  const orgs = ALL
    ? await prisma.organization.findMany({ select: { id: true, name: true } })
    : await prisma.organization.findMany({
        where: { name: ORG_NAME ?? "DEMO — Hrtiik pvt ltd" },
        select: { id: true, name: true },
      });
  if (orgs.length === 0) throw new Error(`No organisation matched ${JSON.stringify(ORG_NAME)}. Use --all to sweep every org.`);

  for (const org of orgs) {
    console.log(`${org.name}`);
    const before = await countRows(org.id);

    let wrote = 0;
    // Oldest first, purely so the log reads as a timeline.
    for (let back = DAYS; back >= 1; back--) {
      // captureDailySnapshot captures the last COMPLETE day before the instant
      // it is handed, so to fill day D it is given the start of D+1.
      const asOf = new Date();
      asOf.setUTCHours(12, 0, 0, 0);
      asOf.setUTCDate(asOf.getUTCDate() - (back - 1));

      if (DRY) {
        console.log(`   ${asOf.toISOString().slice(0, 10)}  (dry run — nothing written)`);
        continue;
      }
      try {
        const res = await captureDailySnapshot(org.id, asOf, { onlyReconstructable: true });
        wrote += res.written;
        const omittedNote = res.omitted.length > 0 ? `  omitted ${res.omitted.length}` : "";
        console.log(`   ${res.day}  wrote ${String(res.written).padStart(2)}${omittedNote}`);
      } catch (err) {
        console.log(`   ${asOf.toISOString().slice(0, 10)}  FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!DRY) {
      const after = await countRows(org.id);
      console.log(`\n   rows: ${before} -> ${after}  (+${after - before}), ${wrote} written or refreshed`);
      // The three the overview hero draws from, because a backfill that ran
      // without moving these has not achieved what it was run for.
      for (const key of ["available_cash", "net_revenue_day", "cm3_pct_28d"]) {
        const n = await prisma.metricSnapshot.count({
          where: { organizationId: org.id, metricKey: key, OR: [{ valueMinor: { not: null } }, { valueNumeric: { not: null } }] },
        });
        console.log(`   ${key.padEnd(18)} ${String(n).padStart(2)} measured nights   ${n >= 4 ? "hero sparkline draws" : "still below the 4-point minimum"}`);
      }
    }
    console.log();
  }
}

function countRows(organizationId: string) {
  return prisma.metricSnapshot.count({ where: { organizationId, granularity: "DAILY" } });
}

main()
  .catch((err) => {
    console.error("FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
