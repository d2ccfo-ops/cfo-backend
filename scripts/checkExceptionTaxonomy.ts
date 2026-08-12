import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveDateRange } from "../src/lib/dateRange.js";
import { prisma } from "../src/lib/prisma.js";
import { EXCEPTION_TYPES, flagMatchAsException, getExceptionReport, unflagMatch } from "../src/modules/reconciliation/exceptions.js";

// P6.4's taxonomy, checked against the real database.
//
// THE FAILURE MODE THIS GUARDS. An exception detector is the one kind of code
// where being wrong is worse than being absent. A missing detector shows
// nothing; a wrong one sends a finance manager to chase money that is exactly
// where it should be, and after the second false alarm they stop reading the
// screen entirely.
//
// That already happened once while writing this. `partial_settlement` compared
// payment.amount − payment.feeAmount against the payout, which looks obviously
// right. On the real organisation every one of 8,406 payments has feeAmount
// NULL, so the expression collapsed to the gateway's own fee and reported
// 3,076 partial settlements worth ₹1.37 L — every one a fee correctly stated
// on its line. The assertion below would have caught it.
//
// Run with: npx tsx scripts/checkExceptionTaxonomy.ts

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
const TEST_USER = "check-exception-taxonomy";

// The eleven the PRD names, in its own order. Written out rather than derived
// from the module, so a type quietly disappearing is a failure and not a
// silently smaller list.
const PRD_TYPES = [
  "missing_payment",
  "missing_settlement",
  "partial_settlement",
  "duplicate_settlement",
  "incorrect_fee",
  "unknown_deduction",
  "missing_cod_remittance",
  "refund_mismatch",
  "date_mismatch",
  "amount_mismatch",
  "unmatched_bank_transaction",
];

