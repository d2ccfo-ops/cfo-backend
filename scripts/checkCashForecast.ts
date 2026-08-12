import { addZonedDays } from "../src/lib/dateRange.js";
import { prisma } from "../src/lib/prisma.js";
import { FORECAST_HORIZONS, getCashForecast, type CashForecast, type ForecastHorizon } from "../src/modules/calc/cashForecast.js";

// Read-only. Run with: npx tsx scripts/checkCashForecast.ts
//
// P2.2a made the horizon a parameter, so this now runs all three (7/30/90)
// and adds the invariant that matters most for "ONE engine, one horizon
// param": the horizons must AGREE day-for-day wherever they overlap. If the
// 7-day line and the first week of the 90-day line ever differ, there are
// effectively two forecasts and a founder is being shown two answers to the
// same question depending on which toggle they pressed.

const rupees = (paise: string | bigint) =>
  "₹" + (Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });

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

// Every invariant that must hold for a single forecast, at any horizon.
function checkInvariants(f: CashForecast, tag: string) {
  let running = BigInt(f.openingBalance.valueMinor);
  let inSum = 0n;
  let outSum = 0n;
  let walkOk = true;
  let minBalance = BigInt(f.openingBalance.valueMinor);
  // When the opening balance IS the trough, the engine reports today's date —
  // "the lowest point is right now" — rather than a sentinel. The first
  // projected day is today+1, so today can only come from that seed.
  let minDate = f.days.length > 0 ? addZonedDays(f.days[0]!.date, -1) : f.generatedAt.slice(0, 10);
  let firstNegative: string | null = null;

  for (const d of f.days) {
    if (d.openingMinor !== running.toString()) walkOk = false;
    const expectedClose = running + BigInt(d.inflowMinor) - BigInt(d.outflowMinor);
    if (d.closingMinor !== expectedClose.toString()) walkOk = false;
    if (BigInt(d.inflowFromPlacedOrdersMinor) + BigInt(d.inflowFromProjectedOrdersMinor) !== BigInt(d.inflowMinor)) walkOk = false;
    running = expectedClose;
    inSum += BigInt(d.inflowMinor);
    outSum += BigInt(d.outflowMinor);
    if (running < minBalance) {
      minBalance = running;
      minDate = d.date;
    }
    if (firstNegative === null && running < 0n) firstNegative = d.date;
  }

  ok(`${tag}: the daily walk is self-consistent`, walkOk);
  ok(`${tag}: inflow total matches the days`, inSum.toString() === f.totals.inflowMinor);
  ok(`${tag}: outflow total matches the days`, outSum.toString() === f.totals.outflowMinor);
  ok(`${tag}: closing total matches the walk`, running.toString() === f.totals.closingMinor);
  ok(`${tag}: day count equals the horizon`, f.days.length === f.horizonDays, `${f.days.length} vs ${f.horizonDays}`);
  ok(`${tag}: no duplicate dates`, new Set(f.days.map((d) => d.date)).size === f.days.length);

  // §16 fields, recomputed independently from the days rather than trusted.
  ok(`${tag}: lowestBalance is the true trough`, f.lowestBalance.valueMinor === minBalance.toString(), `${f.lowestBalance.valueMinor} vs ${minBalance}`);
  ok(`${tag}: lowestBalance names the right date`, f.lowestBalance.date === minDate, `${f.lowestBalance.date} vs ${minDate}`);
  ok(`${tag}: cashShortageDate is the FIRST negative day`, f.cashShortageDate === firstNegative, `${f.cashShortageDate} vs ${firstNegative}`);
  // A shortage date implies the trough is negative, and vice versa. These are
  // two views of the same fact and must never disagree.
  ok(
    `${tag}: shortage date and a negative trough agree`,
    (f.cashShortageDate !== null) === (BigInt(f.lowestBalance.valueMinor) < 0n),
    `shortage=${f.cashShortageDate} trough=${f.lowestBalance.valueMinor}`
  );

  const totalProjected = f.days.reduce((a, d) => a + BigInt(d.inflowFromProjectedOrdersMinor), 0n);
  const expectedShare = inSum === 0n ? 0 : Math.round(Number((totalProjected * 1000n) / inSum)) / 10;
  ok(`${tag}: projectedInflowSharePct matches the days`, f.projectedInflowSharePct === expectedShare, `${f.projectedInflowSharePct} vs ${expectedShare}`);
  ok(`${tag}: projected share is a percentage`, f.projectedInflowSharePct >= 0 && f.projectedInflowSharePct <= 100, String(f.projectedInflowSharePct));
}

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true, timezone: true } });

  for (const org of orgs) {
    const orderCount = await prisma.order.count({ where: { organizationId: org.id } });
    if (orderCount === 0) continue;

    console.log(`\n=== ${org.name} (${org.timezone}) ===`);

    // One `now` across every horizon. Without this the 7-day run could land
    // on a different org-calendar day than the 90-day run near midnight, and
    // the overlap comparison below would fail for a reason that is not a bug.
    const now = new Date();
    const byHorizon = new Map<ForecastHorizon, CashForecast>();

    for (const h of FORECAST_HORIZONS) {
      const t0 = Date.now();
      const f = await getCashForecast(org.id, org.timezone, now, h);
      byHorizon.set(h, f);
      console.log(
        `\n  ${String(h).padStart(2)}d  ${String(Date.now() - t0).padStart(5)}ms  ` +
          `in ${rupees(f.totals.inflowMinor).padStart(14)}  out ${rupees(f.totals.outflowMinor).padStart(13)}  ` +
          `close ${rupees(f.totals.closingMinor).padStart(15)}  projected ${String(f.projectedInflowSharePct).padStart(5)}%`
      );
      console.log(
        `        trough ${rupees(f.lowestBalance.valueMinor)} on ${f.lowestBalance.date}` +
          `${f.cashShortageDate ? `  ⚠ SHORTAGE from ${f.cashShortageDate}` : "  (no shortage in horizon)"}`
      );
      checkInvariants(f, `${h}d`);
    }

    // THE point of a single parameterised engine: overlapping days must be
    // identical, not merely similar.
    console.log("\n  horizons agree where they overlap:");
    const h7 = byHorizon.get(7)!;
    const h30 = byHorizon.get(30)!;
    const h90 = byHorizon.get(90)!;
    for (const [shortTag, short, long] of [
      ["7d ⊂ 30d", h7, h30],
      ["30d ⊂ 90d", h30, h90],
    ] as const) {
      const mismatches = short.days.filter((d, i) => {
        const other = long.days[i];
        return (
          !other ||
          other.date !== d.date ||
          other.inflowMinor !== d.inflowMinor ||
          other.outflowMinor !== d.outflowMinor ||
          other.closingMinor !== d.closingMinor
        );
      });
      ok(`${shortTag}: every overlapping day is identical`, mismatches.length === 0, `${mismatches.length} differing day(s)`);
    }

    // The honesty claim the horizon note makes: a longer horizon is a larger
    // share of pure projection. If this ever inverted, the note would be
    // telling the reader the opposite of the truth.
    ok(
      "projected share does not fall as the horizon grows",
      h7.projectedInflowSharePct <= h30.projectedInflowSharePct &&
        h30.projectedInflowSharePct <= h90.projectedInflowSharePct,
      `7d=${h7.projectedInflowSharePct}% 30d=${h30.projectedInflowSharePct}% 90d=${h90.projectedInflowSharePct}%`
    );
    // The opening balance is a fact about today, not about the horizon.
    ok(
      "every horizon starts from the same opening balance",
      h7.openingBalance.valueMinor === h30.openingBalance.valueMinor &&
        h30.openingBalance.valueMinor === h90.openingBalance.valueMinor
    );

    console.log(`\n  components (30d): ${h30.reliability}`);
    for (const c of h30.components) {
      console.log(`    ${c.basis.padEnd(12)} ${c.label.padEnd(34)} ${rupees(c.valueMinor).padStart(14)}`);
    }
    console.log(`  note: ${h30.reliabilityNote}`);
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
