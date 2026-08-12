import { prisma } from "../src/lib/prisma.js";
import { getCashForecast } from "../src/modules/calc/cashForecast.js";
import { applyScenario, runCashScenario, type ScenarioParams } from "../src/modules/calc/cashScenario.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// P2.2b scenario engine against the DEMO org's real generated year. The
// levers' arithmetic is unit-tested in cashScenario.test.ts over a hand-built
// base; this checks the properties that only show up on real data — that the
// transform holds its invariants against a messy real base, that it is
// genuinely deterministic, and that directional claims ("more ad spend means
// less cash") actually hold when the numbers are not round.
//
// Run with: npx tsx scripts/checkCashScenario.ts

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

function assertWalk(s: { openingBalance: { valueMinor: string }; days: Array<Record<string, string>>; totals: Record<string, string> }, tag: string) {
  let running = BigInt(s.openingBalance.valueMinor);
  let inSum = 0n;
  let outSum = 0n;
  let consistent = true;
  for (const d of s.days) {
    if (d.openingMinor !== running.toString()) consistent = false;
    running = running + BigInt(d.inflowMinor!) - BigInt(d.outflowMinor!);
    if (d.closingMinor !== running.toString()) consistent = false;
    if (BigInt(d.inflowFromPlacedOrdersMinor!) + BigInt(d.inflowFromProjectedOrdersMinor!) !== BigInt(d.inflowMinor!)) consistent = false;
    if (BigInt(d.inflowMinor!) < 0n || BigInt(d.outflowMinor!) < 0n) consistent = false;
    inSum += BigInt(d.inflowMinor!);
    outSum += BigInt(d.outflowMinor!);
  }
  ok(`${tag}: walk is self-consistent and never negative-flow`, consistent);
  ok(`${tag}: totals match the days`, inSum.toString() === s.totals.inflowMinor && outSum.toString() === s.totals.outflowMinor && running.toString() === s.totals.closingMinor);
}

