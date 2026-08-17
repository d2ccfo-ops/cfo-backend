-- Internal observability (the /internal operations console).
--
-- Entirely additive: four nullable columns on two existing tables, and three
-- new tables. No column is dropped, no type is changed, nothing is backfilled.
-- Every existing row stays valid and every existing query keeps its plan.
--
-- The token columns on ai_daily_briefs are deliberately NULLABLE WITH NO
-- DEFAULT. A default of 0 would tell every reader that briefs written before
-- today cost nothing, when the truth is that nobody counted. NULL says
-- "unmeasured" and 0 says "measured, spent nothing" — see the schema comment.

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ai_daily_briefs"
  ADD COLUMN "inputTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER,
  ADD COLUMN "cacheReadTokens" INTEGER,
  ADD COLUMN "cacheWriteTokens" INTEGER;

-- CreateTable
CREATE TABLE "request_metrics" (
    "id" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "route" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "status2xx" INTEGER NOT NULL DEFAULT 0,
    "status3xx" INTEGER NOT NULL DEFAULT 0,
    "status4xx" INTEGER NOT NULL DEFAULT 0,
    "status5xx" INTEGER NOT NULL DEFAULT 0,
    "totalMs" INTEGER NOT NULL DEFAULT 0,
    "maxMs" INTEGER NOT NULL DEFAULT 0,
    "cacheHit" INTEGER NOT NULL DEFAULT 0,
    "cacheMiss" INTEGER NOT NULL DEFAULT 0,
    "le10" INTEGER NOT NULL DEFAULT 0,
    "le25" INTEGER NOT NULL DEFAULT 0,
    "le50" INTEGER NOT NULL DEFAULT 0,
    "le100" INTEGER NOT NULL DEFAULT 0,
    "le250" INTEGER NOT NULL DEFAULT 0,
    "le500" INTEGER NOT NULL DEFAULT 0,
    "le1000" INTEGER NOT NULL DEFAULT 0,
    "le2500" INTEGER NOT NULL DEFAULT 0,
    "le5000" INTEGER NOT NULL DEFAULT 0,
    "leInf" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "request_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_samples" (
    "id" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "load1" DOUBLE PRECISION NOT NULL,
    "load5" DOUBLE PRECISION NOT NULL,
    "load15" DOUBLE PRECISION NOT NULL,
    "cpuCount" INTEGER NOT NULL,
    "memTotal" BIGINT NOT NULL,
    "memFree" BIGINT NOT NULL,
    "diskTotal" BIGINT NOT NULL,
    "diskFree" BIGINT NOT NULL,
    "procRssBytes" BIGINT NOT NULL,
    "procHeapBytes" BIGINT NOT NULL,

    CONSTRAINT "system_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_activity_days" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_activity_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "request_metrics_bucketStart_route_method_key" ON "request_metrics"("bucketStart", "route", "method");

-- CreateIndex
CREATE INDEX "request_metrics_bucketStart_idx" ON "request_metrics"("bucketStart");

-- CreateIndex
CREATE INDEX "request_metrics_route_bucketStart_idx" ON "request_metrics"("route", "bucketStart");

-- CreateIndex
CREATE INDEX "system_samples_takenAt_idx" ON "system_samples"("takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_activity_days_organizationId_clerkUserId_day_key" ON "user_activity_days"("organizationId", "clerkUserId", "day");

-- CreateIndex
CREATE INDEX "user_activity_days_day_idx" ON "user_activity_days"("day");
