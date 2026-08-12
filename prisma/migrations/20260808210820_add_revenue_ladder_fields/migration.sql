-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "customerRef" TEXT,
ADD COLUMN     "itemsAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "paymentMode" TEXT,
ADD COLUMN     "refundedAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "shippingAmount" BIGINT NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "orders_organizationId_customerRef_idx" ON "orders"("organizationId", "customerRef");

