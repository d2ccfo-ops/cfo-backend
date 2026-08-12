import { prisma } from "../src/lib/prisma.js";
import { DEFAULT_TIMEZONE } from "../src/lib/dateRange.js";
import {
  MAX_BUCKETS,
  MAX_SPAN_DAYS,
  MIN_SPAN_DAYS,
  autoGranularity,
  bucketKeyFor,
  enumerateBuckets,
  resolveTrendWindow,
  startOfZonedWeekKey,
} from "../src/lib/trendWindow.js";
import { getRevenueTrend } from "../src/modules/calc/revenueLadder.js";

// Audits the zoomable revenue trend.
//
// The invariant this exists to defend: RE-BUCKETING MUST NOT CHANGE THE TOTAL.
// Zooming from monthly to weekly to daily re-groups the same orders, so the sum
// of the daily points inside a month has to equal that month's point exactly.
// If it doesn't, a founder who pinches in sees a different business to the one
// they saw a second earlier, and there is no way to tell which was right.
//
// Run with: npx tsx scripts/checkRevenueTrend.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const rupees = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

// Floating rupees: paise-level rounding differs between one big sum and many
// small ones, so equality is asserted to the nearest rupee, not to the bit.
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

function isoDay(d: Date, timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// ---------------------------------------------------------------------------
// Pure window logic — no database
// ---------------------------------------------------------------------------
function auditWindowLogic() {
  console.log("\n=== window resolution (pure) ===");

  const now = new Date("2026-08-10T12:00:00Z");

  // [1] default
  const def = resolveTrendWindow({}, now, DEFAULT_TIMEZONE);
  ok("default is monthly", def.granularity === "month", def.granularity);
  ok("default is flagged isDefault", def.isDefault === true);
  const defBuckets = enumerateBuckets(def);
  ok("default spans 6 monthly buckets", defBuckets.length === 6, String(defBuckets.length));
  ok("default ends in the current month", defBuckets[defBuckets.length - 1]!.key === "2026-08", defBuckets[defBuckets.length - 1]!.key);
  ok("default starts 6 months back", defBuckets[0]!.key === "2026-03", defBuckets[0]!.key);

  // [2] auto granularity boundaries — the whole zoom experience is these three
  console.log("\n[2] auto granularity");
  ok("7 days → day", autoGranularity(7) === "day");
  ok("35 days → day", autoGranularity(35) === "day");
  ok("36 days → week", autoGranularity(36) === "week");
  ok("180 days → week", autoGranularity(180) === "week");
  ok("181 days → month", autoGranularity(181) === "month");
  ok("730 days → month", autoGranularity(730) === "month");

  // [3] clamps
  console.log("\n[3] clamps");
  const rejects = (label: string, q: Record<string, string>) => {
    try {
      resolveTrendWindow(q, now, DEFAULT_TIMEZONE);
      ok(label, false, "accepted");
    } catch {
      ok(label, true);
    }
  };
  rejects("span below MIN_SPAN_DAYS is rejected", { from: "2026-08-05", to: "2026-08-08" });
  rejects("span above MAX_SPAN_DAYS is rejected", { from: "2023-01-01", to: "2026-08-10" });
  rejects("from without to is rejected", { from: "2026-08-01" });
  rejects("to before from is rejected", { from: "2026-08-10", to: "2026-08-01" });
  rejects("non-calendar date is rejected", { from: "2026-02-30", to: "2026-03-30" });

  const minWindow = resolveTrendWindow({ from: "2026-08-01", to: "2026-08-07" }, now, DEFAULT_TIMEZONE);
  ok(`exactly ${MIN_SPAN_DAYS} days is accepted`, minWindow.granularity === "day", minWindow.granularity);

  // [4] bucket cap — 730 daily points would be a solid block, not a line
  console.log("\n[4] bucket cap");
  const wide = resolveTrendWindow(
    { from: "2024-09-01", to: "2026-08-10", granularity: "day" },
    now,
    DEFAULT_TIMEZONE
  );
  ok("explicit daily over 2 years is coarsened", wide.granularity !== "day", wide.granularity);
  ok("coarsening clears granularityWasAuto=false", wide.granularityWasAuto === true);
  ok("coarsened bucket count is under the cap", enumerateBuckets(wide).length <= MAX_BUCKETS, String(enumerateBuckets(wide).length));

  const pinned = resolveTrendWindow({ from: "2026-06-01", to: "2026-08-10", granularity: "month" }, now, DEFAULT_TIMEZONE);
  ok("an explicit granularity that fits is honoured", pinned.granularity === "month");
  ok("an honoured explicit granularity is not marked auto", pinned.granularityWasAuto === false);

  // [5] bucket layout — contiguous, ordered, non-overlapping
  console.log("\n[5] bucket layout");
  for (const g of ["day", "week", "month"] as const) {
    const w = resolveTrendWindow({ from: "2025-11-01", to: "2026-08-10", granularity: g }, now, DEFAULT_TIMEZONE);
    const b = enumerateBuckets(w);
    let contiguous = true;
    let ordered = true;
    for (let i = 1; i < b.length; i += 1) {
      if (b[i]!.start.getTime() !== b[i - 1]!.end.getTime() + 1) contiguous = false;
      if (b[i]!.start <= b[i - 1]!.start) ordered = false;
    }
    ok(`${w.granularity}: buckets are contiguous`, contiguous);
    ok(`${w.granularity}: buckets are strictly ordered`, ordered);
    ok(`${w.granularity}: first bucket covers window start`, b[0]!.start <= w.from && b[0]!.end >= w.from);
    ok(`${w.granularity}: last bucket covers window end`, b[b.length - 1]!.start <= w.to && b[b.length - 1]!.end >= w.to);
  }

  // [6] weeks start Monday
  console.log("\n[6] week boundaries");
  ok("Monday maps to itself", startOfZonedWeekKey("2026-08-10") === "2026-08-10");
  ok("Sunday maps back to the previous Monday", startOfZonedWeekKey("2026-08-09") === "2026-08-03");
  ok("Saturday maps back to Monday", startOfZonedWeekKey("2026-08-08") === "2026-08-03");

  // [7] §3 — buckets are cut on the ORG's calendar, not UTC. At daily
  // granularity this moves 5½ hours of orders, which is the difference between
  // a spike appearing on the right day and on the day before.
  console.log("\n[7] timezone boundaries");
  const oneAmIst = new Date("2026-08-10T01:00:00+05:30"); // 2026-08-09T19:30Z
  ok(
    "01:00 IST belongs to the IST day, not UTC's previous day",
    bucketKeyFor(oneAmIst, "day", DEFAULT_TIMEZONE) === "2026-08-10",
    bucketKeyFor(oneAmIst, "day", DEFAULT_TIMEZONE)
  );
  ok(
    "the same instant lands on 09 Aug under UTC (proving the cut matters)",
    bucketKeyFor(oneAmIst, "day", "UTC") === "2026-08-09"
  );
  const firstOfMonthIst = new Date("2026-08-01T00:30:00+05:30");
  ok(
    "00:30 IST on the 1st belongs to August, not July",
    bucketKeyFor(firstOfMonthIst, "month", DEFAULT_TIMEZONE) === "2026-08"
  );

  // [8] the ceiling the client is told about matches the one enforced
  console.log("\n[8] advertised limits");
  ok("MIN_SPAN_DAYS is 7", MIN_SPAN_DAYS === 7);
  ok("MAX_SPAN_DAYS matches the date filter's ceiling", MAX_SPAN_DAYS === 730);
}

// ---------------------------------------------------------------------------
// Against real data
// ---------------------------------------------------------------------------
async function auditOrg(organizationId: string, orgName: string, timezone: string) {
  console.log(`\n=== ${orgName} ===`);
  const now = new Date();

  // A window with real orders in it: the last 3 full months, so daily, weekly
  // and monthly all have something to disagree about.
  const to = isoDay(now, timezone);
  const threeMonthsAgo = new Date(now.getTime() - 89 * 86_400_000);
  const from = isoDay(threeMonthsAgo, timezone);

  const monthly = await getRevenueTrend(
    organizationId,
    resolveTrendWindow({ from, to, granularity: "month" }, now, timezone)
  );
  const weekly = await getRevenueTrend(
    organizationId,
    resolveTrendWindow({ from, to, granularity: "week" }, now, timezone)
  );
  const daily = await getRevenueTrend(
    organizationId,
    resolveTrendWindow({ from, to, granularity: "day" }, now, timezone)
  );

  console.log(
    `window ${from} → ${to}: ${monthly.series.length} months / ${weekly.series.length} weeks / ${daily.series.length} days`
  );

  // [9] THE invariant
  console.log("\n[9] re-bucketing preserves totals");
  const sum = (rows: { netRevenue: number | null }[]) =>
    rows.reduce((a, r) => a + (r.netRevenue ?? 0), 0);
  const m = sum(monthly.series);
  const w = sum(weekly.series);
  const d = sum(daily.series);
  ok(`monthly total equals weekly total`, near(m, w), `${rupees(m)} vs ${rupees(w)}`);
  ok(`monthly total equals daily total`, near(m, d), `${rupees(m)} vs ${rupees(d)}`);

  const sumCash = (rows: { cashReceived: number | null }[]) =>
    rows.reduce((a, r) => a + (r.cashReceived ?? 0), 0);
  ok(
    "cash received survives re-bucketing",
    near(sumCash(monthly.series), sumCash(daily.series)),
    `${rupees(sumCash(monthly.series))} vs ${rupees(sumCash(daily.series))}`
  );

  const sumOrders = (rows: { orders: number }[]) => rows.reduce((a, r) => a + r.orders, 0);
  ok(
    "order count survives re-bucketing",
    sumOrders(monthly.series) === sumOrders(daily.series),
    `${sumOrders(monthly.series)} vs ${sumOrders(daily.series)}`
  );

  // [10] Per-month decomposition, not just the grand total — a grand total can
  // match while two adjacent months have swapped a boundary day between them.
  console.log("\n[10] each month equals its own days");
  for (const month of monthly.series) {
    const days = daily.series.filter((x) => x.key.slice(0, 7) === month.key);
    if (days.length === 0) continue;
    // Only months fully inside the window can be compared; a partial month at
    // either edge is legitimately incomplete in the daily series too, but the
    // month bucket clips to the window, so this holds either way.
    const dayTotal = days.reduce((a, x) => a + (x.netRevenue ?? 0), 0);
    ok(
      `${month.key}: ${days.length} days sum to the month`,
      near(month.netRevenue ?? 0, dayTotal),
      `${rupees(month.netRevenue ?? 0)} vs ${rupees(dayTotal)}`
    );
  }

  // [11] Shape the frontend reads
  console.log("\n[11] response shape");
  const first = daily.series[0];
  ok("series is non-empty", daily.series.length > 0);
  ok("bucket carries a label", typeof first?.label === "string" && first.label.length > 0);
  ok("bucket carries a key", typeof first?.key === "string");
  ok("bucket carries ISO start/end", typeof first?.start === "string" && typeof first?.end === "string");
  ok("window reports its granularity", daily.window.granularity === "day", daily.window.granularity);
  ok("window reports bucket count", daily.window.buckets === daily.series.length);
  ok("window reports minSpanDays", daily.window.minSpanDays === MIN_SPAN_DAYS);
  ok("window reports maxSpanDays", daily.window.maxSpanDays === MAX_SPAN_DAYS);

  // [12] §110 — absence is null, never zero. Zooming out past the first order
  // must not draw a floor of ₹0 that reads as "we sold nothing".
  console.log("\n[12] invisible buckets are null, not zero");
  ok("dataFrom is reported", daily.window.dataFrom !== undefined);
  if (daily.window.dataFrom) {
    const early = await getRevenueTrend(
      organizationId,
      resolveTrendWindow(
        {
          from: isoDay(new Date(new Date(daily.window.dataFrom).getTime() - 400 * 86_400_000), timezone),
          to: isoDay(new Date(new Date(daily.window.dataFrom).getTime() - 30 * 86_400_000), timezone),
        },
        now,
        timezone
      )
    );
    const beforeFirstOrder = early.series.filter((x) => x.ordersVisible === false);
    ok(
      "buckets before the first order exist",
      beforeFirstOrder.length > 0,
      `${beforeFirstOrder.length} of ${early.series.length}`
    );
    ok(
      "…and carry null revenue rather than 0",
      beforeFirstOrder.every((x) => x.netRevenue === null),
      beforeFirstOrder.filter((x) => x.netRevenue !== null).map((x) => x.key).join(", ")
    );
  }

  const invisibleCash = daily.series.filter((x) => !x.cashVisible);
  ok(
    "buckets with no bank visibility carry null cash",
    invisibleCash.every((x) => x.cashReceived === null),
    `${invisibleCash.length} invisible`
  );

  // [13] Default window is unchanged by all of this
  console.log("\n[13] the default window still draws what it always did");
  const def = await getRevenueTrend(organizationId);
  ok("default returns 6 buckets", def.series.length === 6, String(def.series.length));
  ok("default is monthly", def.window.granularity === "month");
  ok(
    "default labels are bare month names",
    def.series.every((x) => /^[A-Z][a-z]{2}$/.test(x.label)),
    def.series.map((x) => x.label).join(" ")
  );
}

async function main() {
  auditWindowLogic();

  // Organization has no `orders` back-relation in this schema, so the orgs that
  // actually have data are found from the Order side.
  const withOrders = await prisma.order.findMany({
    distinct: ["organizationId"],
    select: { organizationId: true },
  });
  const orgs = await prisma.organization.findMany({
    where: { id: { in: withOrders.map((o) => o.organizationId) } },
    select: { id: true, name: true, timezone: true },
  });

  if (orgs.length === 0) console.log("\n(no organisation has orders — skipping the data audit)");
  for (const org of orgs) {
    await auditOrg(org.id, org.name, org.timezone ?? DEFAULT_TIMEZONE);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  • ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
