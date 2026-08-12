-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('IDLE', 'QUEUED', 'SYNCING', 'FAILED');

-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "lastSyncError" TEXT,
ADD COLUMN     "syncStatus" "SyncJobStatus" NOT NULL DEFAULT 'IDLE';
