-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('NEW', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_INITIATED', 'RTO_DELIVERED', 'CANCELLED', 'LOST', 'UNKNOWN');

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalShipmentId" TEXT NOT NULL,
    "orderId" TEXT,
    "awbCode" TEXT,
    "courierName" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "freightAmount" BIGINT,
    "codAmount" BIGINT,
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipments_organizationId_legalEntityId_idx" ON "shipments"("organizationId", "legalEntityId");

-- CreateIndex
CREATE INDEX "shipments_awbCode_idx" ON "shipments"("awbCode");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_connectionId_externalShipmentId_key" ON "shipments"("connectionId", "externalShipmentId");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

