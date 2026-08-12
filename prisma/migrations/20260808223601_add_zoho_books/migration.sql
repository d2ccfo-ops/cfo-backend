-- AlterEnum
ALTER TYPE "Provider" ADD VALUE 'ZOHO_BOOKS';

-- CreateTable
CREATE TABLE "vendor_bills" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalBillId" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "vendorRef" TEXT,
    "billDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "totalAmount" BIGINT NOT NULL,
    "balanceAmount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalExpenseId" TEXT NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL,
    "accountName" TEXT NOT NULL,
    "vendorName" TEXT,
    "description" TEXT,
    "amount" BIGINT NOT NULL,
    "taxAmount" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_bills_organizationId_dueDate_idx" ON "vendor_bills"("organizationId", "dueDate");

-- CreateIndex
CREATE INDEX "vendor_bills_organizationId_status_idx" ON "vendor_bills"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bills_connectionId_externalBillId_key" ON "vendor_bills"("connectionId", "externalBillId");

-- CreateIndex
CREATE INDEX "expenses_organizationId_expenseDate_idx" ON "expenses"("organizationId", "expenseDate");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_connectionId_externalExpenseId_key" ON "expenses"("connectionId", "externalExpenseId");

