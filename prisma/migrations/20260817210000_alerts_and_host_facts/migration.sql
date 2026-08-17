-- Additive only: one new table, one new enum, one nullable column, two indexes.
-- Safe to apply ahead of the code that reads it, and safe to roll code back past.

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('PAGE', 'WARN', 'INFO');

-- AlterTable
ALTER TABLE "deployment_state" ADD COLUMN     "facts" JSONB;

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenCount" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "acknowledgedReason" TEXT,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alerts_key_key" ON "alerts"("key");

-- CreateIndex
CREATE INDEX "alerts_resolvedAt_severity_idx" ON "alerts"("resolvedAt", "severity");

-- CreateIndex
CREATE INDEX "alerts_lastSeenAt_idx" ON "alerts"("lastSeenAt");