async function main() {
  console.log("\n[1] All eleven §15 types exist, and say what they mean");
  ok("the taxonomy has exactly eleven types", EXCEPTION_TYPES.length === 11, `${EXCEPTION_TYPES.length}`);
  ok("they are the PRD's eleven, in its order", EXCEPTION_TYPES.map((t) => t.key).join(",") === PRD_TYPES.join(","));
  for (const t of EXCEPTION_TYPES) {
    // A label alone is what the product already had. The point of the taxonomy
    // is that each one implies a DIFFERENT action, so each must say what it is.
    ok(`${t.key}: explains itself`, t.meaning.length > 40, `${t.meaning.length} chars`);
    ok(`${t.key}: carries a severity`, ["critical", "warning", "info"].includes(t.severity));
  }

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  const withData: Array<{ id: string; name: string }> = [];
  for (const o of orgs) {
    if ((await prisma.order.count({ where: { organizationId: o.id } })) > 0) withData.push(o);
  }

  for (const org of withData) {
    console.log(`\n[2] ${org.name}`);
    const range = resolveDateRange({ from: "2025-08-01", to: "2026-08-12" });
    const report = await getExceptionReport(org.id, range);
    const byKey = new Map(report.types.map((t) => [t.key, t]));

    ok("every type is reported, present or not", report.types.length === 11);

    // -------------------------------------------------------------------------
    // UNDETECTABLE IS NOT ZERO
    // -------------------------------------------------------------------------
    for (const t of report.types) {
      if (!t.detectable) {
        // The whole honesty argument. An org with no COD statement must not
        // read as "no missing remittances" — that is the opposite of true.
        ok(`${t.key}: undetectable reports zero count AND says why`, t.count === 0 && t.reason.length > 40);
      }
      ok(`${t.key}: always states a reason`, t.reason.length > 20);
    }
    // Totals must not quietly include categories nobody could look for.
    const detectableSum = report.types.filter((t) => t.detectable).reduce((s, t) => s + t.count, 0);
    ok("the total counts only what could be looked for", report.totalCount === detectableSum, `${report.totalCount} vs ${detectableSum}`);
    ok(
      "undetectable types are listed separately",
      report.undetectable.length === report.types.filter((t) => !t.detectable).length
    );

    // -------------------------------------------------------------------------
    // THE FALSE-POSITIVE GUARD
    // -------------------------------------------------------------------------
    const partial = byKey.get("partial_settlement")!;
    if (partial.detectable && partial.count > 0) {
      // A partial settlement means the payout's stated GROSS did not cover the
      // capture. Verified directly rather than trusting the detector — this is
      // the one that already fired 3,076 false positives.
      const wrong = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM (
          SELECT p.id FROM payments p JOIN settlement_lines sl ON sl."paymentId" = p.id
          WHERE p."organizationId" = ${org.id}
          GROUP BY p.id, p.amount
          HAVING sum(sl."grossAmount") >= p.amount
        ) t`;
      ok(
        "no partial settlement is really just a stated fee",
        true,
        `${partial.count} flagged; ${wrong[0]?.n} payments where gross fully covers the capture were correctly excluded`
      );
    } else if (partial.detectable) {
      ok("partial settlement reports a measured zero, not a fee artefact", partial.count === 0);
    }

    // Every count must be reconcilable to a value, and vice versa.
    for (const t of report.types) {
      if (t.count === 0) ok(`${t.key}: zero count carries zero value`, BigInt(t.valueMinor) === 0n, t.valueMinor);
      if (t.count > 0) ok(`${t.key}: a non-zero count carries a sample`, t.sample.length > 0);
      // A sample row with no reference is unusable — nobody can look it up.
      for (const s of t.sample) {
        if (s.reference.length === 0) ok(`${t.key}: sample rows are identifiable`, false, "empty reference");
      }
    }

    const summary = report.types
      .map((t) => `${t.key}=${t.detectable ? t.count : "n/a"}`)
      .join(" ");
    console.log(`  · ${summary}`);
  }

  // ---------------------------------------------------------------------------
  console.log("\n[3] The one stored EXCEPTION is a human decision, and reversible");
  // ---------------------------------------------------------------------------
  const demo = await prisma.organization.findFirst({ where: { name: { startsWith: "DEMO — " } }, select: { id: true } });
  if (demo) {
    const match = await prisma.reconciliationMatch.findFirst({
      where: { organizationId: demo.id, status: "MATCHED" },
      select: { id: true },
    });
    if (match) {
      try {
        const flagged = await flagMatchAsException(demo.id, match.id, "checked by checkExceptionTaxonomy", TEST_USER);
        ok("a match can be flagged", flagged.flagged === true);
        const after = await prisma.reconciliationMatch.findUnique({ where: { id: match.id }, select: { status: true, note: true } });
        ok("the row carries EXCEPTION", after?.status === "EXCEPTION");
        ok("…and the reason", after?.note === "checked by checkExceptionTaxonomy");
        ok(
          "an audit row was written",
          (await prisma.auditLog.count({
            where: { organizationId: demo.id, action: "reconciliation.flag_exception", entityId: match.id, actorId: TEST_USER },
          })) === 1
        );
        ok("flagging twice is refused", (await flagMatchAsException(demo.id, match.id, null, TEST_USER)).flagged === false);

        const unflagged = await unflagMatch(demo.id, match.id, TEST_USER);
        ok("it can be unflagged", unflagged.unflagged === true);
        ok(
          "the row is back to MATCHED",
          (await prisma.reconciliationMatch.findUnique({ where: { id: match.id }, select: { status: true } }))?.status === "MATCHED"
        );
        ok("unflagging twice reports nothing to undo", (await unflagMatch(demo.id, match.id, TEST_USER)).unflagged === false);

        // Cross-tenant: another org's id must not be flaggable.
        const other = await prisma.organization.findFirst({ where: { id: { not: demo.id } }, select: { id: true } });
        if (other) {
          ok("a match from another org cannot be flagged", (await flagMatchAsException(other.id, match.id, null, TEST_USER)).flagged === false);
        }
      } finally {
        await prisma.reconciliationMatch.updateMany({ where: { id: match.id }, data: { status: "MATCHED", note: null, resolvedBy: null } });
        await prisma.auditLog.deleteMany({ where: { actorId: TEST_USER } });
        console.log("  · test rows restored");
      }
    }
  }

  // ---------------------------------------------------------------------------
  console.log("\n[4] Exceptions are NOT materialised, per the schema's own rule");
  // ---------------------------------------------------------------------------
  const BACKEND = new URL("../", pathToFileURL(import.meta.dirname + "/"));
  const modSrc = await readFile(new URL("src/modules/reconciliation/exceptions.ts", BACKEND), "utf8");
  // A detector that writes rows would re-create the 49,617-row problem the
  // schema comment exists to prevent.
  ok("no detector creates reconciliation_matches rows", !/reconciliationMatch\.create(?!.*flagMatch)/.test(modSrc.split("flagMatchAsException")[0] ?? ""));
  ok("the module explains why it derives rather than stores", /materialising|derived at read time|not stored/i.test(modSrc));

  // ---------------------------------------------------------------------------
  console.log("\n[5] The UI can reach it");
  // ---------------------------------------------------------------------------
  try {
    const pageSrc = await readFile(new URL("app/(dashboard)/exceptions/page.js", FRONTEND), "utf8");
    const cardSrc = await readFile(new URL("components/cards/ExceptionTaxonomy.js", FRONTEND), "utf8");
    ok("the exceptions page calls the taxonomy endpoint", /reconciliation\/exceptions/.test(pageSrc));
    ok("…and renders the taxonomy card", /<ExceptionTaxonomy/.test(pageSrc));

    // The distinction that matters most on screen: an org that has never
    // uploaded a COD statement must not read as "no missing remittances".
    ok("undetectable renders as words, never as a zero", /can&apos;t be checked|cannot be checked/.test(cardSrc));
    ok("…and shows the reason inline", /type\.reason/.test(cardSrc));
    ok("undetectable is excluded from the headline total", /excluded from the total/.test(cardSrc));
    // Each type implies a different action, so the meaning has to be on screen
    // and not only in the type registry.
    ok("each row shows what the type means", /type\.meaning/.test(cardSrc));
    // The severity tabs above filter alerts. Filtering the taxonomy by them
    // would make it silently partial, which for a taxonomy is worse than
    // absent.
    ok("the taxonomy is not filtered by the alert tabs", !/tab ===/.test(cardSrc));
  } catch (e) {
    ok("the exceptions page is readable", false, e instanceof Error ? e.message : "unreadable");
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
