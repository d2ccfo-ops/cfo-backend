-- CreateEnum
CREATE TYPE "SettlementLineType" AS ENUM ('PAYMENT', 'SHIPMENT_COD', 'ADJUSTMENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Provider" ADD VALUE 'BLUEDART';
ALTER TYPE "Provider" ADD VALUE 'GOKWIK';

-- AlterTable
ALTER TABLE "settlements" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'GATEWAY',
ADD COLUMN     "provider" "Provider" NOT NULL DEFAULT 'RAZORPAY';

-- CreateTable
CREATE TABLE "settlement_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "type" "SettlementLineType" NOT NULL,
    "externalReference" TEXT NOT NULL,
    "paymentId" TEXT,
    "shipmentId" TEXT,
    "grossAmount" BIGINT NOT NULL,
    "feeAmount" BIGINT NOT NULL DEFAULT 0,
    "netAmount" BIGINT NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlement_lines_organizationId_type_idx" ON "settlement_lines"("organizationId", "type");

-- CreateIndex
CREATE INDEX "settlement_lines_paymentId_idx" ON "settlement_lines"("paymentId");

-- CreateIndex
CREATE INDEX "settlement_lines_shipmentId_idx" ON "settlement_lines"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_lines_settlementId_type_externalReference_key" ON "settlement_lines"("settlementId", "type", "externalReference");

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

