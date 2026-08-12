-- P2.1a: §17 anomaly detection storage. Applied to the development database
-- with `prisma db push` (a `migrate dev` would have required resetting a
-- database holding real merchant data); this file exists so a fresh deploy
-- reproduces the same schema.

-- CreateEnum
CREATE TYPE "AnomalyType" AS ENUM ('REVENUE_DECLINE', 'REVENUE_SPIKE', 'AD_SPEND_SPIKE', 'RTO_INCREASE', 'REFUND_INCREASE', 'COURIER_COST_INCREASE', 'NEGATIVE_MARGIN_SKU', 'MISSING_SETTLEMENT', 'DUPLICATE_PAYMENT', 'CANCELLATION_INCREASE', 'PRODUCT_COST_INCREASE', 'CASH_BELOW_THRESHOLD');

-- CreateEnum
CREATE TYPE "AnomalySeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AnomalyStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "anomalies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "AnomalyType" NOT NULL,
    "severity" "AnomalySeverity" NOT NULL,
    "observedValue" DOUBLE PRECISION NOT NULL,
    "expectedValue" DOUBLE PRECISION NOT NULL,
    "difference" DOUBLE PRECISION NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "evidence" JSONB NOT NULL,
    "recommendedInvestigation" TEXT NOT NULL,
    "ownerId" TEXT,
    "status" "AnomalyStatus" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "anomalies_dedupeKey_key" ON "anomalies"("dedupeKey");

-- CreateIndex
CREATE INDEX "anomalies_organizationId_status_idx" ON "anomalies"("organizationId", "status");

-- CreateIndex
CREATE INDEX "anomalies_organizationId_type_idx" ON "anomalies"("organizationId", "type");
