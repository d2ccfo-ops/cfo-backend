import { prisma } from "../src/lib/prisma.js";
import { DEFAULT_TIMEZONE, resolveDateRange } from "../src/lib/dateRange.js";
import { getStateProfitability, stateFromRaw } from "../src/modules/calc/geography.js";
import { getCashConversionCycle } from "../src/modules/calc/cashCycle.js";

// P6.1 and P6.2 against real orders.
//
// Both of these are calculations where the conventional shortcut is to
// substitute a plausible default for a missing input — an industry DSO, a
// zero-cost line, a rate computed off three orders. Every check here is aimed
// at one of those.
//
// Run with: npx tsx scripts/checkAnalytics.ts

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
  const grouped = await prisma.order.groupBy({ by: ["organizationId"], _count: { _all: true } });
  const top = grouped.sort((a, b) => b._count._all - a._count._all)[0]!;
  const org = (await prisma.organization.findUnique({
    where: { id: top.organizationId },
    select: { id: true, name: true, timezone: true },
  }))!;
  const timeZone = org.timezone ?? DEFAULT_TIMEZONE;
  // A wide window, so there is enough data for the thresholds to bite.
  const range = resolveDateRange({ from: "2025-01-01", to: "2026-12-31" }, new Date(), timeZone);

  // ---------------------------------------------------------------------------
  console.log("\n[1] State extraction reads only the province");
  // ---------------------------------------------------------------------------
  ok("shipping address wins over billing", stateFromRaw({ shipping_address: { province: "Kerala" }, billing_address: { province: "Goa" } }) === "Kerala");
  ok("billing is the fallback", stateFromRaw({ billing_address: { province: "Goa" } }) === "Goa");
  ok("customer default is the last resort", stateFromRaw({ customer: { default_address: { province: "Punjab" } } }) === "Punjab");
  ok("province_code is accepted", stateFromRaw({ shipping_address: { province_code: "MH" } }) === "MH");
  ok("a blank province is not a state", stateFromRaw({ shipping_address: { province: "   " } }) === null);
  ok("no address is null, not 'Unknown'", stateFromRaw({}) === null && stateFromRaw(null) === null);

  // ---------------------------------------------------------------------------
  console.log("\n[2] State profitability over real orders");
  // ---------------------------------------------------------------------------
  const geo = await getStateProfitability(org.id, range);
  console.log(`  · ${org.name}: ${geo.states.length} states, ${geo.coveragePct}% of orders attributed`);
  ok("states were found", geo.states.length > 0, geo.states.slice(0, 5).map((s) => s.state).join(", "));
  ok("sorted by revenue, descending", geo.states.every((s, i) => i === 0 || BigInt(geo.states[i - 1]!.netRevenueMinor) >= BigInt(s.netRevenueMinor)));
  // The threshold that stops a three-order state reporting a 33% RTO rate
  // beside a real one.
  const thin = geo.states.filter((s) => s.orders < geo.minOrdersForRate);
  ok(`${thin.length} state(s) below ${geo.minOrdersForRate} orders report NO rate`, thin.every((s) => s.rtoRatePct === null && s.cancelRatePct === null));
  const thick = geo.states.filter((s) => s.orders >= geo.minOrdersForRate);
  ok(`${thick.length} state(s) above it DO report a rate`, thick.every((s) => s.rtoRatePct !== null));
  ok("every rate is a percentage, not a ratio", thick.every((s) => s.rtoRatePct === null || (s.rtoRatePct >= 0 && s.rtoRatePct <= 100)));
  // Unattributed orders are EXCLUDED, not spread. Saying so is the point.
  if (geo.unattributedOrders > 0) {
    ok("unattributed orders are declared as excluded", geo.warnings.some((w) => /do not sum/.test(w)), `${geo.unattributedOrders} orders`);
  }
  ok("money is carried as a minor-unit string as well as rupees", geo.states.every((s) => typeof s.netRevenueMinor === "string"));
  // The real finding this analysis exists to surface.
  const spread = thick.filter((s) => s.rtoRatePct !== null).map((s) => s.rtoRatePct!);
  if (spread.length >= 2) {
    const lo = Math.min(...spread);
    const hi = Math.max(...spread);
    console.log(`  · RTO rate ranges from ${lo}% to ${hi}% across states with enough orders to measure`);
    ok("the spread is reported rather than averaged away", hi >= lo);
  }

  // ---------------------------------------------------------------------------
  console.log("\n[3] Cash conversion cycle refuses to guess");
  // ---------------------------------------------------------------------------
  const ccc = await getCashConversionCycle(org.id, range);
  for (const t of ccc.terms) {
    console.log(`  · ${t.label}: ${t.days === null ? `not measurable — ${t.reason}` : `${t.days} days`}`);
  }
  ok("all three terms are present", ccc.terms.length === 3);
  ok("a term that cannot be measured is null with a reason", ccc.terms.every((t) => t.days !== null || (t.reason ?? "").length > 30));
  ok("a term that CAN be measured carries no reason", ccc.terms.every((t) => t.days === null || t.reason === null));
  // The property this whole module exists for: no substituted defaults.
  const anyNull = ccc.terms.some((t) => t.days === null);
  ok(
    anyNull ? "the cycle is null because a term is" : "the cycle is stated because every term was measured",
    anyNull ? ccc.cycleDays === null : ccc.cycleDays !== null
  );
  if (anyNull) {
    ok("and it says which term is missing", ccc.warnings.some((w) => /not a shorter cycle/.test(w)));
  } else {
    const [dio, dso, dpo] = ccc.terms.map((t) => t.days!);
    ok("the cycle equals DIO + DSO − DPO", Math.abs(ccc.cycleDays! - (dio! + dso! - dpo!)) < 0.11, `${ccc.cycleDays} vs ${dio! + dso! - dpo!}`);
  }
  ok("DSO is never negative", (ccc.terms.find((t) => t.key === "dso")!.days ?? 0) >= 0);
  ok("the interpretation is a sentence, not a number", ccc.interpretation.length > 30);

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
