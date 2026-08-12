import { describeRange, resolveDateRange } from "../src/lib/dateRange.js";

// The comparison window every "+12% vs last month" on the dashboard is measured
// against. It had a bug that fired on about seven days a year — always a month
// boundary, which is exactly when someone looks at a month-on-month card:
//
//   31 Mar  →  prior window 1 Feb → 3 MARCH   (31 days, three of them in the
//                                              very month being compared)
//
// There is no 31 February, and `Date.UTC(y, 1, 31)` rolls forward silently. The
// input validator already rejected "2026-02-30" from a user; the window derived
// internally was the one place that never checked.
//
// Run with: npx tsx scripts/checkDateRange.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const IST = "Asia/Kolkata";
const at = (day: string, hhmm = "09:00") => new Date(`${day}T${hhmm}:00Z`);

function main() {
  console.log("\n[1] month-end overflow — the prior window must never reach into the current month");
  // Every 31st whose predecessor is shorter, plus the three March days that
  // February cannot match, plus a leap year to prove Feb 29 is reachable.
  const boundaries: [string, string, number][] = [
    // now,        expected prior end, expected prior length in days
    ["2026-03-29", "2026-02-28", 28],
    ["2026-03-30", "2026-02-28", 28],
    ["2026-03-31", "2026-02-28", 28],
    ["2024-03-31", "2024-02-29", 29], // leap year
    ["2026-05-31", "2026-04-30", 30],
    ["2026-07-31", "2026-06-30", 30],
    ["2026-10-31", "2026-09-30", 30],
    ["2026-12-31", "2026-11-30", 30],
  ];
  for (const [day, expectedEnd, expectedDays] of boundaries) {
    const r = resolveDateRange({}, at(day), IST);
    const d = describeRange(r);
    ok(
      `${day}: prior ends ${expectedEnd}`,
      d.comparedTo.endDay === expectedEnd,
      `got ${d.comparedTo.endDay}`
    );
    ok(
      `${day}: prior spans ${expectedDays} days`,
      d.comparedTo.days === expectedDays,
      `got ${d.comparedTo.days}`
    );
    // The invariant that actually matters, independent of the numbers above:
    // the comparison window must END BEFORE the current window BEGINS.
    ok(`${day}: prior does not overlap the current month`, r.priorTo < r.from);
  }

  console.log("\n[2] ordinary days — same day-of-month range in the previous month");
  for (const [day, expectFrom, expectTo] of [
    ["2026-08-10", "2026-07-01", "2026-07-10"],
    ["2026-01-15", "2025-12-01", "2025-12-15"], // year rollover
    ["2026-02-01", "2026-01-01", "2026-01-01"],
    ["2026-06-15", "2026-05-01", "2026-05-15"],
  ] as const) {
    const d = describeRange(resolveDateRange({}, at(day), IST));
    ok(`${day}: prior is ${expectFrom} → ${expectTo}`,
      d.comparedTo.startDay === expectFrom && d.comparedTo.endDay === expectTo,
      `got ${d.comparedTo.startDay} → ${d.comparedTo.endDay}`);
    ok(`${day}: labelled previous_month`, d.comparison === "previous_month");
  }

  console.log("\n[3] an explicit range compares against the preceding window of equal length");
  const explicit = describeRange(resolveDateRange({ from: "2026-08-01", to: "2026-08-07" }, at("2026-08-10"), IST));
  ok("explicit range is not month comparison", explicit.comparison === "previous_period");
  ok("explicit prior is the 7 days before", explicit.comparedTo.startDay === "2026-07-25" && explicit.comparedTo.endDay === "2026-07-31",
    `got ${explicit.comparedTo.startDay} → ${explicit.comparedTo.endDay}`);
  ok("explicit windows are equal length", explicit.days === explicit.comparedTo.days,
    `${explicit.days} vs ${explicit.comparedTo.days}`);

  console.log("\n[4] the window is stated on the ORG calendar, not UTC");
  // 00:30 IST on 1 August is still 19:00 UTC on 31 July. A window cut on UTC
  // would report July here — the §3 rule, asserted rather than assumed.
  const istMidnight = new Date("2026-07-31T19:00:00Z"); // = 2026-08-01 00:30 IST
  const d = describeRange(resolveDateRange({}, istMidnight, IST));
  ok("just after IST midnight the current month is August", d.startDay === "2026-08-01", `got ${d.startDay}`);
  ok("and the comparison is July", d.comparedTo.startDay === "2026-07-01", `got ${d.comparedTo.startDay}`);
  ok("timeZone is reported", d.timeZone === IST);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main();
