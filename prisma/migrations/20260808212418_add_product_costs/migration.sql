-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('SHOPIFY', 'MANUAL', 'CSV_IMPORT', 'ESTIMATED');

-- CreateTable
CREATE TABLE "product_costs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "variantId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "purchaseCost" BIGINT NOT NULL,
    "inboundFreight" BIGINT NOT NULL DEFAULT 0,
    "importDuty" BIGINT NOT NULL DEFAULT 0,
    "otherCost" BIGINT NOT NULL DEFAULT 0,
    "landedCost" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "source" "CostSource" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "product_costs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_costs_organizationId_sku_effectiveFrom_idx" ON "product_costs"("organizationId", "sku", "effectiveFrom");

-- CreateIndex
CREATE INDEX "product_costs_variantId_idx" ON "product_costs"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_costs_organizationId_sku_effectiveFrom_key" ON "product_costs"("organizationId", "sku", "effectiveFrom");

