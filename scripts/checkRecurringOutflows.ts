import { prisma } from "../src/lib/prisma.js";
import { getCashForecast } from "../src/modules/calc/cashForecast.js";
import { applyScenario } from "../src/modules/calc/cashScenario.js";
import { expandSchedule, type RecurringOutflow } from "../src/modules/calc/recurringOutflows.js";
import { orgSettingsSchema } from "../src/modules/orgs/settings.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// P2.2e against the DEMO org's real generated year. The calendar arithmetic is
// unit-tested in recurringOutflows.test.ts; this checks what only shows up
// against a database — that a configured schedule reaches the forecast on its
// real dates, that folding it in does not double-count money the expense
// run-rate already carried, that the outflow split stays consistent on messy
// real numbers, and that the horizons still agree once lumpy fixed costs exist.
//
// Non-destructive: the org's original settings are restored in a finally block,
// so a failure part-way through cannot leave the demo org configured.
//
// Run with: npx tsx scripts/checkRecurringOutflows.ts

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

const rupees = (p: string | bigint) => "₹" + (Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });

const SCHEDULE: RecurringOutflow[] = [
  { id: "sal", label: "Salaries", category: "SALARY", amountPaise: "40000000", cadence: "MONTHLY", dayOfMonth: 1 },
  { id: "rent", label: "Warehouse rent", category: "RENT", amountPaise: "12000000", cadence: "MONTHLY", dayOfMonth: 5 },
  { id: "emi", label: "Equipment EMI", category: "EMI", amountPaise: "3500000", cadence: "MONTHLY", dayOfMonth: 31 },
  { id: "gst", label: "Advance tax", category: "TAX", amountPaise: "25000000", cadence: "QUARTERLY", month: 6, dayOfMonth: 15 },
];

function outflowParts(d: { outflowFromBillsMinor: string; outflowFromScheduleMinor: string; outflowFromRunRateMinor: string }) {
  return BigInt(d.outflowFromBillsMinor) + BigInt(d.outflowFromScheduleMinor) + BigInt(d.outflowFromRunRateMinor);
}

