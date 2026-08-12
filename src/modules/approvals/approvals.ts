import type { ApprovalActionType, ApprovalRiskLevel, ApprovalStatus, MembershipRole, Prisma } from "@prisma/client";
import { writeAudit } from "../../lib/audit.js";
import { prisma } from "../../lib/prisma.js";
import { formatInr } from "../calc/money.js";
import { getOrgSettings } from "../orgs/settings.js";

// §22 approval engine (P5.2).
//
// WHAT NEEDS AN APPROVAL, AND WHY THAT LIST IS SHORT.
//
// Requiring a second pair of eyes on everything trains people to click through
// without reading, and an approval nobody reads is worse than none — it
// launders a mistake into a decision two people made. So the trigger is
// materiality, not category: a ₹200 write-off is noise and a ₹4 lakh write-off
// is a decision, and the same code path handles both differently on purpose.
//
// The threshold is org-configurable (OrgSettings.approvalThresholdPaise) with a
// stated default, because "material" is a fact about the business and a
// ₹50,000 threshold is absurd at both ends of the customer range.
//
// APPROVAL EXECUTES. It does not authorise a second attempt: the payload the
// action needs is captured on the request, and approving runs it. Anything
// else means the thing that happens can differ from the thing that was
// reviewed, which is precisely what the review was for.

export const APPROVALS_VERSION = "v1";

/** Above this, a write-off is a decision rather than housekeeping. */
export const DEFAULT_MATERIALITY_PAISE = 2_500_000n; // ₹25,000

/** How long a request stands before it lapses. */
export const DEFAULT_EXPIRY_HOURS = 72;

// Risk is a function of the money and the action, and it is what decides who
// may approve. A HIGH-risk request needs an OWNER or ADMIN; MEDIUM and LOW can
// be signed off by a FINANCE_MANAGER.
const HIGH_RISK_MULTIPLE = 4n;

export interface ApprovalDecisionInput {
  organizationId: string;
  actionType: ApprovalActionType;
  title: string;
  reason: string;
  amountPaise?: bigint | null;
  evidence?: Prisma.InputJsonValue;
  entityType?: string;
  entityId?: string;
  payload?: Prisma.InputJsonValue;
  preparedBy: string;
  preparedByType?: "USER" | "AI" | "SYSTEM";
  requestedBy: string;
}

export async function getMaterialityThreshold(organizationId: string): Promise<bigint> {
  const settings = await getOrgSettings(organizationId);
  const configured = settings.approvalThresholdPaise;
  if (configured === null || configured === undefined) return DEFAULT_MATERIALITY_PAISE;
  try {
    return BigInt(configured);
  } catch {
    return DEFAULT_MATERIALITY_PAISE;
  }
}

/**
 * Does this action need an approval at all?
 *
 * Pure, so the rule can be tested without a database and so a caller can ask
 * before doing any work. Returns the reason either way — a caller that
 * proceeds without approval should be able to say why it was entitled to.
 */
export function needsApproval(
  actionType: ApprovalActionType,
  amountPaise: bigint | null,
  threshold: bigint
): { required: boolean; reason: string } {
  if (actionType === "EXTERNAL_MESSAGE") {
    // Always. Money is not the risk here — the risk is that something wrong,
    // or merely tone-deaf, leaves the company under its name. §18 requires
    // this specifically for AI-drafted messages.
    return { required: true, reason: "Anything sent outside the company is reviewed before it leaves, whatever it says." };
  }
  if (actionType === "COST_RESTAMP") {
    return {
      required: true,
      reason: "Restamping a cost changes a margin that has already been reported. §42.8 — a reported figure does not move quietly.",
    };
  }
  if (amountPaise === null) {
    return { required: false, reason: "No money moves, and this action type is not otherwise restricted." };
  }
  const magnitude = amountPaise < 0n ? -amountPaise : amountPaise;
  if (magnitude >= threshold) {
    return { required: true, reason: `${formatInr(magnitude)} is at or above the ${formatInr(threshold)} materiality threshold.` };
  }
  return { required: false, reason: `${formatInr(magnitude)} is below the ${formatInr(threshold)} materiality threshold.` };
}

