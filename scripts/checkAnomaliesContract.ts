import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { serializeAnomaly } from "../src/routes/anomalies.js";

// The seam between cfo-backend's GET /anomalies and cfo-frontend's
// lib/anomalies.js — driven end to end with REAL rows.
//
// This exists because neither side's own tests cover it. The backend proves
// it stores and serves the right numbers; the frontend builds and lints. But
// the frontend's dashboard routes are Clerk-gated, so a rendered screenshot
// of the Exceptions page needs a signed-in session that no script can mint —
// and the mapping from an anomaly row to an alert card (titles, wording,
// hrefs, the evidence fields each rule's copy reads) is exactly where a typo
// silently produces "undefined" on a founder's screen.
//
// So: take the ACTUAL serializer the route uses (imported, not reimplemented,
// so it cannot drift), feed it real rows, run the ACTUAL frontend mapper over
// the result, and assert every card is complete. That covers everything about
// this seam except pixels.
//
// Run with: npx tsx scripts/checkAnomaliesContract.ts

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

const FRONTEND = new URL("../../cfo-frontend/", pathToFileURL(import.meta.dirname + "/"));

// lib/anomalies.js imports "@/lib/money". Node has no idea what "@/" means —
// that alias is jsconfig.json's, resolved by Next's bundler. Rather than
// reimplement the module (which would defeat the point of testing the real
// one), the source is read and the alias rewritten to a real file URL before
// evaluating it as a data: module.
async function loadFrontendMapper() {
  const src = await readFile(new URL("lib/anomalies.js", FRONTEND), "utf8");
  const moneyUrl = new URL("lib/money.js", FRONTEND).href;
  const rewritten = src.replace(/from\s+["']@\/lib\/money["']/g, `from ${JSON.stringify(moneyUrl)}`);
  return import(`data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}`);
}

async function main() {
  const { toAlerts } = await loadFrontendMapper();

  // Every stored anomaly, across every org — the point is to exercise as many
  // distinct rule types as the database actually holds.
  const rows = await prisma.anomaly.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (rows.length === 0) {
    console.log("no anomalies stored — run scripts/checkAnomalies.ts first");
    process.exit(1);
  }

  // The exact wire shape GET /anomalies emits.
  const payload = { anomalies: rows.map(serializeAnomaly), nextCursor: null };
  const alerts = toAlerts(payload);

  console.log(`\n=== ${alerts.length} alert card(s) from ${rows.length} stored anomal${rows.length === 1 ? "y" : "ies"} ===`);

  ok("every stored anomaly maps to exactly one card", alerts.length === rows.length, `${alerts.length} vs ${rows.length}`);

  const SEVERITIES = new Set(["critical", "warning", "info"]);
  for (const a of alerts) {
    console.log(`\n  [${a.severity}] ${a.title}`);
    console.log(`    ${a.description}`);
    console.log(`    meta: ${a.meta}`);
    console.log(`    href: ${a.href}`);

    ok(`${a.type}: severity is one AlertCard understands`, SEVERITIES.has(a.severity), a.severity);
    // The failure this whole script exists to catch: a title or body that
    // renders the literal string "undefined"/"NaN" because the copy read an
    // evidence field the rule does not actually set.
    for (const [field, value] of [["title", a.title], ["description", a.description], ["meta", a.meta]] as const) {
      ok(`${a.type}: ${field} is non-empty`, typeof value === "string" && value.trim().length > 0, JSON.stringify(value));
      // `null` is in this list because it caught a real one: a SKU whose net
      // revenue is zero (everything refunded) has a null cm0Pct, and the
      // copy rendered "at null% CM0" on a founder's screen.
      ok(
        `${a.type}: ${field} has no undefined/null/NaN/[object Object]`,
        !/\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/.test(String(value)),
        String(value)
      );
    }
    ok(`${a.type}: href points somewhere`, typeof a.href === "string" && a.href.startsWith("/"), String(a.href));
    ok(`${a.type}: carries a stable id for React keys`, typeof a.id === "string" && a.id.length > 0);
  }

  // Only the types that happened to fire are covered above. The other rules'
  // copy would otherwise ship having never once been executed, so each type
  // gets a synthetic row carrying the SAME evidence shape its rule builds in
  // modules/calc/anomalies.ts. These are fixtures for the wording, not
  // findings — nothing is written to the database.
  console.log("\n=== every AnomalyType's copy renders (synthetic evidence) ===");
  const FIXTURES: Array<[string, number, number, number, Record<string, unknown>]> = [
    ["REVENUE_DECLINE", 820000, 1100000, -280000, { changePct: -25.5, valueMinor: "82000000", priorValueMinor: "110000000" }],
    ["REVENUE_SPIKE", 1700000, 1100000, 600000, { changePct: 54.5, valueMinor: "170000000", priorValueMinor: "110000000" }],
    ["AD_SPEND_SPIKE", 240000, 150000, 90000, { changePct: 60, valueMinor: "24000000", priorValueMinor: "15000000", currency: "INR" }],
    ["RTO_INCREASE", 12.4, 6.1, 6.3, { rtoCount: 62, dispatchedCount: 500 }],
    ["REFUND_INCREASE", 7.2, 5, 2.2, { ordersWithRefund: 34, refundValue: 96000, priorRatePct: 3.1 }],
    ["COURIER_COST_INCREASE", 310000, 240000, 70000, { changePct: 29.2, currentPaise: "31000000", priorPaise: "24000000", currentLines: 820, priorLines: 790 }],
    ["NEGATIVE_MARGIN_SKU", 3, 0, 3, { worst: { sku: "SKU-9", productName: "Brass Diya", cm0Pct: -18.4 }, totalNegativeCm0: -42000 }],
    ["MISSING_SETTLEMENT", 6.2, 1, 5.2, { connectionId: "c1", label: "RAZORPAY (acc_X)", baselineGapDays: 1 }],
    ["DUPLICATE_PAYMENT", 2, 0, 2, { totalDuplicatedPaise: "480000", totalDuplicated: 4800, orders: [] }],
    ["CANCELLATION_INCREASE", 8.1, 5, 3.1, { cancelledCount: 41, cancelledValue: 132000, priorRatePct: 4.2 }],
    ["PRODUCT_COST_INCREASE", 4, 0, 4, { worst: { sku: "SKU-3", changePct: 22 }, skus: [] }],
    ["CASH_BELOW_THRESHOLD", 380000, 500000, -120000, { currentPaise: "38000000", thresholdPaise: "50000000" }],
  ];
  const base = payload.anomalies[0]!;
  const synthetic = toAlerts({
    anomalies: FIXTURES.map(([type, observed, expected, difference, evidence], i) => ({
      ...base,
      id: `fixture-${i}`,
      type,
      severity: "WARNING",
      observedValue: observed,
      expectedValue: expected,
      difference,
      evidence,
      recommendedInvestigation: "Synthetic fixture — exercises this type's card copy.",
    })),
  });
  ok("every AnomalyType produces a card", synthetic.length === FIXTURES.length, `${synthetic.length} vs ${FIXTURES.length}`);
  for (const a of synthetic) {
    console.log(`  ${a.type}\n    ${a.title}\n    ${a.description}`);
    ok(`${a.type}: title clean`, !/\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/.test(a.title), a.title);
    ok(`${a.type}: description clean`, !/\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/.test(a.description), a.description);
    ok(`${a.type}: has an href`, typeof a.href === "string" && a.href.startsWith("/"), String(a.href));
  }

  // The null-cm0Pct case that this script caught in review — a SKU with costs
  // but zero net revenue, so there is no ratio to express the margin as.
  console.log("\n=== a negative-margin SKU with no net revenue to rate against ===");
  const nullPct = toAlerts({
    anomalies: [{ ...base, id: "nullpct-1", type: "NEGATIVE_MARGIN_SKU", observedValue: 1, expectedValue: 0, difference: 1, evidence: { worst: { sku: "S", productName: "Narmadeshwar Shivling", cm0Pct: null } } }],
  })[0]!;
  ok("names the SKU without printing a null percentage", !/\bnull\b/.test(nullPct.description), nullPct.description);
  ok("still says money is being lost", /loses money/.test(nullPct.description));

  // A type the frontend has no wording for must still degrade to something
  // readable — a backend that ships a new rule first should not blank a card.
  console.log("\n=== an unknown future rule type degrades readably ===");
  const future = toAlerts({
    anomalies: [{ ...payload.anomalies[0]!, id: "future-1", type: "SOME_FUTURE_RULE", evidence: {} }],
  });
  ok("unknown type still produces a card", future.length === 1);
  ok("unknown type has a readable title", !/undefined/.test(future[0]!.title), future[0]!.title);
  ok("unknown type falls back to the server's recommendedInvestigation", future[0]!.description.length > 0);

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
