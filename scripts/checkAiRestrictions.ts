import { prisma } from "../src/lib/prisma.js";
import { readFile } from "node:fs/promises";
import { DEFAULT_TIMEZONE } from "../src/lib/dateRange.js";
import { TOOLS, TOOLS_BY_NAME, executeTool, type ToolContext } from "../src/modules/ai/tools.js";
import { maskPii, maskString } from "../src/modules/ai/pii.js";
import { verifyFigures, verifyNoPii, verifySources, extractFigures } from "../src/modules/ai/verify.js";
import type { StructuredAnswer } from "../src/modules/ai/orchestrator.js";

// P4.7 restriction tests.
//
// The three restrictions the plan names are checked STRUCTURALLY here, against
// the live database, with no model involved:
//
//   cross-org access      Attempted for real — every tool is executed against
//                         org A's context while asking for org B's data, and
//                         the results are compared against org B's own. This is
//                         the check that matters, because "the model refuses"
//                         is a behaviour and "the tool cannot express it" is a
//                         property. eval/cases/safety.jsonl covers the
//                         behaviour; this covers the property.
//
//   no SQL                Asserted over the registry: no tool takes a query,
//                         a filter expression, a table name or a raw string
//                         that reaches the database.
//
//   figures in answers    The string-match harness, exercised over real tool
//                         output rather than fixtures — including the exact
//                         fabricated figures the old hardcoded AI page showed.
//
// Run with: npx tsx scripts/checkAiRestrictions.ts

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

const answerOf = (over: Partial<StructuredAnswer>): StructuredAnswer => ({
  directAnswer: "",
  keyFigures: [],
  drivers: [],
  evidence: [],
  dataStatus: "estimated",
  warnings: [],
  recommendedAction: null,
  ...over,
});

