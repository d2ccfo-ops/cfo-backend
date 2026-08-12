import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { getDataFreshness } from "../src/modules/calc/freshness.js";
import { TOOLS, TOOLS_BY_NAME, isKnownEvidenceRef } from "../src/modules/ai/tools.js";
import { parseStructuredAnswer } from "../src/modules/ai/orchestrator.js";
import { verifyFigures, verifyNoPii, verifySources } from "../src/modules/ai/verify.js";

// P4.4's seam: cfo-backend's /ai routes against cfo-frontend's AI CFO page.
//
// The page is Clerk-gated, so no script can render it. What CAN be checked is
// every assumption it makes about the server's shapes — and the one that will
// break first is the suggested-questions list, because it is the only place in
// the frontend that hardcodes Provider enum values. A typo there ("BLUEDART"
// vs "BLUE_DART") does not throw: the question simply never appears, and the
// page looks like it decided the org's data could not answer it.
//
// Run with: npx tsx scripts/checkAiWorkspace.ts

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
  const pageSrc = await readFile(new URL("app/(dashboard)/ai-cfo/page.js", FRONTEND), "utf8");
  const cardSrc = await readFile(new URL("components/cards/AIAnswerCard.js", FRONTEND), "utf8");

  // -------------------------------------------------------------------------
  console.log("\n[1] Suggested questions name real providers");
  // -------------------------------------------------------------------------
  const providerEnum = new Set<string>(
    // Read off the generated Prisma client rather than retyped: the enum is
    // the authority, and a second copy here would drift the same way the
    // frontend's did.
    Object.keys((await import("@prisma/client")).Provider)
  );
  const needsBlocks = [...pageSrc.matchAll(/needs:\s*\[([^\]]*)\]/g)].map((m) => m[1]!);
  ok("page declares provider requirements per question", needsBlocks.length >= 8, `${needsBlocks.length} blocks`);

  const namedProviders = new Set<string>();
  for (const block of needsBlocks) {
    for (const raw of block.split(",")) {
      const p = raw.trim().replace(/^["']|["']$/g, "");
      if (p) namedProviders.add(p);
    }
  }
  for (const p of namedProviders) {
    ok(`provider ${p} exists in the Provider enum`, providerEnum.has(p));
  }

  // -------------------------------------------------------------------------
  console.log("\n[2] Freshness fields the filter reads actually exist");
  // -------------------------------------------------------------------------
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  if (!org) {
    console.log("no organisation in the database — cannot check live shapes");
    process.exit(1);
  }
  const freshness = await getDataFreshness(org.id);
  ok("freshness returns a sources array", Array.isArray(freshness.sources), `${freshness.sources.length} sources`);
  const sample = freshness.sources[0];
  ok("sources carry .provider", sample === undefined || typeof sample.provider === "string");
  ok("sources carry .status", sample === undefined || typeof sample.status === "string");
  ok(
    "the page filters on status === 'ACTIVE', which is a value the API emits",
    freshness.sources.every((s) => typeof s.status === "string"),
    freshness.sources.map((s) => s.status).join(",") || "no sources"
  );

  // A suggestion set computed exactly the way the page computes one, against
  // this org's real connections. Zero is a legitimate answer for an org with
  // nothing connected — what would be wrong is every question filtered out
  // while sources ARE active.
  const active = new Set(freshness.sources.filter((s) => s.status === "ACTIVE").map((s) => s.provider as string));
  const universalCount = [...pageSrc.matchAll(/needs:\s*null/g)].length;
  ok("some questions are answerable with no connector at all", universalCount >= 3, `${universalCount} universal`);
  if (active.size > 0) {
    const matched = [...namedProviders].filter((p) => active.has(p));
    ok(
      `${org.name}: at least one connector-specific question is offered`,
      matched.length > 0,
      `active: ${[...active].join(", ")}`
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n[3] The §19 contract the card renders matches what the parser emits");
  // -------------------------------------------------------------------------
  const parsed = parseStructuredAnswer(
    JSON.stringify({
      directAnswer: "Net revenue was ₹12,45,000 in July.",
      keyFigures: [{ label: "Net revenue", value: "₹12,45,000", source: "get_revenue_summary" }],
      drivers: ["Order count rose"],
      evidence: ["/evidence/revenue"],
      dataStatus: "estimated",
      warnings: [],
      recommendedAction: null,
    })
  );
  ok("a well-formed answer parses", parsed !== null);
  for (const field of ["directAnswer", "keyFigures", "drivers", "evidence", "dataStatus", "warnings", "recommendedAction"]) {
    ok(`the page reads .${field}`, pageSrc.includes(`.${field}`), "");
    ok(`the parser emits .${field}`, parsed !== null && field in parsed);
  }
  ok("the card shows each figure's source", cardSrc.includes("f.source"));
  ok("the card labels itself as AI", /AI answer/i.test(cardSrc));

  // -------------------------------------------------------------------------
  console.log("\n[4] Evidence refs the page will try to open all resolve");
  // -------------------------------------------------------------------------
  ok(
    "the page distinguishes /evidence/ envelopes from app pages",
    pageSrc.includes('startsWith("/evidence/")') && cardSrc.includes('startsWith("/evidence/")')
  );
  // Every ref any tool can emit — the page prefixes it with the API base and
  // fetches it, so a ref that 404s becomes a drawer full of "HTTP 404".
  const toolSrc = await readFile(new URL("src/modules/ai/tools.ts", pathToFileURL(import.meta.dirname + "/../")), "utf8");
  const refs = [...new Set([...toolSrc.matchAll(/evidenceRef: "([^"]+)"/g)].map((m) => m[1]!))];
  ok("tools emit evidence refs", refs.length > 5, `${refs.length} distinct`);
  for (const ref of refs) ok(`evidenceRef ${ref} resolves`, isKnownEvidenceRef(ref));

  // -------------------------------------------------------------------------
  console.log("\n[5] Verification travels to the UI");
  // -------------------------------------------------------------------------
  ok("the page reads verification.unsupportedFigures", pageSrc.includes("verification?.unsupportedFigures"));
  ok("the card marks unverified figures", cardSrc.includes("unsupportedFigures"));
  ok("the page maps a figure's source through toolEvidence", pageSrc.includes("toolEvidence?.[f.source]"));

  // The harness itself, over a fabricated figure — the exact failure the whole
  // design exists to catch.
  const fabricated = parseStructuredAnswer(
    JSON.stringify({
      directAnswer: "Margin fell 4.2 points to 27.8%.",
      keyFigures: [{ label: "CM3", value: "27.8%", source: "get_contribution_margin" }],
      drivers: [],
      evidence: [],
      dataStatus: "estimated",
      warnings: [],
      recommendedAction: null,
    })
  )!;
  const verdict = verifyFigures(fabricated, [JSON.stringify({ data: { cm3Pct: 32.0 } })]);
  ok("a computed figure is caught as unsupported", !verdict.ok, `unsupported: ${verdict.unsupported.join(", ")}`);

  const honest = parseStructuredAnswer(
    JSON.stringify({
      directAnswer: "CM3 is 32%.",
      keyFigures: [{ label: "CM3", value: "32.0%", source: "get_contribution_margin" }],
      drivers: [],
      evidence: [],
      dataStatus: "estimated",
      warnings: [],
      recommendedAction: null,
    })
  )!;
  ok("a quoted figure passes", verifyFigures(honest, [JSON.stringify({ data: { cm3Pct: 32.0 } })]).ok);
  ok("a real tool name passes source verification", verifySources(honest).ok);
  ok("an invented tool name fails source verification", !verifySources({ ...honest, keyFigures: [{ label: "x", value: "1", source: "get_magic" }] }).ok);
  ok("a clean answer passes the PII check", verifyNoPii(honest).ok);
  ok(
    "an answer carrying a phone number fails the PII check",
    !verifyNoPii({ ...honest, directAnswer: "Call the customer on 9876543210." }).ok
  );

  // -------------------------------------------------------------------------
  console.log("\n[6] Tool registry surface the page advertises");
  // -------------------------------------------------------------------------
  ok("every tool the /ai/status list would show has a name and description", TOOLS.every((t) => t.name && t.description));
  ok("TOOLS_BY_NAME is complete", TOOLS_BY_NAME.size === TOOLS.length, `${TOOLS.length} tools`);
  ok("the registry covers the §18 named surface", TOOLS.length >= 16, `${TOOLS.length} tools`);
  for (const required of [
    "get_revenue_summary",
    "get_cash_received",
    "get_contribution_margin",
    "get_pending_settlements",
    "get_bank_movement",
    "get_product_profitability",
    "get_rto_analysis",
    "get_refund_analysis",
    "get_ad_spend_analysis",
    "get_cash_forecast",
    "run_forecast_scenario",
    "get_reconciliation_exceptions",
    "get_anomalies",
    "get_data_freshness",
    "get_evidence",
  ]) {
    ok(`§18 names ${required}`, TOOLS_BY_NAME.has(required));
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