async function main() {
  const org = await findDemoOrg();
  if (!org) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }
  console.log(`\n=== ${org.name} ===`);

  const now = new Date();
  const base = await getCashForecast(org.id, org.timezone, now, 30);
  console.log(
    `base 30d: in ${rupees(base.totals.inflowMinor)}  out ${rupees(base.totals.outflowMinor)}  close ${rupees(base.totals.closingMinor)}  trough ${rupees(base.lowestBalance.valueMinor)}`
  );

  console.log("\n[1] an empty scenario is exactly the base");
  const noop = applyScenario(base, {});
  ok("closing identical", noop.totals.closingMinor === base.totals.closingMinor);
  ok("every day identical", JSON.stringify(noop.days) === JSON.stringify(base.days));
  ok("delta is zero", noop.comparison.closingDeltaMinor === "0");

  console.log("\n[2] directional claims hold on real numbers");
  const grow = applyScenario(base, { growthDeltaPct: 25 });
  const shrink = applyScenario(base, { growthDeltaPct: -25 });
  ok("more growth ends with more cash", BigInt(grow.totals.closingMinor) > BigInt(base.totals.closingMinor), `${rupees(grow.totals.closingMinor)} vs ${rupees(base.totals.closingMinor)}`);
  ok("less growth ends with less cash", BigInt(shrink.totals.closingMinor) < BigInt(base.totals.closingMinor));
  const moreAds = applyScenario(base, { adSpendDeltaPct: 50 });
  ok("more ad spend ends with less cash", BigInt(moreAds.totals.closingMinor) < BigInt(base.totals.closingMinor));
  const worseRto = applyScenario(base, { rtoDeltaPct: 10 });
  ok("worse RTO ends with less cash", BigInt(worseRto.totals.closingMinor) < BigInt(base.totals.closingMinor));

  console.log("\n[3] every scenario's line is internally consistent");
  const CASES: Array<[string, ScenarioParams]> = [
    ["growth +25%", { growthDeltaPct: 25 }],
    ["ads +50%", { adSpendDeltaPct: 50 }],
    ["rto +10pts", { rtoDeltaPct: 10 }],
    ["collect 3d sooner", { collectionAccelDays: 3 }],
    ["delay bills 15d", { vendorPaymentDelayDays: 15 }],
    ["everything at once", { growthDeltaPct: 15, adSpendDeltaPct: 30, rtoDeltaPct: 5, collectionAccelDays: 2, vendorPaymentDelayDays: 10 }],
  ];
  for (const [tag, params] of CASES) assertWalk(applyScenario(base, params), tag);

  console.log("\n[4] delaying bills cannot destroy money — it moves it");
  // Within the horizon, a delay that keeps every bill inside the window must
  // leave total outflow unchanged. Bills pushed PAST the horizon legitimately
  // leave it, so this only asserts outflow never GROWS.
  const delayed = applyScenario(base, { vendorPaymentDelayDays: 5 });
  ok(
    "delayed bills do not increase total outflow",
    BigInt(delayed.totals.outflowMinor) <= BigInt(base.totals.outflowMinor),
    `${rupees(delayed.totals.outflowMinor)} vs ${rupees(base.totals.outflowMinor)}`
  );
  ok("delaying bills never ends with less cash", BigInt(delayed.totals.closingMinor) >= BigInt(base.totals.closingMinor));

  console.log("\n[5] a big enough purchase creates a shortage the base did not have");
  const opening = BigInt(base.openingBalance.valueMinor);
  const huge = (opening > 0n ? opening : 0n) + BigInt(base.totals.inflowMinor) + 10_000_000n;
  const crunch = applyScenario(base, { inventoryPurchase: { amountPaise: huge.toString(), date: base.days[1]!.date } });
  ok("scenario has a shortage date", crunch.cashShortageDate !== null, String(crunch.cashShortageDate));
  ok("comparison reports both sides", crunch.comparison.baseCashShortageDate === base.cashShortageDate && crunch.comparison.scenarioCashShortageDate === crunch.cashShortageDate);
  ok("trough moved down", BigInt(crunch.comparison.lowestBalanceDeltaMinor) < 0n, rupees(crunch.comparison.lowestBalanceDeltaMinor));

  console.log("\n[6] deterministic — the same question twice gives the same answer");
  const params: ScenarioParams = { growthDeltaPct: 17, adSpendDeltaPct: -8, rtoDeltaPct: 3, collectionAccelDays: 4 };
  const a = applyScenario(base, params);
  const b = applyScenario(base, params);
  ok("identical days", JSON.stringify(a.days) === JSON.stringify(b.days));
  ok("identical totals", JSON.stringify(a.totals) === JSON.stringify(b.totals));

  console.log("\n[7] runCashScenario returns a base and scenario that share a frame");
  const { base: b2, scenario } = await runCashScenario(org.id, { growthDeltaPct: 10 }, org.timezone, 30, now);
  ok("same horizon", b2.horizonDays === scenario.horizonDays);
  ok("same opening balance", b2.openingBalance.valueMinor === scenario.openingBalance.valueMinor);
  ok("same dates, in order", JSON.stringify(b2.days.map((d) => d.date)) === JSON.stringify(scenario.days.map((d) => d.date)));
  ok("scenario reliability is inherited, not improved", scenario.reliability === b2.reliability);

  console.log("\n[8] out-of-range levers are clamped, not obeyed");
  const absurd = applyScenario(base, { growthDeltaPct: 1e9, adSpendDeltaPct: -1e9 });
  ok("growth clamped to +500%", absurd.params.growthDeltaPct === 500, String(absurd.params.growthDeltaPct));
  ok("ad spend clamped to -100%", absurd.params.adSpendDeltaPct === -100, String(absurd.params.adSpendDeltaPct));
  assertWalk(absurd, "clamped extremes");

  console.log("\n[9] an unmodelled lever is reported, not silently dropped");
  const cod = applyScenario(base, { codShareDeltaPct: 25 });
  const lever = cod.appliedLevers.find((l) => l.key === "codShareDeltaPct");
  ok("codShareDeltaPct appears in appliedLevers", lever !== undefined);
  ok("marked not-applied", lever?.applied === false);
  ok("the line really is unchanged, matching the claim", cod.totals.closingMinor === base.totals.closingMinor);
  ok("and it reaches the reliability note", /not modelled/i.test(cod.reliabilityNote));

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
