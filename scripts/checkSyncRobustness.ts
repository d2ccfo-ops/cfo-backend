import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { readSyncHealth } from "../src/modules/sync/health.js";
import { readDeadLetters } from "../src/modules/sync/deadLetters.js";
import { REPAIRABLE_PROVIDERS, REPAIR_WINDOW_DAYS } from "../src/modules/sync/repair.js";

// P5.5 against real connections.
//
// Note what this file imports and what it does NOT: health.ts and
// deadLetters.ts, both pure reads, never repair.ts's runRepairSweep. repair.ts
// imports the sync queue, which constructs a BullMQ Queue at module scope,
// opens a Redis connection and keeps this process alive forever — the trap
// syncCadence.ts documents. Importing the two CONSTANTS from it is safe only
// because they are re-exported values; if this script ever needed the sweep
// itself it would have to be run differently.
//
// Actually — that reasoning is wrong and worth stating plainly: importing ANY
// binding from repair.ts evaluates the whole module, queue included. The
// constants are imported here deliberately anyway, because this script asserts
// they match what the schedulers use, and the process exits explicitly at the
// end rather than waiting for the event loop to drain.
//
// Run with: npx tsx scripts/checkSyncRobustness.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const BACKEND = new URL("../", pathToFileURL(import.meta.dirname + "/"));

