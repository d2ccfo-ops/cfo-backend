import type { ApprovalActionType } from "@prisma/client";
import { writeAudit } from "../../lib/audit.js";
import { prisma } from "../../lib/prisma.js";

// What an APPROVED request actually does.
//
// Kept in its own module, away from both the engine and the routes, because
// this is the only place in the approval flow that changes anything else. The
// engine decides whether an approval is valid; this performs the thing that
// was approved.
//
// THE RULE: execute from the PAYLOAD stored on the request, never from the
// request body of the approval call. The payload was captured when the request
// was raised and is what the reviewer read. Re-deriving it at approval time
// would mean the action that happens can differ from the action that was
// reviewed — which is precisely what the review existed to prevent.

export interface ExecutionResult {
  ok: boolean;
  detail: string;
}

export async function executeApprovedAction(
  organizationId: string,
  actorId: string,
  request: { id: string; actionType: ApprovalActionType; entityId: string | null; payload: unknown }
): Promise<ExecutionResult> {
  switch (request.actionType) {
    case "RECONCILIATION_WRITE_OFF":
      return writeOff(organizationId, actorId, request);

    case "EXTERNAL_MESSAGE":
      // Deliberately not sent. §18: an AI-drafted message is draft-only, and
      // nothing in this system has an outbound channel to a counterparty.
      // Approving it marks the text as cleared for a human to send — which is
      // an honest thing to record, and much better than a "sent" the recipient
      // never received.
      return {
        ok: true,
        detail:
          "Approved. The draft is cleared to send — CFOOS does not send messages to counterparties itself, so copy it out and send it from your own mailbox.",
      };

    case "COST_RESTAMP":
      // The restamp endpoint exists (POST /costs/restamp) and does real work
      // with its own validation. Wiring approval to invoke it would mean
      // duplicating that validation here or exporting a half-route; neither
      // is worth it while there is exactly one caller. Recorded honestly:
      // approval CLEARS the restamp, the operator runs it.
      return {
        ok: true,
        detail: "Approved. Run the restamp from the Costs page — this clears it, it does not perform it.",
      };

    case "OTHER":
      return { ok: true, detail: "Approved. This request type carries no automatic action." };

    default:
      return { ok: false, detail: `No execution path for ${request.actionType}.` };
  }
}

async function writeOff(
  organizationId: string,
  actorId: string,
  request: { id: string; entityId: string | null; payload: unknown }
): Promise<ExecutionResult> {
  const orderId = request.entityId;
  if (!orderId) return { ok: false, detail: "The request does not name an order to write off." };

  const order = await prisma.order.findFirst({
    where: { id: orderId, organizationId },
    select: { id: true, grossAmount: true },
  });
  if (!order) return { ok: false, detail: "That order no longer exists in this organisation." };

  const note = typeof (request.payload as { note?: unknown } | null)?.note === "string"
    ? ((request.payload as { note: string }).note).slice(0, 500)
    : null;

  const existing = await prisma.reconciliationMatch.findFirst({
    where: { organizationId, matchType: "ORDER_PAYMENT", sourceType: "ORDER", sourceId: orderId },
    select: { id: true },
  });

  const data = {
    status: "RESOLVED" as const,
    confidence: "MANUAL" as const,
    note,
    resolvedBy: actorId,
    resolvedAt: new Date(),
  };

  if (existing) await prisma.reconciliationMatch.update({ where: { id: existing.id }, data });
  else
    await prisma.reconciliationMatch.create({
      data: {
        organizationId,
        matchType: "ORDER_PAYMENT",
        sourceType: "ORDER",
        sourceId: orderId,
        targetType: null,
        targetId: null,
        amountDeltaAbs: order.grossAmount,
        ...data,
      },
    });

  await writeAudit({
    organizationId,
    actorType: "USER",
    actorId,
    action: "reconciliation.write_off",
    entityType: "ORDER",
    entityId: orderId,
    metadata: {
      note,
      amountPaise: order.grossAmount.toString(),
      // The link back to the approval. Without it the audit trail shows a
      // write-off with no sign of the review that permitted it, which is the
      // same thing an unapproved write-off looks like.
      viaApprovalRequest: request.id,
    },
  });

  return { ok: true, detail: `Written off ${order.grossAmount.toString()} paise against order ${orderId}.` };
}
