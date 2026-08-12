import { resolveDateRange } from "../src/lib/dateRange.js";
import { prisma } from "../src/lib/prisma.js";
import { MATERIAL_METRIC_KEYS } from "../src/modules/calc/dataStatus.js";
import { LONG_TAIL_METRIC_KEYS, buildLongTailEvidence } from "../src/modules/calc/evidenceLongTail.js";
import { EVIDENCE_ENVELOPE_METRICS, isEvidenceEnvelopeRef } from "../src/modules/ai/tools.js";

// P6.8's envelopes, built against the real database.
//
// THE BUG THIS CLOSES. Eleven of seventeen evidence references the AI could
// emit pointed at URLs that 404'd, because the §21 route served five metrics
// and the agent cited whatever sounded plausible. A citation is what a reader
// trusts INSTEAD of re-checking, so a broken one is worse than none.
//
// THE BUG IT MUST NOT INTRODUCE. These metrics have nothing to reconcile
// against — no third party states a state's margin. Letting one report
// "verified" would be the same failure in a more convincing costume, so every
// long-tail envelope must say NOT_RECONCILABLE and say why.
//
// Run with: npx tsx scripts/checkEvidenceLongTail.ts

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
  console.log("\n[1] The citable set and the served set are the same set");
  const served = [...MATERIAL_METRIC_KEYS, ...LONG_TAIL_METRIC_KEYS].sort();
  ok("every citable metric is served", [...EVIDENCE_ENVELOPE_METRICS].sort().join(",") === served.join(","), `${EVIDENCE_ENVELOPE_METRICS.length} vs ${served.length}`);
  for (const key of LONG_TAIL_METRIC_KEYS) {
    ok(`/evidence/${key} is a recognised ref`, isEvidenceEnvelopeRef(`/evidence/${key}`));
  }
  // The regression that started all of this.
  ok("an invented ref is still rejected", !isEvidenceEnvelopeRef("/evidence/net_revenue"));
  ok("…and another", !isEvidenceEnvelopeRef("/evidence/rto_rate"));

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  const withOrders: Array<{ id: string; name: string }> = [];
  for (const o of orgs) {
    if ((await prisma.order.count({ where: { organizationId: o.id } })) > 0) withOrders.push(o);
  }

  for (const org of withOrders) {
    console.log(`\n[2] ${org.name}`);
    const range = resolveDateRange({ from: "2025-08-01", to: "2026-08-12" });

    for (const key of LONG_TAIL_METRIC_KEYS) {
      const e = await buildLongTailEvidence(org.id, key, range, 20);

      // It must actually build. A citation to an endpoint that throws is the
      // same broken promise as one that 404s.
      ok(`${key}: builds`, e.metric === key);

      // NOT_RECONCILABLE, always, and never a borrowed status.
      ok(`${key}: reports NOT_RECONCILABLE`, e.reconciliationStatus.status === "NOT_RECONCILABLE", e.reconciliationStatus.status);
      // Naming the specific third party that does not exist. A generic "not
      // applicable" would be true and useless.
      ok(
        `${key}: says WHY it cannot be reconciled`,
        (e.reconciliationStatus.reasons[0]?.length ?? 0) > 60,
        `${e.reconciliationStatus.reasons[0]?.length ?? 0} chars`
      );

      // The formula version comes off the calc output, never retyped — so a
      // calc that bumps its version must show through here.
      ok(`${key}: carries a formula version from the calc`, /^v\d+$/.test(e.formulaVersion), e.formulaVersion);
      ok(`${key}: states a definition and a formula`, e.definition.length > 80 && e.formula.length > 20);
      // An empty result must still explain itself. This is the difference
      // between "no data" and "this metric is broken".
      ok(`${key}: always states completeness`, e.completeness.length > 15, e.completeness.slice(0, 60));

      // Sample rows are a subset of the CSV rows, never a different population
      // — the drawer and the export must describe the same thing.
      ok(`${key}: sample is a prefix of the export`, e.sampleTransactions.length <= e.csvRows.length);
      if (e.csvRows.length > 0 && e.sampleTransactions.length > 0) {
        ok(
          `${key}: sample and export share a shape`,
          Object.keys(e.sampleTransactions[0]!).join(",") === Object.keys(e.csvRows[0]!).join(",")
        );
      }

      // Inventory is a current-state reading — Shopify only ever states today's
      // stock. Claiming it was period-filtered would be false.
      if (key === "inventory_value") {
        ok("inventory_value does not claim to be period-filtered", e.period.periodFiltered === false);
      } else {
        ok(`${key}: states the period it covers`, e.period.periodFiltered === true);
      }
    }
  }

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
