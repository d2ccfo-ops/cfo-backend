-- Additive only: two new tables, one new enum. No ALTER, no DROP.

-- CreateEnum
CREATE TYPE "ErrorGroupStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "error_groups" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "lastMessage" TEXT,
    "route" TEXT,
    "method" TEXT,
    "source" TEXT NOT NULL DEFAULT 'api',
    "lastStack" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "affectedOrgs" INTEGER NOT NULL DEFAULT 0,
    "status" "ErrorGroupStatus" NOT NULL DEFAULT 'NEW',
    "resolvedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "error_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_snapshots" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "gcpUsdMicro" BIGINT NOT NULL,
    "aiUsdMicro" BIGINT NOT NULL,
    "orders" INTEGER NOT NULL,
    "activeOrgs" INTEGER NOT NULL,
    "machineType" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "error_groups_fingerprint_key" ON "error_groups"("fingerprint");

-- CreateIndex
CREATE INDEX "error_groups_status_lastSeenAt_idx" ON "error_groups"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "error_groups_lastSeenAt_idx" ON "error_groups"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "cost_snapshots_month_key" ON "cost_snapshots"("month");

