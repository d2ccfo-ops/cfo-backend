-- P5.5 (§26/§31): per-run sync history.
CREATE TYPE "SyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'EMPTY');
CREATE TYPE "SyncTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'REPAIR', 'BACKFILL');

CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "trigger" "SyncTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "status" "SyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "recordsFetched" INTEGER,
    "recordsWritten" INTEGER,
    "cursor" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sync_runs_organizationId_startedAt_idx" ON "sync_runs"("organizationId", "startedAt");
CREATE INDEX "sync_runs_connectionId_startedAt_idx" ON "sync_runs"("connectionId", "startedAt");

ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
