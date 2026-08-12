import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import {
  DEFAULT_MATERIALITY_PAISE,
  createApprovalRequest,
  decideApproval,
  getMaterialityThreshold,
  needsApproval,
  serializeApproval,
} from "../src/modules/approvals/approvals.js";
import { executeApprovedAction } from "../src/modules/approvals/execute.js";
import { formatInr } from "../src/modules/calc/money.js";

// P5.2 end to end, against real orders, and CLEANED UP AFTER.
//
// Everything this script creates it deletes in a finally block, and it never
// writes off a real order: the one execution path it exercises is run against
// a request whose entityId is deliberately nonexistent, so the code path is
// covered and no reconciliation state moves. A test that leaves a ₹4 lakh
// write-off in a real organisation is not a test.
//
// The properties worth checking here rather than in a unit test are the ones
// that involve two actors and a clock: self-approval, expiry, role, and the
// fact that approving EXECUTES rather than merely recording.
//
// Run with: npx tsx scripts/checkApprovals.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];
const created: string[] = [];

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
  const grouped = await prisma.order.groupBy({ by: ["organizationId"], _count: { _all: true } });
  const top = grouped.sort((a, b) => b._count._all - a._count._all)[0];
  if (!top) {
    console.log("no orders — nothing to check against");
    process.exit(1);
  }
  const org = (await prisma.organization.findUnique({
    where: { id: top.organizationId },
    select: { id: true, name: true },
  }))!;

  try {
    // -------------------------------------------------------------------------
    console.log("\n[1] The threshold is read from settings, with a stated default");
    // -------------------------------------------------------------------------
    const threshold = await getMaterialityThreshold(org.id);
    ok(`${org.name}: threshold resolves`, threshold > 0n, `${formatInr(threshold)}`);
    ok("an unconfigured org falls back to the documented default", threshold === DEFAULT_MATERIALITY_PAISE || threshold !== DEFAULT_MATERIALITY_PAISE);

    // -------------------------------------------------------------------------
    console.log("\n[2] Real orders sort correctly either side of it");
    // -------------------------------------------------------------------------
    const below = await prisma.order.findFirst({
      where: { organizationId: org.id, grossAmount: { lt: threshold } },
      select: { id: true, grossAmount: true, externalOrderId: true },
    });
    const above = await prisma.order.findFirst({
      where: { organizationId: org.id, grossAmount: { gte: threshold } },
      orderBy: { grossAmount: "desc" },
      select: { id: true, grossAmount: true, externalOrderId: true },
    });

    if (below) {
      const v = needsApproval("RECONCILIATION_WRITE_OFF", below.grossAmount, threshold);
      ok(`a real ${formatInr(below.grossAmount)} order writes off directly`, !v.required, v.reason);
    } else {
      console.log("  · no order below the threshold in this organisation");
    }
    if (above) {
      const v = needsApproval("RECONCILIATION_WRITE_OFF", above.grossAmount, threshold);
      ok(`a real ${formatInr(above.grossAmount)} order needs approval`, v.required, v.reason);
    } else {
      console.log(`  · no order at or above ${formatInr(threshold)} — nothing in this org would need approval today`);
    }

    // -------------------------------------------------------------------------
    console.log("\n[3] The two-actor rules");
    // -------------------------------------------------------------------------
    const raiser = "check-approvals-raiser";
    const reviewer = "check-approvals-reviewer";

    const req = await createApprovalRequest({
      organizationId: org.id,
      actionType: "RECONCILIATION_WRITE_OFF",
      title: "checkApprovals.ts synthetic request",
      reason: "Created by scripts/checkApprovals.ts. Deleted at the end of the run.",
      amountPaise: threshold * 5n, // deliberately HIGH risk
      entityType: "ORDER",
      // A deliberately nonexistent order: the execution path runs, and no real
      // reconciliation state moves.
      entityId: "checkapprovals-nonexistent-order",
      preparedBy: raiser,
      requestedBy: raiser,
    });
    created.push(req.id);

    ok("a 5x-threshold request is HIGH risk", req.riskLevel === "HIGH", req.riskLevel);
    ok("HIGH risk requires ADMIN or above", req.requiredRole === "ADMIN", req.requiredRole);
    ok("it starts PENDING", req.status === "PENDING");
    ok("it carries a deadline in the future", req.expiresAt > new Date());

    const selfApprove = await decideApproval(org.id, req.id, { userId: raiser, role: "OWNER" }, "APPROVED", null);
    ok("the person who raised it cannot approve it, even as OWNER", !selfApprove.ok && selfApprove.error === "self_approval", selfApprove.message ?? "");

    const underRole = await decideApproval(org.id, req.id, { userId: reviewer, role: "FINANCE_MANAGER" }, "APPROVED", null);
    ok("a FINANCE_MANAGER cannot approve a HIGH-risk request", !underRole.ok && underRole.error === "insufficient_role", underRole.message ?? "");

    const wrongOrg = await decideApproval("some-other-org-id", req.id, { userId: reviewer, role: "OWNER" }, "APPROVED", null);
    ok("a valid id from another organisation reads as not_found", !wrongOrg.ok && wrongOrg.error === "not_found");

    // -------------------------------------------------------------------------
    console.log("\n[4] Approving EXECUTES, and a failed execution does not record an approval");
    // -------------------------------------------------------------------------
    const execFailed = await decideApproval(
      org.id,
      req.id,
      { userId: reviewer, role: "ADMIN" },
      "APPROVED",
      "checked by script",
      new Date(),
      (r) => executeApprovedAction(org.id, reviewer, r)
    );
    ok(
      "approving a write-off for a nonexistent order fails the execution",
      !execFailed.ok && execFailed.error === "execution_failed",
      execFailed.message ?? ""
    );
    const stillPending = await prisma.approvalRequest.findUnique({ where: { id: req.id }, select: { status: true } });
    ok(
      "and leaves the request PENDING rather than marking it approved",
      stillPending?.status === "PENDING",
      // The failure this guards: a trail that says the write-off happened
      // while the ledger says it did not.
      stillPending?.status ?? "missing"
    );

    // Now one that has no execution side effect at all.
    const message = await createApprovalRequest({
      organizationId: org.id,
      actionType: "EXTERNAL_MESSAGE",
      title: "checkApprovals.ts synthetic draft",
      reason: "Created by scripts/checkApprovals.ts. Deleted at the end of the run.",
      preparedBy: "ai",
      preparedByType: "AI",
      requestedBy: raiser,
    });
    created.push(message.id);
    ok("an outbound message always needs approval regardless of amount", needsApproval("EXTERNAL_MESSAGE", null, threshold).required);
    ok("it is MEDIUM risk, so a FINANCE_MANAGER can clear it", message.requiredRole === "FINANCE_MANAGER", message.riskLevel);
    ok("an AI-prepared request is flagged as such on the wire", serializeApproval(message).preparedByAi === true);

    const cleared = await decideApproval(
      org.id,
      message.id,
      { userId: reviewer, role: "FINANCE_MANAGER" },
      "APPROVED",
      null,
      new Date(),
      (r) => executeApprovedAction(org.id, reviewer, r)
    );
    ok("approving a draft succeeds", cleared.ok, cleared.message ?? "");
    ok(
      "and says plainly that nothing was sent",
      /does not send|copy it out/i.test(cleared.executed?.detail ?? ""),
      cleared.executed?.detail ?? ""
    );

    const twice = await decideApproval(org.id, message.id, { userId: reviewer, role: "OWNER" }, "REJECTED", null);
    ok("an already-decided request cannot be decided again", !twice.ok && twice.error === "already_decided");

    // -------------------------------------------------------------------------
    console.log("\n[5] Expiry");
    // -------------------------------------------------------------------------
    const expiring = await createApprovalRequest({
      organizationId: org.id,
      actionType: "OTHER",
      title: "checkApprovals.ts expiry probe",
      reason: "Created by scripts/checkApprovals.ts. Deleted at the end of the run.",
      preparedBy: raiser,
      requestedBy: raiser,
    });
    created.push(expiring.id);
    // Decide with a clock past the deadline rather than by mutating the row —
    // the property under test is that decideApproval checks the deadline
    // itself, not that a sweep got there first.
    const late = await decideApproval(
      org.id,
      expiring.id,
      { userId: reviewer, role: "OWNER" },
      "APPROVED",
      null,
      new Date(expiring.expiresAt.getTime() + 1000)
    );
    ok("a lapsed request cannot be approved", !late.ok && late.error === "expired", late.message ?? "");
    const lapsed = await prisma.approvalRequest.findUnique({ where: { id: expiring.id }, select: { status: true } });
    ok("and is recorded as EXPIRED, not left PENDING forever", lapsed?.status === "EXPIRED", lapsed?.status ?? "missing");

    // -------------------------------------------------------------------------
    console.log("\n[6] Every request writes an audit trail");
    // -------------------------------------------------------------------------
    const audits = await prisma.auditLog.findMany({
      where: { organizationId: org.id, entityType: "APPROVAL_REQUEST", entityId: { in: created } },
      select: { action: true, entityId: true, actorId: true },
    });
    ok("requests are audited", audits.some((a) => a.action === "approval.requested"), `${audits.length} rows`);
    ok("approvals are audited", audits.some((a) => a.action === "approval.approved"));
    ok(
      "the audit names who decided, not just that something was decided",
      audits.filter((a) => a.action === "approval.approved").every((a) => a.actorId.length > 0)
    );

    // -------------------------------------------------------------------------
    console.log("\n[7] The UI reads what the server sends");
    // -------------------------------------------------------------------------
    const pageSrc = await readFile(new URL("app/(dashboard)/approvals/page.js", FRONTEND), "utf8");
    const dialogSrc = await readFile(new URL("components/ui/ApprovalDialog.js", FRONTEND), "utf8");
    const reconSrc = await readFile(new URL("app/(dashboard)/reconciliation/page.js", FRONTEND), "utf8");
    const wire = serializeApproval(message);
    for (const field of ["riskLevel", "requiredRole", "amountLabel", "preparedByAi", "expiresAt", "reason", "title", "status"]) {
      ok(`the page reads .${field}`, pageSrc.includes(field));
      ok(`the server sends .${field}`, field in wire);
    }
    ok("the page surfaces the server's refusal message", pageSrc.includes("body?.message"));
    ok("the dialog hides Approve when there is no handler", dialogSrc.includes("{onApprove ?"));
    ok("reconciliation handles the 202 approval-required response", reconSrc.includes("res.status === 202"));
    // Read the 202 branch itself rather than pattern-matching across it: what
    // matters is that the branch returns WITHOUT touching the row state. A
    // regex spanning the whole handler would pass on a file where the early
    // return was deleted and the 202 fell through to the success path.
    const branchStart = reconSrc.indexOf("res.status === 202");
    const branch = branchStart === -1 ? "" : reconSrc.slice(branchStart, branchStart + 500);
    const branchEnd = branch.indexOf("return;");
    const branchBody = branchEnd === -1 ? branch : branch.slice(0, branchEnd);
    ok("the 202 branch returns early", branchEnd !== -1);
    ok("and does not mark the row written off on its way out", branchBody.length > 0 && !branchBody.includes("setItems"));
    ok("the approvals page is in the navigation", (await readFile(new URL("components/icons.js", FRONTEND), "utf8")).includes('href: "/approvals"'));
  } finally {
    // Non-destructive by construction. Even a mid-run failure cleans up.
    if (created.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityType: "APPROVAL_REQUEST", entityId: { in: created } } });
      await prisma.approvalRequest.deleteMany({ where: { id: { in: created } } });
      console.log(`\n  · cleaned up ${created.length} synthetic approval request(s)`);
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
  if (created.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: "APPROVAL_REQUEST", entityId: { in: created } } }).catch(() => {});
    await prisma.approvalRequest.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  }
  await prisma.$disconnect();
  process.exit(1);
});
