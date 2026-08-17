-- Additive only: three new tables, one new enum, four indexes.
-- No ALTER and no DROP on anything that already exists, so this is safe to
-- apply ahead of the code that reads it and safe to roll the code back past.

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'APPLYING', 'APPLIED', 'FAILED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "internal_operators" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "note" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId" TEXT NOT NULL,
    "grantedByEmail" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokedByEmail" TEXT,

    CONSTRAINT "internal_operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_requests" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "fromTag" TEXT,
    "toTag" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedByUserId" TEXT NOT NULL,
    "requestedByEmail" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "agentHost" TEXT,
    "error" TEXT,

    CONSTRAINT "deployment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "host" TEXT NOT NULL,
    "tags" JSONB NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "agentVersion" TEXT,

    CONSTRAINT "deployment_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "internal_operators_clerkUserId_key" ON "internal_operators"("clerkUserId");

-- CreateIndex
CREATE INDEX "internal_operators_revokedAt_idx" ON "internal_operators"("revokedAt");

-- CreateIndex
CREATE INDEX "deployment_requests_service_requestedAt_idx" ON "deployment_requests"("service", "requestedAt");

-- CreateIndex
CREATE INDEX "deployment_requests_status_idx" ON "deployment_requests"("status");