export function riskLevelFor(actionType: ApprovalActionType, amountPaise: bigint | null, threshold: bigint): ApprovalRiskLevel {
  if (actionType === "EXTERNAL_MESSAGE") return "MEDIUM";
  if (actionType === "COST_RESTAMP") return "HIGH";
  if (amountPaise === null) return "LOW";
  const magnitude = amountPaise < 0n ? -amountPaise : amountPaise;
  if (magnitude >= threshold * HIGH_RISK_MULTIPLE) return "HIGH";
  if (magnitude >= threshold) return "MEDIUM";
  return "LOW";
}

export function requiredRoleFor(risk: ApprovalRiskLevel): MembershipRole {
  // HIGH needs the people who own the consequences. Everything else is the
  // finance manager's job — that is what the role is for, and routing every
  // approval to an owner is how approvals become a rubber stamp.
  return risk === "HIGH" ? "ADMIN" : "FINANCE_MANAGER";
}

const ROLE_RANK: Record<string, number> = {
  OWNER: 0,
  ADMIN: 1,
  FINANCE_MANAGER: 2,
  ACCOUNTANT: 3,
  ANALYST: 4,
  MEMBER: 4,
  VIEWER: 5,
  EXTERNAL_CA: 6,
};

/** Whether a role is at or above the one a request demands. */
export function roleSatisfies(role: MembershipRole, required: MembershipRole): boolean {
  return (ROLE_RANK[role] ?? 99) <= (ROLE_RANK[required] ?? 99);
}