async function main() {
  const org = await findDemoOrg();
  if (!org) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }
  console.log(`\n=== ${org.name} (${org.timezone}) ===`);

  const original = await prisma.organization.findUnique({ where: { id: org.id }, select: { settings: true } });

  try {
    console.log("\n[1] the schedule survives the settings contract");
    // The forecast reads whatever is in the column; this is the only thing
    // standing between a typo in the UI and a silent ₹0 in the projection.
    const parsed = orgSettingsSchema.safeParse({ recurringOutflows: SCHEDULE });
    ok("a well-formed schedule validates", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
    const reject = (label: string, entry: unknown) =>
      ok(`rejects ${label}`, !orgSettingsSchema.safeParse({ recurringOutflows: [entry] }).success);
    reject("a monthly entry with no dayOfMonth", { id: "x", label: "L", category: "RENT", amountPaise: "100", cadence: "MONTHLY" });
    reject("a weekly entry with no weekday", { id: "x", label: "L", category: "RENT", amountPaise: "100", cadence: "WEEKLY" });
    reject("a quarterly entry with no anchor month", { id: "x", label: "L", category: "TAX", amountPaise: "100", cadence: "QUARTERLY", dayOfMonth: 1 });
    reject("a zero amount", { id: "x", label: "L", category: "RENT", amountPaise: "0", cadence: "MONTHLY", dayOfMonth: 1 });
    reject("a negative amount", { id: "x", label: "L", category: "RENT", amountPaise: "-500", cadence: "MONTHLY", dayOfMonth: 1 });
    reject("an unknown category", { id: "x", label: "L", category: "BRIBES", amountPaise: "100", cadence: "MONTHLY", dayOfMonth: 1 });
    reject("an unknown field", { id: "x", label: "L", category: "RENT", amountPaise: "100", cadence: "MONTHLY", dayOfMonth: 1, sneaky: true });
    reject("endDay before startDay", { id: "x", label: "L", category: "RENT", amountPaise: "100", cadence: "MONTHLY", dayOfMonth: 1, startDay: "2026-09-01", endDay: "2026-08-01" });
    ok(
      "rejects two entries sharing an id",
      !orgSettingsSchema.safeParse({ recurringOutflows: [SCHEDULE[0], { ...SCHEDULE[1], id: SCHEDULE[0]!.id }] }).success
    );

    console.log("\n[2] the baseline, with no schedule configured");
    await prisma.organization.update({ where: { id: org.id }, data: { settings: {} } });
    const now = new Date();
    const before90 = await getCashForecast(org.id, org.timezone, now, 90);
    const beforeSchedule = before90.components.find((c) => c.key === "outflow_recurring_schedule")!;
    const beforeRunRate = before90.components.find((c) => c.key === "outflow_run_rate")!;
    ok("the schedule component exists and reports itself unavailable", beforeSchedule.basis === "unavailable", beforeSchedule.basis);
    ok("it contributes nothing", beforeSchedule.valueMinor === "0");
    console.log(`     run-rate over 90d: ${rupees(beforeRunRate.valueMinor)}  (basis ${beforeRunRate.basis})`);

    console.log("\n[3] the missing-schedule warning fires on 30 and 90 days, not on 7");
    // Over 7 days a fixed cost either falls in the window or it does not, and
    // a founder can see that. Over 30 it lands for certain, so a line without
    // it is missing the largest single outflow the business has.
    const before7 = await getCashForecast(org.id, org.timezone, now, 7);
    const before30 = await getCashForecast(org.id, org.timezone, now, 30);
    ok("7-day line does not nag", !/recurring-cost schedule/.test(before7.reliabilityNote));
    ok("30-day line warns", /No recurring-cost schedule is configured/.test(before30.reliabilityNote));
    ok("90-day line warns", /No recurring-cost schedule is configured/.test(before90.reliabilityNote));
    const warning = before30.reliabilityNote.match(/No recurring-cost schedule[^.]*\./)?.[0] ?? "";
    ok("the warning names what is missing, not just that something is", /payroll|rent|EMI/i.test(warning), warning.slice(0, 120));

    console.log("\n[4] a configured schedule reaches the forecast on its real dates");
    await prisma.organization.update({ where: { id: org.id }, data: { settings: { recurringOutflows: SCHEDULE } } });
    const after90 = await getCashForecast(org.id, org.timezone, now, 90);
    const afterSchedule = after90.components.find((c) => c.key === "outflow_recurring_schedule")!;
    const expected = expandSchedule(SCHEDULE, after90.days[0]!.date, after90.days.at(-1)!.date);
    ok("the component is now assumed, not measured", afterSchedule.basis === "assumed", afterSchedule.basis);
    ok(
      "its total matches an independent expansion of the same schedule",
      afterSchedule.valueMinor === expected.totalPaise.toString(),
      `${rupees(afterSchedule.valueMinor)} vs ${rupees(expected.totalPaise)}`
    );
    ok("the warning is gone", !/No recurring-cost schedule is configured/.test(after90.reliabilityNote));

    let placedCorrectly = true;
    const daysWithSchedule: string[] = [];
    for (const d of after90.days) {
      const want = expected.byDay.get(d.date) ?? 0n;
      if (BigInt(d.outflowFromScheduleMinor) !== want) placedCorrectly = false;
      if (want > 0n) daysWithSchedule.push(`${d.date}=${rupees(want)}`);
    }
    ok("every day carries exactly the scheduled amount for that date", placedCorrectly);
    ok("and the days are lumpy, not smeared", daysWithSchedule.length > 0 && daysWithSchedule.length < after90.days.length, `${daysWithSchedule.length} of ${after90.days.length} days`);
    console.log(`     ${daysWithSchedule.slice(0, 6).join("  ")}`);
    ok("the 31st-of-the-month EMI is reported as clamped where the month is short", expected.clampedLabels.includes("Equipment EMI"), expected.clampedLabels.join(", "));
    ok("and the component note explains the clamp to the reader", /last day/.test(afterSchedule.note), afterSchedule.note.slice(0, 160));

    console.log("\n[5] money is counted once — the run-rate gives up what the schedule took");
    const afterRunRate = after90.components.find((c) => c.key === "outflow_run_rate")!;
    const runRateDrop = BigInt(beforeRunRate.valueMinor) - BigInt(afterRunRate.valueMinor);
    console.log(`     run-rate ${rupees(beforeRunRate.valueMinor)} → ${rupees(afterRunRate.valueMinor)}  (released ${rupees(runRateDrop)})`);
    console.log(`     schedule adds ${rupees(afterSchedule.valueMinor)}`);
    if (BigInt(beforeRunRate.valueMinor) > 0n) {
      ok("the run-rate fell rather than staying put", runRateDrop > 0n, rupees(runRateDrop));
      ok(
        "it never went negative — a schedule bigger than measured spend floors at zero",
        BigInt(afterRunRate.valueMinor) >= 0n
      );
      ok("and the note says the money was moved, not added", /counted once/.test(afterRunRate.note), afterRunRate.note.slice(0, 140));
    } else {
      // The org with no accounting connection — the case P2.2e mainly exists
      // for. Nothing to displace, so the schedule is pure addition.
      ok("with no measured expense run-rate, the schedule is pure addition", runRateDrop === 0n);
    }
    ok(
      "total outflow rose by no more than the schedule adds",
      BigInt(after90.totals.outflowMinor) - BigInt(before90.totals.outflowMinor) <= BigInt(afterSchedule.valueMinor),
      `${rupees(BigInt(after90.totals.outflowMinor) - BigInt(before90.totals.outflowMinor))} vs schedule ${rupees(afterSchedule.valueMinor)}`
    );

    console.log("\n[6] no user-facing prose leaks a raw unformatted number");
    // Caught for real: the note read "638333.1 a month" because the amount went
    // through paiseToRupees (a Number) instead of formatInr. Any money figure
    // baked into server-side prose has to be formatted where it is written —
    // the client cannot reformat a number already embedded in a sentence.
    const prose = [...after90.components.map((c) => c.note), after90.reliabilityNote, after90.openingBalance.note];
    // Percentages legitimately carry one decimal (95.5% of inflow), so they are
    // excluded — the target is a money figure that never met a formatter.
    const leaks = prose.filter((t) => /(?<![₹\d])\d+\.\d+(?!\s*%)/.test(t));
    ok("no note contains a bare decimal number", leaks.length === 0, leaks[0]?.slice(0, 140) ?? "");
    const moneyNotes = prose.filter((t) => /a month|per month/.test(t));
    ok(
      "every note that quotes a monthly figure quotes it in rupees",
      moneyNotes.every((t) => t.includes("₹")),
      moneyNotes.find((t) => !t.includes("₹"))?.slice(0, 140) ?? ""
    );

    console.log("\n[7] the split is self-consistent on every real day");
    let splitOk = true;
    let walkOk = true;
    let running = BigInt(after90.openingBalance.valueMinor);
    for (const d of after90.days) {
      if (outflowParts(d) !== BigInt(d.outflowMinor)) splitOk = false;
      if (d.openingMinor !== running.toString()) walkOk = false;
      running = running + BigInt(d.inflowMinor) - BigInt(d.outflowMinor);
      if (d.closingMinor !== running.toString()) walkOk = false;
    }
    ok("bills + schedule + run-rate == outflow, every day", splitOk);
    ok("and the balance walk still holds", walkOk);
    ok("totals agree with the days", running.toString() === after90.totals.closingMinor);

    console.log("\n[8] horizons still agree once outflow is lumpy");
    // The property P2.2a established, re-checked with a schedule in play: a
    // date-keyed cost must land identically whichever horizon asked, or the
    // 7-day and 90-day lines disagree about the same Tuesday.
    const after7 = await getCashForecast(org.id, org.timezone, now, 7);
    const after30 = await getCashForecast(org.id, org.timezone, now, 30);
    const byDate90 = new Map(after90.days.map((d) => [d.date, d]));
    let identical = true;
    let compared = 0;
    for (const short of [after7, after30]) {
      for (const d of short.days) {
        const long = byDate90.get(d.date);
        if (!long) continue;
        compared += 1;
        if (JSON.stringify(d) !== JSON.stringify(long)) identical = false;
      }
    }
    ok("every overlapping day is byte-identical across horizons", identical, `${compared} days compared`);

    console.log("\n[9] a scenario cannot defer payroll");
    // The bug the outflow split exists to prevent: before it, the scenario
    // inferred "bill" as whatever exceeded the flat run-rate, so a lumpy
    // salary day looked like a big deferrable bill.
    const scenario = applyScenario(after90, { vendorPaymentDelayDays: 30 });
    const scenarioByDate = new Map(scenario.days.map((d) => [d.date, d]));
    let scheduleMoved = false;
    for (const d of after90.days) {
      if (scenarioByDate.get(d.date)!.outflowFromScheduleMinor !== d.outflowFromScheduleMinor) scheduleMoved = true;
    }
    ok("every scheduled payment stayed on its own day", !scheduleMoved);
    ok(
      "the scheduled total is unchanged by the lever",
      scenario.days.reduce((a, d) => a + BigInt(d.outflowFromScheduleMinor), 0n) === BigInt(afterSchedule.valueMinor)
    );
    const lever = scenario.appliedLevers.find((l) => l.key === "vendorPaymentDelayDays");
    ok("and the lever's note says so in words", /not moved|not deferrable/i.test(lever?.note ?? ""), lever?.note?.slice(0, 120) ?? "");
    let scenarioSplitOk = true;
    for (const d of scenario.days) if (outflowParts(d) !== BigInt(d.outflowMinor)) scenarioSplitOk = false;
    ok("the scenario's own split stays consistent", scenarioSplitOk);

    console.log("\n[10] a schedule alone is enough to stop calling the line 'inflows only'");
    // An org with no accounting and no ads used to get "inflows_only" — a line
    // that rises forever. If a founder has told us ₹4L of payroll leaves on the
    // 1st, that is an outflow source, and the badge has to reflect it.
    ok("reliability is not inflows_only with a schedule configured", after90.reliability !== "inflows_only", after90.reliability);
    ok("the schedule counts toward the outflow side", BigInt(afterSchedule.valueMinor) > 0n);

    console.log("\n" + "─".repeat(60));
    console.log(`${pass} passed, ${fail} failed`);
    if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f}`));
  } finally {
    // Restored whatever happens. A check that leaves the demo org configured
    // would change what every later run of every other script sees.
    await prisma.organization.update({
      where: { id: org.id },
      data: { settings: original?.settings ?? undefined },
    });
    console.log("  (demo org settings restored)");
  }

  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
