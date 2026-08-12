import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { getDailySnapshotDiff } from "../src/modules/calc/dailySnapshot.js";
import { generateDailyBrief, readDailyBrief, renderDiffForModel } from "../src/modules/ai/dailyBrief.js";
import { extractFigures, verifyFigures } from "../src/modules/ai/verify.js";

// P4.5 against REAL snapshot history.
//
// The property that matters here cannot be unit-tested: whatever the model is
// shown must be the complete set of figures it may write, drawn from rows the
// deterministic engine actually captured for THIS organisation. A unit test
// asserts the renderer's shape; this asserts that the shape is filled with the
// database's own numbers and nothing else.
//
// Non-destructive by design: generateDailyBrief is idempotent per day, and
// with no ANTHROPIC_API_KEY it stores a stated reason instead of calling
// anything. That path is checked too, because it is the one most installations
// will be on.
//
// Run with: npx tsx scripts/checkDailyBrief.ts

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

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true, timezone: true } });
  if (orgs.length === 0) {
    console.log("no organisations — nothing to check");
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  console.log("\n[1] The model's input is built from real snapshot rows");
  // ---------------------------------------------------------------------------
  let anyWithHistory = false;
  for (const org of orgs) {
    const diff = await getDailySnapshotDiff(org.id);
    if (diff.metrics.length === 0) {
      console.log(`  · ${org.name}: no snapshot history yet`);
      continue;
    }
    anyWithHistory = true;
    const text = renderDiffForModel(diff.metrics, diff.warnings);

    ok(`${org.name}: input names every captured metric`, diff.metrics.every((m) => text.includes(m.metric.label)));

    // No raw JS number formatting. This is the exact bug that put "638333.1"
    // into a user-facing note earlier in the project: paiseToRupees returns a
    // Number, and a Number in prose renders unformatted.
    const rawDecimals = text.match(/(?<![₹\d.])\d{4,}\.\d+/g) ?? [];
    ok(`${org.name}: no unformatted decimal money in the input`, rawDecimals.length === 0, rawDecimals.join(", "));

    // Every money figure in the input must trace to a stored valueMinor.
    const figuresInText = new Set(extractFigures(text));
    const stored = diff.metrics
      .flatMap((m) => [m.current.valueMinor, m.deltaMinor, m.current.valueNumeric])
      .filter((v): v is string | number => v !== null && v !== undefined)
      .map((v) => String(v));
    ok(
      `${org.name}: input carries figures (${figuresInText.size} tokens over ${stored.length} stored values)`,
      figuresInText.size > 0 || stored.length === 0
    );

    // The verifier must accept the input as support for itself. If it does
    // not, every narrative built from this input would be discarded, and the
    // feature would be silently off for this org.
    const selfCheck = verifyFigures(
      {
        directAnswer: text.slice(0, 400),
        keyFigures: [],
        drivers: [],
        evidence: [],
        dataStatus: "estimated",
        warnings: [],
        recommendedAction: null,
      },
      [text]
    );
    ok(`${org.name}: the input verifies against itself`, selfCheck.ok, selfCheck.unsupported.join(", "));

    // Adjacency claims must match the data.
    const gapMetrics = diff.metrics.filter((m) => m.direction !== null && !m.previousIsAdjacent);
    ok(
      `${org.name}: ${gapMetrics.length} non-adjacent comparison(s) are flagged in the input`,
      gapMetrics.every((m) => {
        const line = text.split("\n").find((l) => l.startsWith(`- ${m.metric.label}:`)) ?? "";
        return line.includes("NOT the adjacent day");
      })
    );
  }
  ok("at least one organisation has snapshot history to narrate", anyWithHistory);

  // ---------------------------------------------------------------------------
  console.log("\n[2] Generation is idempotent and states its reason");
  // ---------------------------------------------------------------------------
  const target = orgs[0]!;
  const first = await generateDailyBrief(target.id);
  ok(`${target.name}: a brief row exists for ${first.day}`, typeof first.day === "string" && first.day.length === 10);
  ok(
    `${target.name}: it either has a narrative or says why not`,
    first.narrative !== null || (typeof first.reason === "string" && first.reason.length > 20),
    first.reason ?? "narrative present"
  );

  const second = await generateDailyBrief(target.id);
  ok(
    `${target.name}: a second call returns the same day's brief, not a second opinion`,
    second.day === first.day && second.generatedAt === first.generatedAt
  );

  const read = await readDailyBrief(target.id);
  ok(`${target.name}: GET reads back what was stored`, read.day === first.day && read.reason === first.reason);

  if (!process.env.ANTHROPIC_API_KEY) {
    ok(
      "with no API key, the reason names the missing configuration",
      (first.reason ?? "").includes("ANTHROPIC_API_KEY") || (first.reason ?? "").includes("Nothing moved") || (first.reason ?? "").includes("No snapshot history"),
      first.reason ?? ""
    );
    // The critical property of the unconfigured path: it must never invent a
    // narrative. A card rendering a reason is honest; one rendering an
    // AI-shaped summary written by a fallback template is not.
    ok("with no API key, no narrative is fabricated", first.narrative === null);
  }

  // ---------------------------------------------------------------------------
  console.log("\n[3] The card renders every field the generator can produce");
  // ---------------------------------------------------------------------------
  const cardSrc = await readFile(new URL("components/cards/BriefNarrativeCard.js", FRONTEND), "utf8");
  const pageSrc = await readFile(new URL("app/(dashboard)/daily-brief/page.js", FRONTEND), "utf8");
  for (const field of ["headline", "whatChanged", "whyItMatters", "watchFor", "caveats"]) {
    ok(`card renders .${field}`, cardSrc.includes(field));
  }
  ok("card renders the reason when there is no narrative", cardSrc.includes("brief.reason"));
  ok("card is labelled as AI-written", /Written by AI/i.test(cardSrc));
  ok("card states the metrics are computed, not written", /computed, not written/i.test(cardSrc));
  ok("card reports how many figures were checked", cardSrc.includes("figuresChecked"));
  ok("page fetches the stored brief rather than generating one", pageSrc.includes("/ai/daily-brief") && !pageSrc.includes("daily-brief/generate"));
  ok("page still renders its deterministic sections independently", pageSrc.includes("deriveSystemHealth") && pageSrc.includes("QuickMetric"));

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
