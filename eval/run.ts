import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { DEFAULT_TIMEZONE } from "../src/lib/dateRange.js";
import { prisma } from "../src/lib/prisma.js";
import { ask, isAiConfigured } from "../src/modules/ai/orchestrator.js";
import { executeTool, type ToolContext } from "../src/modules/ai/tools.js";
import { gradeCase, readPath, summarise, type CaseVerdict, type EvalCase } from "./grade.js";

// §32 eval runner (P4.6). `npm run eval`.
//
// WHAT THIS IS FOR. Not a score to put on a slide. The AI layer's one
// non-negotiable property is that every figure it states came from a
// deterministic calculation, and there is no way to establish that by reading
// answers — a fabricated figure reads exactly like a real one. This suite asks
// the real model real questions against the real database, resolves the ground
// truth by calling the SAME calc function the tool wraps, and fails the run
// when they disagree.
//
// TWO RULES ABOUT HOW IT REPORTS.
//
// A case that cannot be graded is SKIPPED, never passed. When the ground truth
// resolves to null — the metric has no data for this org — marking the case
// green would produce a suite that gets greener as the data gets worse.
//
// With no ANTHROPIC_API_KEY the whole suite reports NOT RUN and exits non-zero
// unless --allow-unconfigured is passed. A CI job that silently succeeds
// because the key was missing is the most expensive kind of green.
//
// Usage:
//   npm run eval
//   npm run eval -- --org=<id>          run against a specific organisation
//   npm run eval -- --category=pii      one category
//   npm run eval -- --case=inj-004      one case
//   npm run eval -- --list              print the case inventory and exit
//   npm run eval -- --allow-unconfigured

const CONCURRENCY = 4;

interface Args {
  org?: string;
  category?: string;
  case?: string;
  list: boolean;
  allowUnconfigured: boolean;
  json?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, allowUnconfigured: false };
  for (const a of argv) {
    if (a === "--list") args.list = true;
    else if (a === "--allow-unconfigured") args.allowUnconfigured = true;
    else if (a.startsWith("--org=")) args.org = a.slice(6);
    else if (a.startsWith("--category=")) args.category = a.slice(11);
    else if (a.startsWith("--case=")) args.case = a.slice(7);
    else if (a.startsWith("--json=")) args.json = a.slice(7);
  }
  return args;
}

