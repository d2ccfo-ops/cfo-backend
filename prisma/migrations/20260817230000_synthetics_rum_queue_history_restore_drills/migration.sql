-- The outside view, the browser's view, queue depth over time, proof the backup
-- restores, and a small key/value table for the console's own periodic work.
--
-- Every table here is new; nothing existing is altered, so this migration is
-- additive and safe to apply to a live database.

-- CreateTable
CREATE TABLE "synthetic_checks" (
    "id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "statusCode" INTEGER,
    "ms" INTEGER,
    "error" TEXT,
    "tlsDaysRemaining" INTEGER,

    CONSTRAINT "synthetic_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "synthetic_checks_target_at_idx" ON "synthetic_checks"("target", "at");

-- CreateIndex
CREATE INDEX "synthetic_checks_at_idx" ON "synthetic_checks"("at");

-- CreateTable
CREATE TABLE "client_metrics" (
    "id" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "route" TEXT NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "lcpSum" INTEGER NOT NULL DEFAULT 0,
    "lcpCount" INTEGER NOT NULL DEFAULT 0,
    "lcpGood" INTEGER NOT NULL DEFAULT 0,
    "lcpNeedsWork" INTEGER NOT NULL DEFAULT 0,
    "lcpPoor" INTEGER NOT NULL DEFAULT 0,
    "inpSum" INTEGER NOT NULL DEFAULT 0,
    "inpCount" INTEGER NOT NULL DEFAULT 0,
    "clsSumMilli" INTEGER NOT NULL DEFAULT 0,
    "clsCount" INTEGER NOT NULL DEFAULT 0,
    "ttfbSum" INTEGER NOT NULL DEFAULT 0,
    "ttfbCount" INTEGER NOT NULL DEFAULT 0,
    "fcpSum" INTEGER NOT NULL DEFAULT 0,
    "fcpCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "client_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_metrics_bucketStart_route_key" ON "client_metrics"("bucketStart", "route");

-- CreateIndex
CREATE INDEX "client_metrics_bucketStart_idx" ON "client_metrics"("bucketStart");

-- CreateTable
CREATE TABLE "queue_depth_samples" (
    "id" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "queue" TEXT NOT NULL,
    "waiting" INTEGER NOT NULL DEFAULT 0,
    "active" INTEGER NOT NULL DEFAULT 0,
    "delayed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "paused" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "queue_depth_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "queue_depth_samples_bucketStart_queue_key" ON "queue_depth_samples"("bucketStart", "queue");

-- CreateIndex
CREATE INDEX "queue_depth_samples_bucketStart_idx" ON "queue_depth_samples"("bucketStart");

-- CreateTable
CREATE TABLE "restore_drills" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "backupObject" TEXT,
    "backupBytes" BIGINT,
    "tables" INTEGER,
    "orders" INTEGER,
    "organizations" INTEGER,
    "durationMs" INTEGER,
    "error" TEXT,
    "agentVersion" TEXT,

    CONSTRAINT "restore_drills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restore_drills_at_idx" ON "restore_drills"("at");

-- CreateTable
CREATE TABLE "internal_ops_state" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_ops_state_pkey" PRIMARY KEY ("key")
);
