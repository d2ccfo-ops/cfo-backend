-- AlterTable
ALTER TABLE "legal_entities" ADD COLUMN     "primaryChannel" TEXT,
ADD COLUMN     "revenueRange" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "reconciliation_matches" ADD COLUMN     "note" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "targetType" DROP NOT NULL,
ALTER COLUMN "targetId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "reconciliation_matches_organizationId_matchType_idx" ON "reconciliation_matches"("organizationId", "matchType");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_matches_matchType_sourceType_sourceId_target_key" ON "reconciliation_matches"("matchType", "sourceType", "sourceId", "targetType", "targetId");