async function loadCases(): Promise<EvalCase[]> {
  const dir = new URL("./cases/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const text = await readFile(new URL(file, dir), "utf8");
    text.split("\n").forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: EvalCase;
      try {
        parsed = JSON.parse(trimmed) as EvalCase;
      } catch (err) {
        throw new Error(`${file}:${i + 1} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
      }
      // A duplicate id would make two cases share a verdict line, and the one
      // that silently disappears is always the one that was failing.
      if (seen.has(parsed.id)) throw new Error(`${file}:${i + 1} duplicates case id ${parsed.id}`);
      seen.add(parsed.id);
      cases.push(parsed);
    });
  }
  return cases;
}

/**
 * Resolve a case's ground truth by executing the tool directly.
 *
 * This is the whole point of the suite: the expected value is not written into
 * the case file (where it would rot the moment the data changed) — it is
 * computed at run time by the same code path the model's tool call would take.
 * If the calc function is wrong, the eval is wrong in the same direction, and
 * that is correct: this suite tests the MODEL, not the arithmetic. The
 * arithmetic has its own tests.
 */
async function resolveGroundTruth(ctx: ToolContext, c: EvalCase): Promise<string | null> {
  if (!c.expect.groundTruth) return null;
  const { tool, path } = c.expect.groundTruth;
  const exec = await executeTool(ctx, tool, {});
  if (!exec.ok) return null;
  return readPath(exec.result, path);
}

async function runCase(ctx: ToolContext, c: EvalCase): Promise<CaseVerdict> {
  const truth = await resolveGroundTruth(ctx, c);
  const result = await ask(ctx, c.question);

  // The exact tool outputs this run produced, pulled back from the audit
  // trail rather than re-executed: verifyFigures must search the bytes the
  // model actually saw, and re-running a tool a second later could return a
  // different number.
  const calls = await prisma.agentToolCall.findMany({
    where: { runId: result.runId, ok: true },
    select: { result: true },
  });
  const toolOutputs = calls.map((r) => JSON.stringify(r.result));

  return gradeCase(c, result, truth, toolOutputs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cases = await loadCases();

  if (args.category) cases = cases.filter((c) => c.category === args.category);
  if (args.case) cases = cases.filter((c) => c.id === args.case);

  if (args.list) {
    const byCategory = new Map<string, EvalCase[]>();
    for (const c of cases) byCategory.set(c.category, [...(byCategory.get(c.category) ?? []), c]);
    for (const [cat, list] of [...byCategory].sort()) {
      console.log(`\n${cat} (${list.length})`);
      for (const c of list) console.log(`  ${c.id}  ${c.question}`);
    }
    console.log(`\n${cases.length} cases total`);
    await prisma.$disconnect();
    return;
  }

  if (cases.length === 0) {
    console.error("No cases matched.");
    await prisma.$disconnect();
    process.exit(1);
  }

  if (!isAiConfigured()) {
    console.error(
      "\nANTHROPIC_API_KEY is not set, so no case can be run.\n" +
        "This is reported as a failure rather than a skip: a suite that goes green\n" +
        "because the key was missing is the most expensive kind of green.\n" +
        "Pass --allow-unconfigured to exit 0 anyway (for a build that has no key by design).\n"
    );
    await prisma.$disconnect();
    process.exit(args.allowUnconfigured ? 0 : 1);
  }

  const org = args.org
    ? await prisma.organization.findUnique({ where: { id: args.org }, select: { id: true, name: true, timezone: true } })
    : // Default to the org with the most orders — the one whose answers are
      // worth grading. An empty org would pass the accuracy cases by skipping
      // every one of them.
      await (async () => {
        const grouped = await prisma.order.groupBy({ by: ["organizationId"], _count: { _all: true } });
        const top = grouped.sort((a, b) => b._count._all - a._count._all)[0];
        if (!top) return null;
        return prisma.organization.findUnique({
          where: { id: top.organizationId },
          select: { id: true, name: true, timezone: true },
        });
      })();

  if (!org) {
    console.error("No organisation with data to evaluate against.");
    await prisma.$disconnect();
    process.exit(1);
  }

  const ctx: ToolContext = { organizationId: org.id, timeZone: org.timezone ?? DEFAULT_TIMEZONE, userId: "eval-runner" };

  console.log(`\nCFOOS AI eval — ${cases.length} cases against "${org.name}"`);
  console.log(`model: ${process.env.AI_MODEL ?? "claude-opus-5"}\n`);

  const verdicts: CaseVerdict[] = [];
  const queue = [...cases];
  const started = Date.now();

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      try {
        const v = await runCase(ctx, c);
        verdicts.push(v);
        const mark = v.skipped ? "–" : v.passed ? "✓" : "✗";
        console.log(`  ${mark} ${c.id.padEnd(10)} ${c.category.padEnd(19)} ${c.question.slice(0, 60)}`);
        for (const f of v.failures) console.log(`      ${f}`);
        for (const n of v.notes) console.log(`      (${n})`);
      } catch (err) {
        // An exception here is the harness failing, not the model. Recorded as
        // a failure so it cannot be mistaken for a clean run.
        verdicts.push({
          id: c.id,
          category: c.category,
          passed: false,
          skipped: false,
          failures: [`harness error: ${err instanceof Error ? err.message : String(err)}`],
          notes: [],
        });
        console.log(`  ✗ ${c.id.padEnd(10)} harness error`);
      }
    }
  });
  await Promise.all(workers);

  const summary = summarise(verdicts);
  const seconds = Math.round((Date.now() - started) / 1000);

  console.log(`\n${"─".repeat(72)}`);
  for (const [cat, s] of Object.entries(summary.byCategory).sort()) {
    console.log(`  ${cat.padEnd(20)} ${String(s.passed).padStart(3)} passed  ${String(s.failed).padStart(3)} failed  ${String(s.skipped).padStart(3)} skipped`);
  }
  console.log(`${"─".repeat(72)}`);
  console.log(`  ${summary.passed}/${summary.total - summary.skipped} graded cases passed, ${summary.skipped} skipped, in ${seconds}s`);

  if (summary.failed > 0) {
    console.log(`\nFAILED CASES — each with the reason the case exists:\n`);
    for (const v of verdicts.filter((x) => !x.passed && !x.skipped)) {
      const c = cases.find((x) => x.id === v.id)!;
      console.log(`  ${v.id}  ${c.question}`);
      console.log(`    why this case exists: ${c.why}`);
      for (const f of v.failures) console.log(`    → ${f}`);
      console.log("");
    }
  }

  if (args.json) {
    await mkdir(new URL("./", new URL(args.json, `file://${process.cwd()}/`)), { recursive: true }).catch(() => {});
    await writeFile(args.json, JSON.stringify({ org: org.name, summary, verdicts }, null, 2));
    console.log(`\nwrote ${args.json}`);
  }

  await prisma.$disconnect();
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
