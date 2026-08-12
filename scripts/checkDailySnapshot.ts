import { readFile } from "node:fs/promises";
import { addZonedDays, resolveDateRange, startOfZonedDay, zonedDayKey } from "../src/lib/dateRange.js";
import { prisma } from "../src/lib/prisma.js";
import { getAvailableCashSummary } from "../src/modules/calc/cash.js";
import {
  DAILY_SNAPSHOT_METRICS,
  DAILY_SNAPSHOT_VERSION,
  captureDailySnapshot,
  getDailySnapshotDiff,
  getSnapshotHistory,
  lastCompleteDay,
  runDailySnapshotSweep,
} from "../src/modules/calc/dailySnapshot.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// P2.2d against the DEMO org's real generated year. The gating rules and the
// day arithmetic are unit-tested in dailySnapshot.test.ts over a hand-built
// fixture; this checks what only shows up against a database — that rows land
// on the right day, that a later run cannot rewrite an earlier one, that the
// reads see this module's rows and not the six opportunistic writers', that a
// captured position figure is the day's figure rather than today's, and that a
// day the connectors never observed records nothing at all.
//
// Run with: npx tsx scripts/checkDailySnapshot.ts

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

const rupees = (p: string | bigint | null) =>
  p === null ? "—" : "₹" + (Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });

const DAY_MS = 86_400_000;

async function rowsFor(organizationId: string, day: string, timeZone: string) {
  return prisma.metricSnapshot.findMany({
    where: {
      organizationId,
      granularity: "DAILY",
      formulaVersion: DAILY_SNAPSHOT_VERSION,
      periodStart: startOfZonedDay(day, timeZone),
    },
    orderBy: { metricKey: "asc" },
    select: { metricKey: true, valueMinor: true, valueNumeric: true, confidence: true, computedAt: true, periodEnd: true },
  });
}

