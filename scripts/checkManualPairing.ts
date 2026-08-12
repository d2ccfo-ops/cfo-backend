import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { runReconciliation } from "../src/modules/calc/reconciliation.js";
import { getPairCandidates, pairOrderToPayment, unpairOrder } from "../src/modules/reconciliation/manualMatch.js";

// P6.3, exercised end to end against the DEMO organisation and rolled back.
//
// The property worth the most here is SURVIVAL. A manual pairing that the next
// nightly run silently overrules is worse than no pairing feature at all: the
// person who made the decision has no way to know it was undone, and the row
// goes back to reading as missing money. That is asserted by actually running
// the engine after pairing and re-reading what the page would show.
//
// Everything this writes is removed before it exits, including on the failure
// path — a check script that leaves a fabricated match behind in a database
// holding real orders would be doing the exact thing this project forbids.
//
// Run with: npx tsx scripts/checkManualPairing.ts

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
const TEST_USER = "check-manual-pairing";

async function cleanup(organizationId: string, orderIds: string[]) {
  await prisma.reconciliationMatch.deleteMany({
    where: { organizationId, sourceId: { in: orderIds }, confidence: "MANUAL" },
  });
  await prisma.auditLog.deleteMany({ where: { organizationId, actorId: TEST_USER } });
}