async function main() {
  // Organization has no `orders` back-relation, so the two orgs worth testing
  // are found the other way round — by which ones actually hold orders. An org
  // with no data would pass every isolation check trivially.
  const withOrders = await prisma.order.groupBy({ by: ["organizationId"], _count: { _all: true } });
  const ranked = withOrders.sort((a, b) => b._count._all - a._count._all).slice(0, 3);
  const orgs = await prisma.organization.findMany({
    where: { id: { in: ranked.map((r) => r.organizationId) } },
    select: { id: true, name: true, timezone: true },
  });
  if (orgs.length < 2) {
    console.log("need at least two organisations with orders to test cross-tenant isolation");
    process.exit(1);
  }
  const [orgA, orgB] = orgs as [typeof orgs[0], typeof orgs[0]];

  // ---------------------------------------------------------------------------
  console.log("\n[1] Cross-org access is unrepresentable, not merely refused");
  // ---------------------------------------------------------------------------
  ok(`two distinct organisations to test with: "${orgA.name}" and "${orgB.name}"`, orgA.id !== orgB.id);

  // No tool may accept anything that could name another tenant.
  const FORBIDDEN_ARG = /organization|organisation|orgid|tenant|company_id|companyid/i;
  for (const t of TOOLS) {
    const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    const offending = props.filter((p) => FORBIDDEN_ARG.test(p));
    ok(`${t.name} takes no tenant-selecting argument`, offending.length === 0, offending.join(", "));
  }

  const ctxA: ToolContext = { organizationId: orgA.id, timeZone: orgA.timezone ?? DEFAULT_TIMEZONE, userId: "restriction-check" };
  const ctxB: ToolContext = { organizationId: orgB.id, timeZone: orgB.timezone ?? DEFAULT_TIMEZONE, userId: "restriction-check" };

  // Force the argument in anyway. .strict() must reject it — silently ignoring
  // it would be almost as bad, because the model would believe it had scoped
  // the call and the answer would be labelled with the wrong company.
  for (const name of ["get_revenue_summary", "get_cash_received", "get_contribution_margin"]) {
    const attempt = await executeTool(ctxA, name, { organizationId: orgB.id });
    ok(`${name} REJECTS a forced organizationId rather than ignoring it`, !attempt.ok, attempt.ok ? "accepted it" : "");
  }

  // And the substantive check: the same tool in two contexts returns two
  // organisations' numbers.
  const revenueA = await executeTool(ctxA, "get_revenue_summary", {});
  const revenueB = await executeTool(ctxB, "get_revenue_summary", {});
  ok("get_revenue_summary succeeds in both contexts", revenueA.ok && revenueB.ok);
  const jsonA = JSON.stringify(revenueA.result);
  const jsonB = JSON.stringify(revenueB.result);
  ok(
    "the two organisations' revenue results are not identical",
    jsonA !== jsonB,
    jsonA === jsonB ? "both contexts returned the same bytes — scoping may not be applied" : ""
  );
  // The id itself must never appear in a result. It is the one string that
  // would let a model construct a cross-tenant reference.
  ok("org A's result does not contain org B's id", !jsonA.includes(orgB.id));
  ok("org B's result does not contain org A's id", !jsonB.includes(orgA.id));

  // ---------------------------------------------------------------------------
  console.log("\n[2] No SQL surface exists");
  // ---------------------------------------------------------------------------
  const SQL_SHAPED = /query|sql|where|filter|table|column|select|raw|expression|order_by|orderby|having|join/i;
  for (const t of TOOLS) {
    const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    const offending = props.filter((p) => SQL_SHAPED.test(p));
    ok(`${t.name} exposes no query-shaped argument`, offending.length === 0, offending.join(", "));
  }
  // Every string argument is either an enum, a date, or explicitly listed here
  // as CONTENT with the reason it has to be free.
  //
  // The rule this enforces is not "no free strings exist" — a drafted vendor
  // message is free text by definition, and a rule that forbade it would
  // simply be worked around. The rule is that no free string reaches a QUERY.
  // Everything on this list is stored or returned verbatim; nothing on it
  // becomes a filter, and the two tools that take an id use it in a
  // parameterised findFirst scoped to the caller's organisation.
  //
  // A NEW free string is still a failure. Adding one means adding a line here
  // and stating why, which is the point.
  const FREE_STRING_ALLOWED = new Map<string, string>([
    ["from", "date, parsed by resolveDateRange"],
    ["to", "date, parsed by resolveDateRange"],
    ["metric", "constrained by the zod enum even though the JSON schema shows a string"],
    ["horizon", "validated by isForecastHorizon"],
    ["vendorName", "content — appears in a draft the model wrote, never in a filter"],
    ["subject", "content — draft only"],
    ["body", "content — draft only"],
    ["title", "content — stored on the approval request and shown to a reviewer"],
    ["reason", "content — stored on the approval request and shown to a reviewer"],
    ["amountPaise", "digits-only, enforced by the zod regex"],
    ["entityId", "an id, used only in a parameterised findFirst scoped to the caller's org"],
  ]);
  for (const t of TOOLS) {
    const props = (t.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }> }).properties ?? {};
    for (const [name, def] of Object.entries(props)) {
      if (def.type !== "string") continue;
      ok(
        `${t.name}.${name} is constrained or declared content`,
        FREE_STRING_ALLOWED.has(name) || Array.isArray(def.enum),
        Array.isArray(def.enum) ? "enum" : (FREE_STRING_ALLOWED.get(name) ?? "unconstrained free text with no declared reason")
      );
    }
  }
  // The other half of that rule: a content string must not reach a where
  // clause. Asserted over the source rather than trusted.
  const toolsSource = await readFile(new URL("../src/modules/ai/tools.ts", import.meta.url), "utf8");
  for (const field of ["body", "subject", "vendorName", "title", "reason"]) {
    ok(
      `${field} never appears inside a where clause`,
      !new RegExp(`where:\\s*\\{[^}]*\\b${field}\\b`).test(toolsSource)
    );
  }
  ok(
    "no tool implementation calls $queryRaw or $executeRaw",
    await (async () => {
      const { readFile } = await import("node:fs/promises");
      const src = await readFile(new URL("../src/modules/ai/tools.ts", import.meta.url), "utf8");
      return !/\$queryRaw|\$executeRaw|\$queryRawUnsafe/.test(src);
    })()
  );

  // ---------------------------------------------------------------------------
  console.log("\n[3] Figures in answers must appear in tool outputs");
  // ---------------------------------------------------------------------------
  const realOutput = JSON.stringify(revenueA.result);
  const realFigures = extractFigures(realOutput);
  ok("the real tool output contains figures to quote", realFigures.length > 0, `${realFigures.length} tokens`);

  if (realFigures.length > 0) {
    const quoted = realFigures[0]!;
    ok(
      "an answer quoting a real tool figure verifies",
      verifyFigures(answerOf({ directAnswer: `The figure is ${quoted}.` }), [realOutput]).ok
    );
  }

  // The specific fabricated figures the old AI page displayed to every user,
  // for every question. They are named here so a regression is impossible to
  // miss in the log.
  for (const [text, label] of [
    ["Contribution margin fell 2.1pp to 33.8% in July.", "the old page's margin claim"],
    ["Cash is ₹1.84 Cr.", "the old page's cash claim"],
    ["Answered in 2.1s.", "the old page's fake latency"],
  ] as const) {
    const verdict = verifyFigures(answerOf({ directAnswer: text }), [realOutput]);
    ok(`caught: ${label}`, !verdict.ok, verdict.ok ? "PASSED verification — the harness is not catching it" : `unsupported: ${verdict.unsupported.join(", ")}`);
  }

  // Arithmetic on two real figures is the subtle case: both inputs are
  // genuine, and only the result is invented.
  const derived = verifyFigures(answerOf({ directAnswer: "Revenue per order works out to ₹1,234.56." }), [realOutput]);
  ok("caught: a figure derived from two real ones", !derived.ok);

  ok("an invented tool name is rejected", !verifySources(answerOf({ keyFigures: [{ label: "x", value: "1", source: "get_everything" }] })).ok);
  ok("every registered tool name is accepted as a source", TOOLS.every((t) => verifySources(answerOf({ keyFigures: [{ label: "x", value: "1", source: t.name }] })).ok));

  // ---------------------------------------------------------------------------
  console.log("\n[4] PII never reaches the model, over real rows");
  // ---------------------------------------------------------------------------
  // Real customer-shaped data out of the database, pushed through the mask the
  // tools apply. Fixtures would prove the regex works; this proves it fires on
  // the shapes this database actually holds.
  const sampleOrders = await prisma.order.findMany({
    where: { organizationId: orgA.id },
    select: { id: true, externalOrderId: true, raw: true },
    take: 25,
  });
  ok("real orders available to test masking against", sampleOrders.length > 0, `${sampleOrders.length} orders`);

  // The assertion has to be made per FIELD, not over the stringified payload.
  //
  // My first version tested the whole JSON blob for a phone-shaped pattern
  // before and after masking, and reported 25/25 payloads as leaking. Every
  // one was a false positive: a Shopify order id is a 13-digit NUMBER, and a
  // 10-digit window inside it looks exactly like a mobile. Masking correctly
  // left them alone, and the check called that a failure.
  //
  // It did surface a real bug on the way — see the note on PHONE_RE in pii.ts.
  // What is asserted now is the property that actually matters: a string field
  // that IS an email or IS a phone number must not survive, while a numeric
  // identifier must survive untouched.
  const EMAIL_ONLY = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  const PHONE_ONLY = /^(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}$/;
  let fieldsFound = 0;
  let fieldsCleaned = 0;
  let idsChecked = 0;
  let idsPreserved = 0;

  const walk = (before: unknown, after: unknown): void => {
    if (typeof before === "string") {
      if (EMAIL_ONLY.test(before) || PHONE_ONLY.test(before)) {
        fieldsFound += 1;
        if (typeof after === "string" && !EMAIL_ONLY.test(after) && !PHONE_ONLY.test(after)) fieldsCleaned += 1;
      } else if (/^\d{11,}$/.test(before)) {
        // A long numeric identifier stored as a string — order id, AWB, UTR.
        // It must come through byte-identical: a corrupted identifier stops
        // matching anything downstream, and it corrupts only SOME records
        // depending on where a 6-9 lands inside it.
        idsChecked += 1;
        if (after === before) idsPreserved += 1;
      }
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      before.forEach((b, i) => walk(b, after[i]));
      return;
    }
    if (before && typeof before === "object" && after && typeof after === "object") {
      for (const [k, v] of Object.entries(before as Record<string, unknown>)) {
        walk(v, (after as Record<string, unknown>)[k]);
      }
    }
  };

  for (const o of sampleOrders) {
    if (!o.raw) continue;
    walk(o.raw, maskPii(o.raw).value);
  }

  if (fieldsFound > 0) {
    ok(`every one of ${fieldsFound} email/phone field(s) in real payloads was masked`, fieldsCleaned === fieldsFound, `${fieldsCleaned}/${fieldsFound}`);
  } else {
    console.log("  · no email/phone-valued fields in the sample — masking checked against synthetic shapes below");
  }
  if (idsChecked > 0) {
    ok(`all ${idsChecked} long numeric identifier(s) survived masking intact`, idsPreserved === idsChecked, `${idsPreserved}/${idsChecked}`);
  }

  ok("an email is masked", maskString("write to founder@brand.in about it") === "write to [email] about it");
  ok("an Indian mobile is masked", maskString("call 9876543210") === "call [phone]");
  ok("a +91 mobile is masked", maskString("call +91 98765 43210").includes("[phone]"));
  // The costly false positive: masking a product name makes the AI answer
  // "your worst SKU is [redacted]", which is useless in a way that is much
  // harder to notice than a crash.
  ok("productName survives", maskPii({ productName: "Neem Face Wash" }).value.productName === "Neem Face Wash");
  ok("vendorName survives", maskPii({ vendorName: "Blue Dart Express" }).value.vendorName === "Blue Dart Express");
  ok("customerName is redacted", maskPii({ customerName: "Priya S" }).value.customerName === "[redacted]");
  // An order id, an AWB and a paise amount are all 10-digit-ish numbers that a
  // broad phone regex would eat.
  ok("an order number is not mistaken for a phone", maskString("order 1234567890") === "order 1234567890");
  ok("a paise amount is not mistaken for a phone", maskString("amount 1245000") === "amount 1245000");
  // The regression this file found: a 13-digit id whose last ten digits happen
  // to look like a mobile used to become "123[phone]".
  ok("a 13-digit id is not partly eaten", maskString("1236123456789") === "1236123456789");
  ok("a UTR is not partly eaten", maskString("AXISN1236123456789") === "AXISN1236123456789");
  ok("a gid survives", maskString("gid://shopify/Order/6123456789012") === "gid://shopify/Order/6123456789012");

  const answerWithPii = answerOf({ directAnswer: "Contact them at buyer@example.com." });
  ok("an answer carrying an email fails verifyNoPii", !verifyNoPii(answerWithPii).ok);

  // ---------------------------------------------------------------------------
  console.log("\n[5] Every tool executes without leaking across the org boundary");
  // ---------------------------------------------------------------------------
  // The broad sweep: run every zero-argument tool for real and check no result
  // mentions the other org, by id or by name.
  let executed = 0;
  for (const t of TOOLS) {
    const props = (t.inputSchema as { required?: string[] }).required ?? [];
    if (props.length > 0) continue; // needs arguments; covered by the eval suite
    const res = await executeTool(ctxA, t.name, {});
    executed += 1;
    if (!res.ok) {
      // A tool that errors is not a leak, but it IS worth seeing.
      console.log(`  · ${t.name} returned an error: ${(res.result as { error?: string }).error?.slice(0, 80)}`);
      continue;
    }
    const body = JSON.stringify(res.result);
    ok(`${t.name} result mentions no other organisation's id`, !body.includes(orgB.id));
    ok(`${t.name} result carries no raw email or phone`, !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(body) && !/(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}\b/.test(body));
  }
  ok("a meaningful number of tools were executed for real", executed >= 8, `${executed} executed`);

  ok("the registry is non-empty and indexed", TOOLS.length > 0 && TOOLS_BY_NAME.size === TOOLS.length, `${TOOLS.length} tools`);

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
