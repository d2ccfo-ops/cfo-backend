import { zonedDayKey } from "../src/lib/dateRange.js";
import { prisma } from "../src/lib/prisma.js";
import { runAnomalyRules } from "../src/modules/calc/anomalies.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// P2.1 anomaly engine, against the DEMO org's real generated year of data —
// the pure decide*() functions are unit-tested in anomalies.test.ts; this
// checks what only a live Postgres round-trip can: that the gather queries
// run without error against real rows, that dedupeKey upserts rather than
// duplicates on a same-day re-run, and that a human's triage of an anomaly
// (status, owner) survives the nightly job refreshing its numbers.
//
// Deliberately does NOT delete what it creates: a real anomaly finding
// against the demo org's real data is desirable persistent state for that
// org (P2.1d's Exceptions page will read it), not scratch test debris — same
// posture as checkDemoRealism.ts reading demo data without mutating it away.
//
// Run with: npx tsx scripts/checkAnomalies.ts

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

async function main() {
  const org = await findDemoOrg();
  if (!org) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }

  console.log(`\n=== ${org.name} (${org.id}) ===`);

  console.log("\n[1] runAnomalyRules() runs clean against real generated data");
  const now = new Date();
  const before = await prisma.anomaly.count({ where: { organizationId: org.id } });
  const result1 = await runAnomalyRules(org.id, now);
  // periodEnd is the org-calendar day's END (23:59:59.999), same convention
  // as every other calc module's explicit range — so it is always slightly
  // AFTER "now" within today, not <=. What matters is it's TODAY, not that
  // it precedes the instant that requested it.
  ok(
    "period ends on today's org-calendar day",
    zonedDayKey(result1.periodEnd, org.timezone) === zonedDayKey(now, org.timezone),
    `periodEnd=${result1.periodEnd.toISOString()} now=${now.toISOString()}`
  );
  ok("periodStart precedes periodEnd", result1.periodStart.getTime() < result1.periodEnd.getTime());
  console.log(
    `  fired: ${result1.candidates.map((c) => c.type).join(", ") || "(none)"}\n  created=${result1.created} updated=${result1.updated}`
  );
  const afterFirst = await prisma.anomaly.count({ where: { organizationId: org.id } });
  ok("row count grew by exactly `created`", afterFirst === before + result1.created, `${before} -> ${afterFirst}, created=${result1.created}`);

  console.log("\n[2] running again for the same instant is an upsert, not a duplicate");
  const result2 = await runAnomalyRules(org.id, now);
  ok("nothing NEW created on an identical re-run", result2.created === 0, `created=${result2.created}`);
  ok("the same candidates were re-evaluated (updated, not skipped)", result2.updated === result1.candidates.length, `updated=${result2.updated} candidates=${result1.candidates.length}`);
  const afterSecond = await prisma.anomaly.count({ where: { organizationId: org.id } });
  ok("row count unchanged by the re-run", afterSecond === afterFirst, `${afterFirst} -> ${afterSecond}`);

  console.log("\n[3] every dedupeKey is actually unique per (type, org, day)");
  const rows = await prisma.anomaly.findMany({ where: { organizationId: org.id }, select: { dedupeKey: true } });
  ok("no duplicate dedupeKeys", new Set(rows.map((r) => r.dedupeKey)).size === rows.length, `${rows.length} rows`);

  if (result1.candidates.length > 0) {
    console.log("\n[4] a human's triage survives the nightly job re-running");
    const targetType = result1.candidates[0]!.type;
    const target = await prisma.anomaly.findFirst({ where: { organizationId: org.id, type: targetType } });
    if (target) {
      await prisma.anomaly.update({ where: { id: target.id }, data: { status: "ACKNOWLEDGED", ownerId: "check-script-owner" } });
      await runAnomalyRules(org.id, now);
      const after = await prisma.anomaly.findUnique({ where: { id: target.id } });
      ok("status was NOT reset to OPEN by the re-run", after?.status === "ACKNOWLEDGED", `status=${after?.status}`);
      ok("owner assignment was NOT cleared by the re-run", after?.ownerId === "check-script-owner", `ownerId=${after?.ownerId}`);
      ok("the finding's numbers still refreshed (updatedAt moved)", (after?.updatedAt.getTime() ?? 0) > target.updatedAt.getTime());
    } else {
      ok("target anomaly still findable after the run that created it", false, "row vanished between run and lookup");
    }
  } else {
    console.log("\n[4] skipped — no anomalies fired against the demo org's current data to test triage-survival against");
  }

  console.log("\n[5] a later day produces a fresh row, not an overwrite of today's");
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  // ID-diff rather than a reconstructed dedupeKey/createdAt filter: today's
  // rows from steps [1]/[2]/[4] were ALSO created "just now", so any filter
  // keyed on createdAt alone would delete them too. Snapshotting exact ids
  // before this step and only ever touching ids absent from that snapshot
  // cannot accidentally reach into a-earlier step's rows.
  const idsBeforeTomorrow = new Set((await prisma.anomaly.findMany({ where: { organizationId: org.id }, select: { id: true } })).map((r) => r.id));
  const result3 = await runAnomalyRules(org.id, tomorrow);
  const rowsAfterTomorrow = await prisma.anomaly.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const newIds = rowsAfterTomorrow.map((r) => r.id).filter((id) => !idsBeforeTomorrow.has(id));
  ok(
    "a new day's run adds rows rather than colliding with today's dedupeKeys",
    newIds.length === result3.created,
    `new rows=${newIds.length}, created=${result3.created}`
  );
  // Cleanup: only the synthetic "run as of tomorrow" rows, which don't
  // correspond to any real calendar day — everything from run [1]/[2]/[4]
  // stays, per this script's header note.
  if (newIds.length > 0) {
    await prisma.anomaly.deleteMany({ where: { id: { in: newIds } } });
  }

  console.log("\n" + "─".repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f}`));
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
