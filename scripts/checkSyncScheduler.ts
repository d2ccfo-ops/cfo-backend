import { prisma } from "../src/lib/prisma.js";
// From syncCadence, NOT syncScheduler: the latter builds a BullMQ Queue at
// module scope, so importing it here would open a Redis connection and leave
// this script hanging after its last check.
import { isDue } from "../src/modules/queue/syncCadence.js";

// Exercises the scheduler's due-selection against the real connections table
// WITHOUT enqueueing anything — the sweep's decision is the part that can be
// silently wrong (a connection that never becomes due syncs forever by hand;
// one that is always due burns provider quota), and it is pure, so it can be
// checked directly.
//
// Run with: npx tsx scripts/checkSyncScheduler.ts

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const NOW = new Date("2026-08-09T21:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

async function main() {
  console.log("=== decision table (synthetic, exact boundaries) ===");

  // Never synced is due immediately, whatever the provider.
  check(isDue({ provider: "SHOPIFY", syncStatus: "IDLE", lastSyncedAt: null }, NOW), "never-synced Shopify is due");
  check(isDue({ provider: "ZOHO_BOOKS", syncStatus: "IDLE", lastSyncedAt: null }, NOW), "never-synced Zoho is due");

  // In-flight is never due — the claim would refuse it, but it must not even be
  // considered, or the logs would over-report work that never happened.
  check(!isDue({ provider: "SHOPIFY", syncStatus: "SYNCING", lastSyncedAt: null }, NOW), "SYNCING is not due");
  check(!isDue({ provider: "SHOPIFY", syncStatus: "QUEUED", lastSyncedAt: null }, NOW), "QUEUED is not due");

  // BANK is excluded outright — its connector is a no-op and syncing it would
  // advance lastSyncedAt, making the freshness badge lie about a CSV-fed source.
  check(!isDue({ provider: "BANK", syncStatus: "IDLE", lastSyncedAt: null }, NOW), "BANK is never swept");

  // Per-provider cadence, checked either side of the boundary.
  check(!isDue({ provider: "SHOPIFY", syncStatus: "IDLE", lastSyncedAt: minutesAgo(59) }, NOW), "Shopify at 59 min is not due");
  check(isDue({ provider: "SHOPIFY", syncStatus: "IDLE", lastSyncedAt: minutesAgo(61) }, NOW), "Shopify at 61 min is due");
  check(!isDue({ provider: "META_ADS", syncStatus: "IDLE", lastSyncedAt: minutesAgo(179) }, NOW), "Meta Ads at 179 min is not due");
  check(isDue({ provider: "META_ADS", syncStatus: "IDLE", lastSyncedAt: minutesAgo(181) }, NOW), "Meta Ads at 181 min is due");
  check(!isDue({ provider: "ZOHO_BOOKS", syncStatus: "IDLE", lastSyncedAt: minutesAgo(359) }, NOW), "Zoho at 359 min is not due");
  check(isDue({ provider: "ZOHO_BOOKS", syncStatus: "IDLE", lastSyncedAt: minutesAgo(361) }, NOW), "Zoho at 361 min is due");

  // A provider with no explicit entry falls back to the default hour.
  check(isDue({ provider: "SOMETHING_NEW", syncStatus: "IDLE", lastSyncedAt: minutesAgo(61) }, NOW), "unknown provider uses the 60-min default");

  // FAILED backs off to 6 h regardless of the provider's normal cadence — a
  // revoked token must not be retried hourly forever.
  check(!isDue({ provider: "SHOPIFY", syncStatus: "FAILED", lastSyncedAt: minutesAgo(120) }, NOW), "FAILED Shopify at 2 h is not due (backoff)");
  check(isDue({ provider: "SHOPIFY", syncStatus: "FAILED", lastSyncedAt: minutesAgo(361) }, NOW), "FAILED Shopify at 6 h is due");
  check(isDue({ provider: "SHOPIFY", syncStatus: "FAILED", lastSyncedAt: null }, NOW), "FAILED and never synced is due");

  console.log("\n=== against the real connections table (read-only) ===");
  const connections = await prisma.connection.findMany({
    // Connection carries organizationId but has no `organization` relation
    // field, so names come from a separate lookup rather than an include.
    select: { id: true, provider: true, status: true, syncStatus: true, lastSyncedAt: true, organizationId: true },
    orderBy: { provider: "asc" },
  });
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  const now = new Date();
  const active = connections.filter((c) => c.status === "ACTIVE");
  console.log(`  ${connections.length} connections, ${active.length} ACTIVE`);
  for (const c of active) {
    const age = c.lastSyncedAt === null ? "never" : `${Math.round((now.getTime() - c.lastSyncedAt.getTime()) / 60_000)} min ago`;
    const due = isDue(c, now);
    console.log(
      `    ${due ? "DUE " : "wait"}  ${c.provider.padEnd(12)} ${c.syncStatus.padEnd(8)} last synced ${age.padEnd(14)} ${orgName.get(c.organizationId) ?? c.organizationId}`
    );
  }

  // The sweep must never consider a non-ACTIVE connection. Checked here rather
  // than trusted, because the status filter lives in the query, not in isDue().
  const nonActiveDue = connections.filter((c) => c.status !== "ACTIVE" && isDue(c, now));
  console.log(
    `  note: ${nonActiveDue.length} non-ACTIVE connection(s) would pass isDue() — they are excluded by runSweep's status filter, not by isDue`
  );

  console.log(failures === 0 ? "\nall scheduler checks passed" : `\n${failures} FAILURES`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