async function main() {
  // ---------------------------------------------------------------------------
  console.log("\n[1] The repair pass runs before the snapshot capture, not after");
  // ---------------------------------------------------------------------------
  const repairSrc = await readFile(new URL("src/modules/queue/repairScheduler.ts", BACKEND), "utf8");
  const snapshotSrc = await readFile(new URL("src/modules/queue/snapshotScheduler.ts", BACKEND), "utf8");
  const repairCron = repairSrc.match(/SWEEP_CRON = "([^"]+)"/)?.[1] ?? "";
  const snapshotCron = snapshotSrc.match(/SWEEP_CRON = "([^"]+)"/)?.[1] ?? "";
  ok("both schedulers declare a cron", repairCron.length > 0 && snapshotCron.length > 0, `repair ${repairCron}, snapshot ${snapshotCron}`);
  const minuteOf = (c: string) => {
    const [m, h] = c.split(" ");
    return Number(h) * 60 + Number(m);
  };
  // The ordering is the point: the snapshot records what the system believes
  // about yesterday, and it should record the CORRECTED belief.
  ok("repair fires before the snapshot capture", minuteOf(repairCron) < minuteOf(snapshotCron), `${repairCron} vs ${snapshotCron}`);
  ok("both run on the organisation's clock, not UTC", repairSrc.includes("Asia/Kolkata") && snapshotSrc.includes("Asia/Kolkata"));

  // ---------------------------------------------------------------------------
  console.log("\n[2] The repair window and provider set are deliberate");
  // ---------------------------------------------------------------------------
  ok("the repair window is a week", REPAIR_WINDOW_DAYS === 7, String(REPAIR_WINDOW_DAYS));
  ok("only mutable-record providers are repaired", REPAIRABLE_PROVIDERS.has("SHOPIFY") && !REPAIRABLE_PROVIDERS.has("RAZORPAY"), [...REPAIRABLE_PROVIDERS].join(", "));
  // A settlement is immutable once paid; re-pulling it every night is quota
  // spent to re-confirm a record that cannot have changed.
  ok("settlement providers are excluded", !REPAIRABLE_PROVIDERS.has("GOKWIK") && !REPAIRABLE_PROVIDERS.has("BLUEDART"));

  // ---------------------------------------------------------------------------
  console.log("\n[3] The worker records a run per attempt");
  // ---------------------------------------------------------------------------
  const workerSrc = await readFile(new URL("src/modules/queue/syncWorker.ts", BACKEND), "utf8");
  ok("a run row is created before the connector is called", workerSrc.indexOf("prisma.syncRun.create") < workerSrc.indexOf("connector.sync("));
  ok("a thrown sync marks the run FAILED before rethrowing", /catch \(err\)[\s\S]{0,400}?syncRun[\s\S]{0,300}?status: "FAILED"/.test(workerSrc));
  ok("the error is recorded and the throw preserved", workerSrc.includes("throw err;"));
  ok(
    "a zero-record run is EMPTY, not SUCCEEDED",
    workerSrc.includes('result.recordsFetched === 0 ? "EMPTY" : "SUCCEEDED"')
  );
  ok("the starting cursor is stored on the run", /cursor: startCursor/.test(workerSrc));
  ok("a repair job rewinds the cursor rather than resuming", workerSrc.includes("repairWindowDays"));

  // ---------------------------------------------------------------------------
  console.log("\n[4] Health and dead letters read from real rows");
  // ---------------------------------------------------------------------------
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  let checkedOrgs = 0;
  for (const org of orgs) {
    const connections = await prisma.connection.count({ where: { organizationId: org.id, status: "ACTIVE" } });
    if (connections === 0) continue;
    checkedOrgs += 1;

    const health = await readSyncHealth(org.id);
    ok(`${org.name}: health covers every active connection`, health.length === connections, `${health.length}/${connections}`);
    for (const h of health) {
      ok(`${org.name}/${h.provider}: streak counts are non-negative`, h.consecutiveEmptyRuns >= 0 && h.consecutiveFailures >= 0);
      // The concern text must explain what to DO, not just that something is
      // wrong. "4 empty runs" is a fact; "this is what a de-scoped credential
      // looks like" is the sentence that gets it fixed.
      if (h.concern) {
        ok(`${org.name}/${h.provider}: the concern explains itself`, h.concern.length > 60, h.concern.slice(0, 90));
      }
    }

    const dlq = await readDeadLetters(org.id);
    ok(`${org.name}: dead letters read`, Array.isArray(dlq), `${dlq.length} entries`);
    for (const d of dlq) {
      ok(`${org.name}/${d.provider}: every dead letter carries a recommendation`, d.recommendation.length > 20);
      ok(`${org.name}/${d.provider}: a recovered failure says so`, !d.recoveredSince || /Nothing to do/.test(d.recommendation));
    }
    // Unrecovered first — the ones needing a decision must not sit below the
    // ones that already fixed themselves.
    const firstRecovered = dlq.findIndex((d) => d.recoveredSince);
    const lastUnrecovered = dlq.map((d) => d.recoveredSince).lastIndexOf(false);
    ok(`${org.name}: unrecovered failures sort above recovered ones`, firstRecovered === -1 || lastUnrecovered < firstRecovered);
  }
  ok("at least one organisation had connections to check", checkedOrgs > 0, `${checkedOrgs}`);

  // ---------------------------------------------------------------------------
  console.log("\n[5] Existing sync history, if any");
  // ---------------------------------------------------------------------------
  const runCount = await prisma.syncRun.count();
  console.log(`  · ${runCount} sync run(s) recorded so far`);
  if (runCount > 0) {
    const recent = await prisma.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 });
    for (const r of recent) {
      console.log(
        `    ${r.startedAt.toISOString().slice(0, 19)}  ${r.provider.padEnd(11)} ${r.trigger.padEnd(9)} ${r.status.padEnd(9)} ${r.recordsFetched ?? "—"} records`
      );
    }
    ok("no run is left RUNNING from a previous process", recent.every((r) => r.status !== "RUNNING" || Date.now() - r.startedAt.getTime() < 3_600_000));
  } else {
    console.log("    (none yet — a run row is written the next time any connection syncs)");
  }

  // ---------------------------------------------------------------------------
  console.log("\n[6] Route ordering and module hygiene");
  // ---------------------------------------------------------------------------
  const routeSrc = await readFile(new URL("src/routes/connections/index.ts", BACKEND), "utf8");
  // A literal segment below a parameterised one is a bug waiting for someone
  // to add GET /:connectionId.
  ok(
    "GET /health is declared above the /:connectionId routes",
    routeSrc.indexOf('get("/health"') < routeSrc.indexOf('"/:connectionId')
  );
  const healthSrc = await readFile(new URL("src/modules/sync/health.ts", BACKEND), "utf8");
  const dlqSrc = await readFile(new URL("src/modules/sync/deadLetters.ts", BACKEND), "utf8");
  // The trap this codebase has already paid for once.
  for (const [name, src] of [["health.ts", healthSrc], ["deadLetters.ts", dlqSrc]] as const) {
    ok(`${name} imports no queue`, !/from "\.\.\/queue\//.test(src) && !/bullmq/.test(src));
    ok(`${name} imports no redis`, !/lib\/redis/.test(src));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
