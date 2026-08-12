import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  createApprovalRequest,
  decideApproval,
  getMaterialityThreshold,
  needsApproval,
  serializeApproval,
} from "../modules/approvals/approvals.js";
import { executeApprovedAction } from "../modules/approvals/execute.js";
import { formatInr } from "../modules/calc/money.js";

// §22 transport. The engine decides; this carries.

export const approvalsRouter = Router();

approvalsRouter.get("/", ...requireAuth, async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "PENDING";
  const valid = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED", "ALL"];
  if (!valid.includes(status)) {
    res.status(400).json({ error: "bad_status", message: `status must be one of ${valid.join(", ")}.` });
    return;
  }

  const [rows, threshold, pendingCount] = await Promise.all([
    prisma.approvalRequest.findMany({
      where: { organizationId: req.auth!.organizationId, ...(status === "ALL" ? {} : { status: status as never }) },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 100,
    }),
    getMaterialityThreshold(req.auth!.organizationId),
    prisma.approvalRequest.count({ where: { organizationId: req.auth!.organizationId, status: "PENDING" } }),
  ]);

  res.json({
    approvals: rows.map(serializeApproval),
    pendingCount,
    thresholdPaise: threshold.toString(),
    thresholdLabel: formatInr(threshold),
    // So the UI can render a request as read-only for someone who cannot act
    // on it, rather than offering a button that 403s.
    yourRole: req.auth!.role,
    yourUserId: req.auth!.userId,
  });
});

const createSchema = z
  .object({
    actionType: z.enum(["RECONCILIATION_WRITE_OFF", "COST_RESTAMP", "EXTERNAL_MESSAGE", "OTHER"]),
    title: z.string().min(3).max(200),
    reason: z.string().min(3).max(1000),
    amountPaise: z.string().regex(/^-?\d+$/).optional(),
    entityType: z.string().max(64).optional(),
    entityId: z.string().max(64).optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

approvalsRouter.post("/", ...requireAuth, async (req, res, next) => {
  let parsed: z.infer<typeof createSchema>;
  try {
    parsed = createSchema.parse(req.body ?? {});
  } catch (err) {
    next(err);
    return;
  }

  const request = await createApprovalRequest({
    organizationId: req.auth!.organizationId,
    actionType: parsed.actionType,
    title: parsed.title,
    reason: parsed.reason,
    amountPaise: parsed.amountPaise === undefined ? null : BigInt(parsed.amountPaise),
    entityType: parsed.entityType,
    entityId: parsed.entityId,
    evidence: parsed.evidence as never,
    payload: parsed.payload as never,
    preparedBy: req.auth!.userId,
    requestedBy: req.auth!.userId,
  });

  res.status(201).json(serializeApproval(request));
});

const decideSchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    note: z.string().max(1000).optional(),
  })
  .strict();

approvalsRouter.post("/:id/decide", ...requireAuth, async (req, res, next) => {
  let parsed: z.infer<typeof decideSchema>;
  try {
    parsed = decideSchema.parse(req.body ?? {});
  } catch (err) {
    next(err);
    return;
  }

  const result = await decideApproval(
    req.auth!.organizationId,
    req.params.id!,
    { userId: req.auth!.userId, role: req.auth!.role },
    parsed.decision,
    parsed.note ?? null,
    new Date(),
    // Approving EXECUTES. The payload is on the request, captured when it was
    // raised — so what happens is what was reviewed, not a second attempt at
    // it against whatever the data says now.
    (r) => executeApprovedAction(req.auth!.organizationId, req.auth!.userId, r)
  );

  if (!result.ok) {
    const code =
      result.error === "not_found"
        ? 404
        : result.error === "insufficient_role" || result.error === "self_approval"
          ? 403
          : result.error === "execution_failed"
            ? 500
            : 409;
    res.status(code).json({ error: result.error, message: result.message });
    return;
  }

  res.json({ status: result.status, executed: result.executed ?? null });
});

approvalsRouter.post("/:id/cancel", ...requireAuth, async (req, res) => {
  const request = await prisma.approvalRequest.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
    select: { id: true, status: true, requestedBy: true },
  });
  if (!request) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (request.status !== "PENDING") {
    res.status(409).json({ error: "already_decided", message: `This request is already ${request.status.toLowerCase()}.` });
    return;
  }
  // Only the person who raised it may withdraw it. Anyone else with the
  // authority to make it go away should REJECT it, which is a decision that
  // leaves a record of who made it.
  if (request.requestedBy !== req.auth!.userId) {
    res.status(403).json({
      error: "not_yours",
      message: "Only whoever raised this can withdraw it. If you have the authority to stop it, reject it instead — that leaves a record.",
    });
    return;
  }
  await prisma.approvalRequest.update({ where: { id: request.id }, data: { status: "CANCELLED" } });
  res.json({ status: "CANCELLED" });
});

// "Would this need an approval?" — asked by the UI BEFORE it offers a button,
// so a write-off dialog can say "this will need sign-off" instead of the user
// discovering it after typing a justification.
approvalsRouter.get("/preview", ...requireAuth, async (req, res) => {
  const actionType = typeof req.query.actionType === "string" ? req.query.actionType : "OTHER";
  const raw = typeof req.query.amountPaise === "string" ? req.query.amountPaise : null;
  const threshold = await getMaterialityThreshold(req.auth!.organizationId);
  let amount: bigint | null = null;
  if (raw !== null) {
    try {
      amount = BigInt(raw);
    } catch {
      res.status(400).json({ error: "bad_amount" });
      return;
    }
  }
  const verdict = needsApproval(actionType as never, amount, threshold);
  res.json({ ...verdict, thresholdPaise: threshold.toString(), thresholdLabel: formatInr(threshold) });
});
