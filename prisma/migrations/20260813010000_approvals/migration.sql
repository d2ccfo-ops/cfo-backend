-- P5.2 (§22): the approval engine.
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "ApprovalRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "ApprovalActionType" AS ENUM ('RECONCILIATION_WRITE_OFF', 'COST_RESTAMP', 'EXTERNAL_MESSAGE', 'OTHER');

CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actionType" "ApprovalActionType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "riskLevel" "ApprovalRiskLevel" NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" BIGINT,
    "evidence" JSONB,
    "entityType" TEXT,
    "entityId" TEXT,
    "payload" JSONB,
    "preparedBy" TEXT NOT NULL,
    "preparedByType" "ActorType" NOT NULL DEFAULT 'USER',
    "requestedBy" TEXT NOT NULL,
    "requiredRole" "MembershipRole" NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "approval_requests_organizationId_status_createdAt_idx" ON "approval_requests"("organizationId", "status", "createdAt");
CREATE INDEX "approval_requests_organizationId_entityType_entityId_idx" ON "approval_requests"("organizationId", "entityType", "entityId");
