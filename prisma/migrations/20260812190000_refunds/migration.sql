-- P2.3a-pre: dated, individually-identified refunds.
--
-- Order.refundedAmount stays exactly as it is. It is a cumulative per-order
-- total, which is enough to reduce revenue and not enough to reconcile: a
-- gateway refund line names a date, an amount and an id, and a cumulative
-- total has none of those. This table is the discrete record on our side.

-- CreateEnum value: §15 leg 6
ALTER TYPE "MatchType" ADD VALUE IF NOT EXISTS 'REFUND_PAYMENT';

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "connectionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalRefundId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "processedAt" TIMESTAMP(3) NOT NULL,
    "gateway" TEXT,
    "gatewayRef" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- One row per provider refund transaction, so re-ingesting an order updates
-- rather than duplicating.
CREATE UNIQUE INDEX "refunds_connectionId_externalRefundId_key" ON "refunds"("connectionId", "externalRefundId");

-- The reconciliation window is cut on processedAt, per org.
CREATE INDEX "refunds_organizationId_processedAt_idx" ON "refunds"("organizationId", "processedAt");
CREATE INDEX "refunds_orderId_idx" ON "refunds"("orderId");

-- Cascade: a refund cannot outlive the order it was issued against.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
