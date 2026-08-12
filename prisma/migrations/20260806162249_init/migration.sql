-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('SHOPIFY', 'RAZORPAY', 'META_ADS', 'GOOGLE_ADS', 'SHIPROCKET', 'BANK');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "BankTxnDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "MatchType" AS ENUM ('ORDER_PAYMENT', 'PAYMENT_SETTLEMENT', 'SETTLEMENT_BANK', 'COD_REMITTANCE');

-- CreateEnum
CREATE TYPE "MatchConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'MANUAL');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('MATCHED', 'EXCEPTION', 'RESOLVED');

-- CreateEnum
CREATE TYPE "MetricGranularity" AS ENUM ('DAILY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "MetricConfidence" AS ENUM ('ESTIMATED', 'PROVISIONAL', 'RECONCILED', 'FINAL');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'AI');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_entities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "pan" TEXT,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "externalAccountId" TEXT,
    "credentialsRef" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "processingError" TEXT,

    CONSTRAINT "raw_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "grossAmount" BIGINT NOT NULL,
    "discountAmount" BIGINT NOT NULL DEFAULT 0,
    "taxAmount" BIGINT NOT NULL DEFAULT 0,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sku" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "totalAmount" BIGINT NOT NULL,
    "cogsAmount" BIGINT,

    CONSTRAINT "order_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalPaymentId" TEXT NOT NULL,
    "orderId" TEXT,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "method" TEXT,
    "status" TEXT NOT NULL,
    "feeAmount" BIGINT,
    "capturedAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalSettlementId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "feeAmount" BIGINT NOT NULL DEFAULT 0,
    "utr" TEXT,
    "status" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalTxnId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "direction" "BankTxnDirection" NOT NULL,
    "valueDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "utr" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_matches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "matchType" "MatchType" NOT NULL,
    "confidence" "MatchConfidence" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "amountDeltaAbs" BIGINT NOT NULL DEFAULT 0,
    "status" "MatchStatus" NOT NULL DEFAULT 'MATCHED',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "metricKey" TEXT NOT NULL,
    "granularity" "MetricGranularity" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "valueMinor" BIGINT,
    "valueNumeric" DOUBLE PRECISION,
    "formulaVersion" TEXT NOT NULL,
    "confidence" "MetricConfidence" NOT NULL DEFAULT 'ESTIMATED',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_entities_organizationId_idx" ON "legal_entities"("organizationId");

-- CreateIndex
CREATE INDEX "memberships_organizationId_idx" ON "memberships"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organizationId_clerkUserId_key" ON "memberships"("organizationId", "clerkUserId");

-- CreateIndex
CREATE INDEX "connections_organizationId_idx" ON "connections"("organizationId");

-- CreateIndex
CREATE INDEX "connections_legalEntityId_idx" ON "connections"("legalEntityId");

-- CreateIndex
CREATE INDEX "raw_events_organizationId_idx" ON "raw_events"("organizationId");

-- CreateIndex
CREATE INDEX "raw_events_processingStatus_idx" ON "raw_events"("processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "raw_events_connectionId_externalEventId_key" ON "raw_events"("connectionId", "externalEventId");

-- CreateIndex
CREATE INDEX "orders_organizationId_legalEntityId_idx" ON "orders"("organizationId", "legalEntityId");

-- CreateIndex
CREATE INDEX "orders_placedAt_idx" ON "orders"("placedAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_connectionId_externalOrderId_key" ON "orders"("connectionId", "externalOrderId");

-- CreateIndex
CREATE INDEX "order_line_items_orderId_idx" ON "order_line_items"("orderId");

-- CreateIndex
CREATE INDEX "payments_organizationId_legalEntityId_idx" ON "payments"("organizationId", "legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_connectionId_externalPaymentId_key" ON "payments"("connectionId", "externalPaymentId");

-- CreateIndex
CREATE INDEX "settlements_organizationId_legalEntityId_idx" ON "settlements"("organizationId", "legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_connectionId_externalSettlementId_key" ON "settlements"("connectionId", "externalSettlementId");

-- CreateIndex
CREATE INDEX "bank_transactions_organizationId_legalEntityId_idx" ON "bank_transactions"("organizationId", "legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_connectionId_externalTxnId_key" ON "bank_transactions"("connectionId", "externalTxnId");

-- CreateIndex
CREATE INDEX "reconciliation_matches_organizationId_status_idx" ON "reconciliation_matches"("organizationId", "status");

-- CreateIndex
CREATE INDEX "reconciliation_matches_sourceType_sourceId_idx" ON "reconciliation_matches"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "reconciliation_matches_targetType_targetId_idx" ON "reconciliation_matches"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "metric_snapshots_organizationId_metricKey_periodStart_idx" ON "metric_snapshots"("organizationId", "metricKey", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "metric_snapshots_organizationId_legalEntityId_metricKey_gra_key" ON "metric_snapshots"("organizationId", "legalEntityId", "metricKey", "granularity", "periodStart", "formulaVersion");

-- CreateIndex
CREATE INDEX "audit_log_organizationId_createdAt_idx" ON "audit_log"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