export async function createApprovalRequest(input: ApprovalDecisionInput) {
  const threshold = await getMaterialityThreshold(input.organizationId);
  const amount = input.amountPaise ?? null;
  const risk = riskLevelFor(input.actionType, amount, threshold);

  const request = await prisma.approvalRequest.create({
    data: {
      organizationId: input.organizationId,
      actionType: input.actionType,
      riskLevel: risk,
      title: input.title,
      reason: input.reason,
      amount,
      evidence: input.evidence,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      preparedBy: input.preparedBy,
      preparedByType: input.preparedByType ?? "USER",
      requestedBy: input.requestedBy,
      requiredRole: requiredRoleFor(risk),
      expiresAt: new Date(Date.now() + DEFAULT_EXPIRY_HOURS * 3_600_000),
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: input.preparedByType ?? "USER",
    actorId: input.requestedBy,
    action: "approval.requested",
    entityType: "APPROVAL_REQUEST",
    entityId: request.id,
    metadata: {
      actionType: input.actionType,
      riskLevel: risk,
      amountPaise: amount?.toString() ?? null,
      requiredRole: request.requiredRole,
      target: input.entityId ?? null,
    },
  });

  return request;
}

export interface DecideResult {
  ok: boolean;
  status?: ApprovalStatus;
  error?: string;
  message?: string;
  /** Present when an approval executed the underlying action. */
  executed?: { ok: boolean; detail: string };
}

/**
 * Approve or reject.
 *
 * Every refusal path here is a rule someone would otherwise route around:
 * self-approval, acting on an already-decided request, acting after expiry,
 * acting without the role the request demands.
 */
export async function decideApproval(
  organizationId: string,
  requestId: string,
  actor: { userId: string; role: MembershipRole },
  decision: "APPROVED" | "REJECTED",
  note: string | null,
  now: Date = new Date(),
  execute?: (request: { id: string; actionType: ApprovalActionType; entityId: string | null; payload: unknown }) => Promise<{ ok: boolean; detail: string }>
): Promise<DecideResult> {
  const request = await prisma.approvalRequest.findFirst({ where: { id: requestId, organizationId } });
  // 404 semantics: a valid id from another tenant must not be confirmed.
  if (!request) return { ok: false, error: "not_found", message: "No such approval request." };

  if (request.status !== "PENDING") {
    return {
      ok: false,
      error: "already_decided",
      message: `This request is already ${request.status.toLowerCase()}${request.decidedBy ? ` (by ${request.decidedBy})` : ""}.`,
    };
  }

  if (request.expiresAt <= now) {
    // Recorded as EXPIRED rather than silently allowed. A stale request being
    // approved days later is how a figure nobody re-checked gets acted on.
    await prisma.approvalRequest.update({ where: { id: request.id }, data: { status: "EXPIRED" } });
    return {
      ok: false,
      error: "expired",
      message: `This request lapsed on ${request.expiresAt.toISOString().slice(0, 10)}. Raise it again if it still stands — the figures on it are that old.`,
    };
  }

  if (request.requestedBy === actor.userId || request.preparedBy === actor.userId) {
    return {
      ok: false,
      error: "self_approval",
      message: "You cannot approve your own request. The point of the review is that a second person looked.",
    };
  }

  if (!roleSatisfies(actor.role, request.requiredRole)) {
    return {
      ok: false,
      error: "insufficient_role",
      message: `This ${request.riskLevel.toLowerCase()}-risk request needs ${request.requiredRole} or above. Your role is ${actor.role}.`,
    };
  }

  let executed: DecideResult["executed"];
  if (decision === "APPROVED" && execute) {
    // Executed BEFORE the status flips. An approval recorded against an
    // action that then failed is the worst of both: the trail says it
    // happened and the ledger says it did not.
    executed = await execute({
      id: request.id,
      actionType: request.actionType,
      entityId: request.entityId,
      payload: request.payload,
    });
    if (!executed.ok) {
      return { ok: false, error: "execution_failed", message: executed.detail, executed };
    }
  }

  await prisma.approvalRequest.update({
    where: { id: request.id },
    data: { status: decision, decidedBy: actor.userId, decidedAt: now, decisionNote: note },
  });

  await writeAudit({
    organizationId,
    actorType: "USER",
    actorId: actor.userId,
    action: decision === "APPROVED" ? "approval.approved" : "approval.rejected",
    entityType: "APPROVAL_REQUEST",
    entityId: request.id,
    metadata: {
      actionType: request.actionType,
      riskLevel: request.riskLevel,
      amountPaise: request.amount?.toString() ?? null,
      requestedBy: request.requestedBy,
      note,
      executed: executed?.detail ?? null,
    },
  });

  return { ok: true, status: decision, executed };
}

export interface ExpirySweepResult {
  checked: number;
  expired: number;
}

/**
 * Lapse anything past its deadline.
 *
 * Runs on the notification sweep's schedule rather than its own — expiry is
 * cheap, and a request that lapsed six hours ago being marked at the next
 * sweep is materially the same as being marked at the minute. The decide path
 * checks expiry itself, so this is bookkeeping, not enforcement.
 */
export async function runApprovalExpirySweep(now: Date = new Date()): Promise<ExpirySweepResult> {
  const stale = await prisma.approvalRequest.findMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    select: { id: true, organizationId: true, title: true, actionType: true },
  });
  for (const r of stale) {
    await prisma.approvalRequest.update({ where: { id: r.id }, data: { status: "EXPIRED" } });
    await writeAudit({
      organizationId: r.organizationId,
      actorType: "SYSTEM",
      actorId: "approval-expiry-sweep",
      action: "approval.expired",
      entityType: "APPROVAL_REQUEST",
      entityId: r.id,
      metadata: { title: r.title, actionType: r.actionType },
    });
  }
  return { checked: stale.length, expired: stale.length };
}

/** Serialised for the wire. BigInt never crosses a JSON boundary. */
export function serializeApproval(r: {
  id: string;
  actionType: ApprovalActionType;
  status: ApprovalStatus;
  riskLevel: ApprovalRiskLevel;
  title: string;
  reason: string;
  amount: bigint | null;
  evidence: unknown;
  entityType: string | null;
  entityId: string | null;
  preparedBy: string;
  preparedByType: string;
  requestedBy: string;
  requiredRole: MembershipRole;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date;
  createdAt: Date;
}) {
  return {
    id: r.id,
    actionType: r.actionType,
    status: r.status,
    riskLevel: r.riskLevel,
    title: r.title,
    reason: r.reason,
    amountPaise: r.amount?.toString() ?? null,
    amountLabel: r.amount === null ? null : formatInr(r.amount < 0n ? -r.amount : r.amount),
    evidence: r.evidence ?? null,
    entityType: r.entityType,
    entityId: r.entityId,
    preparedBy: r.preparedBy,
    // Surfaced, not buried: "a model wrote this" is a fact a reviewer is
    // entitled to before they sign it.
    preparedByAi: r.preparedByType === "AI",
    requestedBy: r.requestedBy,
    requiredRole: r.requiredRole,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}