async function main() {
  const org = await findDemoOrg();
  if (!org) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }
  console.log(`\n=== ${org.name} (${org.timezone}) ===`);

  // The demo seed's connectors stopped syncing when the seed was generated, so
  // "yesterday" is a day none of them observed and the capture correctly
  // records nothing for it (proved in [12]). Everything else here needs a day
  // the sources DID cover, derived from the connections rather than hard-coded
  // so a regenerated seed doesn't silently invalidate the check.
  const active = await prisma.connection.findMany({
    where: { organizationId: org.id, status: "ACTIVE" },
    select: { provider: true, lastSyncedAt: true },
  });
  const oldestSync = active
    .map((c) => c.lastSyncedAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (!oldestSync) {
    console.log("demo org has no synced connections — nothing to capture");
    process.exit(1);
  }
  // The last day that closed before the earliest feed stopped.
  const observedDay = addZonedDays(zonedDayKey(oldestSync, org.timezone), -1);
  // Any instant on the following day: captureDailySnapshot derives its target
  // from the clock, which is exactly the property [4] relies on.
  const observedNow = new Date(startOfZonedDay(addZonedDays(observedDay, 1), org.timezone).getTime() + 12 * 3600_000);
  console.log(`oldest active sync ${oldestSync.toISOString()} → last fully observed day ${observedDay}`);

  console.log("\n[1] the capture lands on yesterday, on the org's own calendar");
  const capture = await captureDailySnapshot(org.id, observedNow);
  ok("targets the last complete day", capture.day === lastCompleteDay(observedNow, org.timezone), capture.day);
  ok("which is the day we expected to be observed", capture.day === observedDay, `${capture.day} vs ${observedDay}`);
  ok("never targets today", capture.day !== zonedDayKey(observedNow, org.timezone));
  ok("uses the org's timezone", capture.timeZone === org.timezone, capture.timeZone);
  ok("wrote at least one row", capture.written > 0, `${capture.written} rows`);
  for (const r of capture.rows) {
    console.log(`     ${r.metricKey.padEnd(24)} ${r.valueMinor !== null ? rupees(r.valueMinor) : String(r.valueNumeric)}  [${r.confidence}]`);
  }
  for (const o of capture.omitted) console.log(`     — ${o.metricKey}: ${o.reason}`);

  console.log("\n[2] the stored rows are keyed to that day and nothing else");
  const stored = await rowsFor(org.id, capture.day, org.timezone);
  ok("one row per captured metric", stored.length === capture.written, `${stored.length} stored vs ${capture.written} reported`);
  const catalogued = new Set(DAILY_SNAPSHOT_METRICS.map((m) => m.key));
  ok("every stored key is in the catalogue", stored.every((r) => catalogued.has(r.metricKey)));
  const dayEnd = startOfZonedDay(addZonedDays(capture.day, 1), org.timezone).getTime() - 1;
  ok("periodEnd is the last millisecond of that day", stored.every((r) => r.periodEnd.getTime() === dayEnd));
  // §42.8 — nothing here has been matched against a statement.
  ok("no row claims RECONCILED or FINAL", stored.every((r) => r.confidence === "ESTIMATED" || r.confidence === "PROVISIONAL"));
  ok("no row has both value columns empty", stored.every((r) => r.valueMinor !== null || r.valueNumeric !== null));
  ok(
    "every metric is either recorded or explained, never dropped",
    capture.rows.length + capture.omitted.length === DAILY_SNAPSHOT_METRICS.length,
    `${capture.rows.length} + ${capture.omitted.length} vs ${DAILY_SNAPSHOT_METRICS.length}`
  );
  ok("every omission carries a reason", capture.omitted.every((o) => o.reason.length > 0));

  console.log("\n[3] re-running on the same day refreshes, it does not duplicate");
  const again = await captureDailySnapshot(org.id, observedNow);
  const stored2 = await rowsFor(org.id, capture.day, org.timezone);
  ok("same row count", stored2.length === stored.length, `${stored2.length} vs ${stored.length}`);
  ok("same day targeted", again.day === capture.day);
  ok(
    "values unchanged",
    JSON.stringify(stored2.map((r) => [r.metricKey, r.valueMinor?.toString() ?? null, r.valueNumeric])) ===
      JSON.stringify(stored.map((r) => [r.metricKey, r.valueMinor?.toString() ?? null, r.valueNumeric]))
  );

  console.log("\n[4] a run two days later cannot reach back and rewrite this day");
  // The invariant the whole module is built around. captureDailySnapshot takes
  // no day parameter — the target is derived from `now` — so no expression can
  // touch a closed day. This proves it rather than trusting the reading.
  const before = await rowsFor(org.id, capture.day, org.timezone);
  const twoDaysOn = new Date(observedNow.getTime() + 2 * DAY_MS);
  const later = await captureDailySnapshot(org.id, twoDaysOn);
  ok("the later run targets a later day", later.day === lastCompleteDay(twoDaysOn, org.timezone), later.day);
  ok("which is not the day we captured first", later.day !== capture.day);
  const after = await rowsFor(org.id, capture.day, org.timezone);
  ok("the original day still has the same rows", after.length === before.length);
  ok(
    "with identical values AND identical computedAt",
    JSON.stringify(after.map((r) => [r.metricKey, r.valueMinor?.toString() ?? null, r.valueNumeric, r.computedAt.toISOString()])) ===
      JSON.stringify(before.map((r) => [r.metricKey, r.valueMinor?.toString() ?? null, r.valueNumeric, r.computedAt.toISOString()]))
  );
  // Tidy up anything dated after the day under test: it is an artefact of this
  // check, and leaving it would make every later diff compare against it.
  await prisma.metricSnapshot.deleteMany({
    where: {
      organizationId: org.id,
      granularity: "DAILY",
      formulaVersion: DAILY_SNAPSHOT_VERSION,
      periodStart: { gt: startOfZonedDay(capture.day, org.timezone) },
    },
  });

  console.log("\n[5] a captured balance is that day's balance, not today's");
  // The failure this catches is a position metric quietly reading "as of now"
  // and being stamped with an earlier date — which would make every overnight
  // diff read zero, because both rows would hold the same current figure.
  const dayRange = resolveDateRange({ from: capture.day, to: capture.day }, observedNow, org.timezone);
  const cashThatDay = await getAvailableCashSummary(org.id, dayRange);
  const storedCash = stored.find((r) => r.metricKey === "available_cash");
  if (storedCash) {
    ok(
      "available_cash matches a fresh as-of-that-day computation",
      storedCash.valueMinor?.toString() === cashThatDay.valueMinor,
      `${rupees(storedCash.valueMinor)} vs ${rupees(cashThatDay.valueMinor)}`
    );
    // Proving it is genuinely as-of-that-day and not "as of now" restamped
    // cannot be done by comparing against today: on this data no money has
    // moved since, so the two figures are legitimately equal. What DOES prove
    // it is that the same call for the day before returns something different —
    // the range parameter has to actually change the answer.
    const cashDayBefore = await getAvailableCashSummary(
      org.id,
      resolveDateRange({ from: addZonedDays(capture.day, -1), to: addZonedDays(capture.day, -1) }, observedNow, org.timezone)
    );
    ok(
      "and moves when the as-of day moves, so it is not a fixed current reading",
      storedCash.valueMinor?.toString() !== cashDayBefore.valueMinor,
      `${capture.day}: ${rupees(storedCash.valueMinor)} vs ${addZonedDays(capture.day, -1)}: ${rupees(cashDayBefore.valueMinor)}`
    );
  } else {
    ok("available_cash was omitted, so there is nothing to compare", true);
  }

  console.log("\n[6] the diff reports a real move, and never invents one");
  // The previous day is created by running the capture with the clock wound
  // back. The flow metrics that produces are genuine — they are range-scoped to
  // that day — while the position metrics are today's readings under an earlier
  // date, which is exactly the distortion the sweep refuses to perform in
  // production and reports as a gap instead.
  const previousDay = addZonedDays(capture.day, -1);
  await captureDailySnapshot(org.id, new Date(observedNow.getTime() - DAY_MS));
  const priorRows = await rowsFor(org.id, previousDay, org.timezone);
  ok("a previous day now exists", priorRows.length > 0, `${priorRows.length} rows on ${previousDay}`);

  const diff = await getDailySnapshotDiff(org.id, observedNow);
  ok("the diff's latest day is the captured day", diff.day === capture.day, String(diff.day));
  ok("it covers every metric that has a row", diff.metrics.length === stored.length, `${diff.metrics.length} vs ${stored.length}`);
  ok("every comparison is against the adjacent day", diff.metrics.every((m) => m.previous === null || m.previousIsAdjacent));

  let moved = 0;
  for (const m of diff.metrics) {
    if (m.previous === null) {
      // The rule that matters most: no previous row means no delta. A zero here
      // would read as "nothing changed overnight" for a metric nobody measured
      // overnight.
      ok(`${m.metric.key}: no history yet, so no delta is claimed`, m.deltaMinor === null && m.deltaNumeric === null && m.direction === null);
      continue;
    }
    if (m.metric.unit === "paise") {
      const expected = (BigInt(m.current.valueMinor!) - BigInt(m.previous.valueMinor!)).toString();
      ok(`${m.metric.key}: delta = current − previous`, m.deltaMinor === expected, `${m.deltaMinor} vs ${expected}`);
      const sign = BigInt(m.deltaMinor!);
      ok(
        `${m.metric.key}: direction agrees with the sign`,
        m.direction === (sign > 0n ? "up" : sign < 0n ? "down" : "flat")
      );
      if (sign !== 0n) moved += 1;
    } else {
      // The float-artifact guard. 12.3 − 11.9 is 0.40000000000000036 in float
      // and this number is rendered; a finding once shipped reading
      // "5.770833321759259 days".
      ok(
        `${m.metric.key}: delta is rounded to 2dp, not a float artifact`,
        m.deltaNumeric !== null && Math.abs(m.deltaNumeric * 100 - Math.round(m.deltaNumeric * 100)) < 1e-9,
        String(m.deltaNumeric)
      );
      if (m.deltaNumeric !== 0) moved += 1;
    }
  }
  // A diff where nothing moved on real data would mean the flow metrics are
  // not actually range-scoped — the same figure being written under two dates.
  ok("at least one metric genuinely moved between the two days", moved > 0, `${moved} moved`);

  console.log("\n[7] a gap in the history is reported, not smoothed over");
  // Wind back two more days so there is something to reach past, then delete
  // the adjacent day: the comparison now spans more than one night and must
  // say so. A brief announcing "cash fell ₹6L overnight" off a three-day gap is
  // describing three days while claiming one.
  await captureDailySnapshot(org.id, new Date(observedNow.getTime() - 2 * DAY_MS));
  await prisma.metricSnapshot.deleteMany({
    where: {
      organizationId: org.id,
      granularity: "DAILY",
      formulaVersion: DAILY_SNAPSHOT_VERSION,
      periodStart: startOfZonedDay(previousDay, org.timezone),
    },
  });
  const gapped = await getDailySnapshotDiff(org.id, observedNow);
  const compared = gapped.metrics.filter((m) => m.previous !== null);
  ok("there is still something to compare against", compared.length > 0, `${compared.length} metrics`);
  ok("the non-adjacent comparison is flagged", compared.some((m) => !m.previousIsAdjacent));
  ok("and a warning says so in words", gapped.warnings.some((w) => /gap/i.test(w)), gapped.warnings.join(" | "));

  console.log("\n[8] the read side sees this module's rows and not the other writers'");
  // cash.ts and inventory.ts both persist a DAILY available_cash /
  // inventory_value row of their own, keyed to a UTC midnight and stamped with
  // their own formulaVersion. Those rows are updated in place all day, so
  // letting them into a history series would produce a line that changes
  // retroactively. Provoke one, then confirm it stays out.
  await getAvailableCashSummary(org.id); // default range → cash.ts persists its own row
  const foreign = await prisma.metricSnapshot.count({
    where: {
      organizationId: org.id,
      granularity: "DAILY",
      metricKey: "available_cash",
      formulaVersion: { not: DAILY_SNAPSHOT_VERSION },
    },
  });
  ok("a foreign available_cash row exists to be excluded", foreign > 0, `${foreign} row(s)`);
  const captured = await prisma.metricSnapshot.count({
    where: {
      organizationId: org.id,
      granularity: "DAILY",
      metricKey: "available_cash",
      formulaVersion: DAILY_SNAPSHOT_VERSION,
    },
  });
  const history = await getSnapshotHistory(org.id, 30, observedNow);
  const cashSeries = history.series.find((s) => s.metric.key === "available_cash");
  ok(
    "the series carries exactly the days this module captured",
    (cashSeries?.points.length ?? 0) === captured,
    `${cashSeries?.points.length ?? 0} points vs ${captured} captured, ${foreign} foreign excluded`
  );
  ok("every series has a spec attached", history.series.every((s) => catalogued.has(s.metric.key)));
  ok(
    "money points carry a string valueMinor, never a JSON number",
    history.series.every((s) => s.metric.unit !== "paise" || s.points.every((p) => p.valueMinor === null || typeof p.valueMinor === "string"))
  );
  ok("points are in ascending date order", history.series.every((s) => s.points.every((p, i) => i === 0 || p.day > s.points[i - 1]!.day)));
  ok("the window is reported", history.days === 30, String(history.days));

  // res.json() throws on a BigInt, and the route composes three separately
  // built objects — the failure would be a 500 on a page that renders fine in
  // every unit test. Serialise exactly what GET /metrics/snapshot-history and
  // POST /metrics/snapshot-history/run put on the wire.
  const getPayload = {
    formulaVersion: DAILY_SNAPSHOT_VERSION,
    periodFiltered: false,
    catalogue: DAILY_SNAPSHOT_METRICS,
    ...history,
    diff: gapped,
  };
  let serialisable = true;
  let serialiseError = "";
  try {
    JSON.parse(JSON.stringify(getPayload));
    JSON.parse(
      JSON.stringify({
        ...capture,
        rows: capture.rows.map((r) => ({ ...r, valueMinor: r.valueMinor === null ? null : r.valueMinor.toString() })),
      })
    );
  } catch (err) {
    serialisable = false;
    serialiseError = err instanceof Error ? err.message : String(err);
  }
  ok("both route payloads survive JSON.stringify", serialisable, serialiseError);
  ok("the catalogue names a source group for every metric", DAILY_SNAPSHOT_METRICS.every((m) => m.sources.providers.length > 0));

  console.log("\n[9] the sweep runs every organisation and terminates");
  const started = Date.now();
  const sweep = await runDailySnapshotSweep(observedNow);
  const elapsed = Date.now() - started;
  ok("visited every organisation", sweep.ran + sweep.failed === sweep.organizations, `${sweep.ran} ran, ${sweep.failed} failed of ${sweep.organizations}`);
  ok("nothing failed", sweep.failed === 0);
  ok("wrote rows", sweep.written > 0, `${sweep.written} rows in ${elapsed}ms`);
  console.log(`     gaps: ${sweep.gaps.length}, blocked: ${sweep.blocked.length}`);

  console.log("\n[10] running the sweep twice does not double the history");
  const beforeCount = await prisma.metricSnapshot.count({
    where: { granularity: "DAILY", formulaVersion: DAILY_SNAPSHOT_VERSION },
  });
  await runDailySnapshotSweep(observedNow);
  const afterCount = await prisma.metricSnapshot.count({
    where: { granularity: "DAILY", formulaVersion: DAILY_SNAPSHOT_VERSION },
  });
  ok("row count is unchanged", afterCount === beforeCount, `${beforeCount} → ${afterCount}`);

  console.log("\n[11] a day no connector observed records nothing, and says why");
  // The failure this exists to prevent, on real data. The demo seed's feeds
  // stopped when it was generated, so every sales query for an actual recent
  // day returns a well-formed ₹0 that is not a measurement. Writing that zero
  // would put a permanent, invented collapse in the history.
  const realNow = new Date();
  const unobservedDay = lastCompleteDay(realNow, org.timezone);
  const blocked = await captureDailySnapshot(org.id, realNow);
  ok("targets the real yesterday", blocked.day === unobservedDay, blocked.day);
  ok("records nothing at all", blocked.written === 0, `${blocked.written} rows`);
  ok("and explains every metric it skipped", blocked.omitted.length === DAILY_SNAPSHOT_METRICS.length);
  ok(
    "naming the stale feed rather than reporting a zero",
    blocked.omitted.some((o) => /never observed this day/.test(o.reason)),
    blocked.omitted.find((o) => o.metricKey === "net_revenue_day")?.reason ?? ""
  );
  const nothingStored = await rowsFor(org.id, unobservedDay, org.timezone);
  ok("nothing reached the table", nothingStored.length === 0, `${nothingStored.length} rows`);

  const realSweep = await runDailySnapshotSweep(realNow);
  ok(
    "the sweep reports the organisation as blocked, not silently empty",
    realSweep.blocked.some((b) => b.organizationId === org.id),
    `${realSweep.blocked.length} blocked of ${realSweep.organizations}`
  );

  console.log("\n[12] the calc module stays importable without opening a Redis connection");
  // The trap syncCadence.ts documents and that already cost this project a
  // debugging session: if modules/calc/dailySnapshot.ts ever imports the
  // scheduler — or anything else building a BullMQ Queue at module scope —
  // this script stops terminating.
  const calcSource = await readFile(new URL("../src/modules/calc/dailySnapshot.ts", import.meta.url), "utf8");
  ok("calc/dailySnapshot.ts does not import the queue layer", !/from\s+["'].*modules\/queue\//.test(calcSource));
  ok("calc/dailySnapshot.ts does not import bullmq or redis directly", !/from\s+["'](bullmq|.*lib\/redis)/.test(calcSource));
  // The other half of the same rule: the scheduler must not carry the sweep
  // itself, or moving it back would be a one-line regression.
  const schedulerSource = await readFile(new URL("../src/modules/queue/snapshotScheduler.ts", import.meta.url), "utf8");
  ok("the scheduler imports the sweep rather than defining it", /import \{[^}]*runDailySnapshotSweep/.test(schedulerSource));

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