async function main() {
  const demo = await prisma.organization.findFirst({
    where: { name: { startsWith: "DEMO — " } },
    select: { id: true, name: true },
  });
  if (!demo) {
    console.log("no DEMO organisation — skipping (this check never touches a real org)");
    await prisma.$disconnect();
    return;
  }
  const org = demo.id;
  console.log(`\ntarget: ${demo.name}\n`);

  // Two orders that carry no payment, and one payment nothing has claimed.
  const orders = await prisma.order.findMany({
    where: { organizationId: org, cancelledAt: null, payments: { none: {} } },
    select: { id: true, grossAmount: true, externalOrderId: true, placedAt: true },
    take: 2,
  });
  const payment = await prisma.payment.findFirst({
    where: {
      organizationId: org,
      status: "captured",
      // Not already the target of a match, so pairing it is a clean test.
      id: {
        notIn: (
          await prisma.reconciliationMatch.findMany({
            where: { organizationId: org, targetType: "PAYMENT", targetId: { not: null } },
            select: { targetId: true },
            take: 5000,
          })
        )
          .map((m) => m.targetId)
          .filter((id): id is string => id !== null),
      },
    },
    select: { id: true, amount: true, externalPaymentId: true },
  });

  if (orders.length < 2 || !payment) {
    console.log(`  insufficient demo data (orders=${orders.length}, payment=${payment ? "yes" : "no"}) — skipping`);
    await prisma.$disconnect();
    return;
  }
  const [orderA, orderB] = orders as [(typeof orders)[number], (typeof orders)[number]];
  const orderIds = [orderA.id, orderB.id];

  try {
    // -------------------------------------------------------------------------
    console.log("[1] Candidates are offered, and claimed money is not");
    // -------------------------------------------------------------------------
    const cand = await getPairCandidates(org, orderA.id);
    ok("candidates come back for a real order", cand !== null);
    ok("the window is stated, not implied", (cand?.windowDays ?? 0) > 0, `${cand?.windowDays} days`);
    ok("each candidate states its difference from the order", (cand?.candidates ?? []).every((c) => typeof c.differencePaise === "bigint"));
    ok("an unknown order returns null rather than an empty list", (await getPairCandidates(org, "does-not-exist")) === null);

    // -------------------------------------------------------------------------
    console.log("\n[2] Pairing writes a MANUAL match and an audit row");
    // -------------------------------------------------------------------------
    const result = await pairOrderToPayment(org, orderA.id, payment.id, "checked by checkManualPairing", TEST_USER);
    ok("the pairing succeeds", result.ok === true, result.ok ? "" : result.reason);
    if (!result.ok) throw new Error("cannot continue without a pairing");

    const stored = await prisma.reconciliationMatch.findUnique({ where: { id: result.matchId } });
    ok("confidence is MANUAL", stored?.confidence === "MANUAL");
    ok("status is MATCHED", stored?.status === "MATCHED");
    ok("it points at the payment", stored?.targetId === payment.id && stored?.targetType === "PAYMENT");
    ok("the delta is absolute", (stored?.amountDeltaAbs ?? -1n) >= 0n, `${stored?.amountDeltaAbs}`);
    ok(
      "the delta equals |order − payment|",
      stored?.amountDeltaAbs ===
        (orderA.grossAmount - payment.amount < 0n ? payment.amount - orderA.grossAmount : orderA.grossAmount - payment.amount)
    );
    ok("the note is kept", stored?.note === "checked by checkManualPairing");

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: org, action: "reconciliation.pair", entityId: orderA.id, actorId: TEST_USER },
    });
    ok("an audit row was written", audit !== null);
    const meta = (audit?.metadata ?? {}) as Record<string, unknown>;
    // The trail has to answer "was this reasonable", not just "did it happen".
    ok("the audit captures both amounts as they stood", typeof meta.orderAmountPaise === "string" && typeof meta.paymentAmountPaise === "string");
    ok("…and the difference", typeof meta.differencePaise === "string", String(meta.differencePaise));

    // -------------------------------------------------------------------------
    console.log("\n[3] One payment cannot settle two orders");
    // -------------------------------------------------------------------------
    const second = await pairOrderToPayment(org, orderB.id, payment.id, null, TEST_USER);
    ok("a second order pairing the same payment is refused", second.ok === false);
    if (!second.ok) {
      ok("the refusal is specifically about double-claiming", second.reason === "payment_already_matched", second.reason);
      if (second.reason === "payment_already_matched") {
        // Naming the other order is the difference between a usable error and
        // a scavenger hunt through the table.
        ok("it names the conflicting order", second.conflictingOrderId === orderA.id);
      }
    }
    ok(
      "the refused order got no match row",
      (await prisma.reconciliationMatch.count({ where: { organizationId: org, sourceId: orderB.id, confidence: "MANUAL" } })) === 0
    );

    // -------------------------------------------------------------------------
    console.log("\n[4] THE ONE THAT MATTERS: a re-run does not overrule a human");
    // -------------------------------------------------------------------------
    await runReconciliation(org);
    const afterRun = await prisma.reconciliationMatch.findUnique({ where: { id: result.matchId } });
    ok("the manual row still exists after a full reconciliation run", afterRun !== null);

    // Read it the way the page reads it — through the same ordering rule, not
    // by fetching the row we know the id of. If the ordering were still
    // createdAt-only, an engine row created by that run would win here.
    const asPageReads = await prisma.$queryRaw<Array<{ id: string; confidence: string }>>`
      SELECT rm.id, rm.confidence::text AS confidence
      FROM reconciliation_matches rm
      WHERE rm."sourceType" = 'ORDER' AND rm."sourceId" = ${orderA.id} AND rm."matchType" = 'ORDER_PAYMENT'
      ORDER BY (rm.confidence = 'MANUAL') DESC, rm."createdAt" DESC
      LIMIT 1`;
    ok("the row the page shows is the manual one", asPageReads[0]?.confidence === "MANUAL", asPageReads[0]?.confidence ?? "none");
    ok("…and it is the same row that was created", asPageReads[0]?.id === result.matchId);

    // -------------------------------------------------------------------------
    console.log("\n[5] Unpairing removes the decision and audits that too");
    // -------------------------------------------------------------------------
    const undone = await unpairOrder(org, orderA.id, TEST_USER);
    ok("unpair reports success", undone.unpaired === true);
    ok(
      "the manual row is gone",
      (await prisma.reconciliationMatch.count({ where: { organizationId: org, sourceId: orderA.id, confidence: "MANUAL", targetId: { not: null } } })) === 0
    );
    ok(
      "an unpair audit row exists",
      (await prisma.auditLog.count({ where: { organizationId: org, action: "reconciliation.unpair", entityId: orderA.id, actorId: TEST_USER } })) === 1
    );
    ok("unpairing again reports nothing to undo", (await unpairOrder(org, orderA.id, TEST_USER)).unpaired === false);

    // A write-off is also MANUAL, with a null target. Unpair must not touch it —
    // that path deletes the decision without the audit trail /restore writes.
    const writeOff = await prisma.reconciliationMatch.create({
      data: {
        organizationId: org,
        matchType: "ORDER_PAYMENT",
        confidence: "MANUAL",
        sourceType: "ORDER",
        sourceId: orderB.id,
        targetType: null,
        targetId: null,
        amountDeltaAbs: orderB.grossAmount,
        status: "RESOLVED",
        resolvedBy: TEST_USER,
      },
    });
    ok("unpair refuses to touch a write-off", (await unpairOrder(org, orderB.id, TEST_USER)).unpaired === false);
    ok("the write-off survives", (await prisma.reconciliationMatch.count({ where: { id: writeOff.id } })) === 1);
    await prisma.reconciliationMatch.delete({ where: { id: writeOff.id } });

    // -------------------------------------------------------------------------
    console.log("\n[6] Cross-tenant ids read as not-found, never as actionable");
    // -------------------------------------------------------------------------
    const otherOrg = await prisma.organization.findFirst({ where: { id: { not: org } }, select: { id: true } });
    if (otherOrg) {
      const foreign = await pairOrderToPayment(otherOrg.id, orderA.id, payment.id, null, TEST_USER);
      ok("an order from another org is not found", foreign.ok === false && foreign.reason === "order_not_found");
    }

    // -------------------------------------------------------------------------
    console.log("\n[7] The ordering rule is in BOTH readers, not just one");
    // -------------------------------------------------------------------------
    // Asserted against source: the leg counts and the row list are separate
    // queries, and a manual pairing that changes one but not the other would
    // make the summary card disagree with the table under it.
    const BACKEND = new URL("../", pathToFileURL(import.meta.dirname + "/"));
    const routeSrc = await readFile(new URL("src/routes/reconciliation.ts", BACKEND), "utf8");
    const calcSrc = await readFile(new URL("src/modules/calc/reconciliation.ts", BACKEND), "utf8");
    const RULE = /ORDER BY \(rm\.confidence = 'MANUAL'\) DESC/;
    ok("the items list prefers a manual match", RULE.test(routeSrc));
    ok("the leg aggregate prefers a manual match", RULE.test(calcSrc));

    // -------------------------------------------------------------------------
    console.log("\n[8] The UI can actually reach it");
    // -------------------------------------------------------------------------
    try {
      const pageSrc = await readFile(new URL("app/(dashboard)/reconciliation/page.js", FRONTEND), "utf8");
      // The pairing calls live in the dialog, which is where they belong; the
      // page owns only the unpair action and the dialog's open state. Both
      // files are read so this cannot pass on an import alone.
      const dialogSrc = await readFile(new URL("components/ui/PairDialog.js", FRONTEND), "utf8");
      const tableSrc = await readFile(new URL("components/tables/ReconciliationTable.js", FRONTEND), "utf8");

      ok("the dialog loads candidates from the server", /pair-candidates/.test(dialogSrc));
      ok("…and posts the pairing", /\/pair["`]/.test(dialogSrc) || /\/pair`/.test(dialogSrc));
      ok("the page renders the dialog", /<PairDialog/.test(pageSrc));
      ok("the page calls unpair", /\/unpair/.test(pageSrc));
      ok("the table offers both actions", /onPair\?\./.test(tableSrc) && /onUnpair\?\./.test(tableSrc));
      // Pairing must be offered BEFORE write-off. An unmatched order is far
      // more often a payment the engine could not connect than money that will
      // never arrive, and putting write-off first makes destroying the
      // receivable the path of least resistance.
      ok(
        "pairing is offered before write-off",
        tableSrc.indexOf("onPair?.") < tableSrc.indexOf("onWriteOff?.")
      );
      // A candidate row without its difference invites pairing on date
      // proximity alone, which is exactly the wrong basis.
      ok("candidates show how far off the amount is", /differencePaise/.test(dialogSrc));
    } catch (e) {
      ok("the frontend pairing files are readable", false, e instanceof Error ? e.message : "unreadable");
    }
  } finally {
    // Always, including after a thrown assertion.
    await cleanup(org, orderIds);
    console.log("\n  · test rows removed");
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
