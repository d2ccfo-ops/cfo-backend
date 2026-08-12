-- AlterEnum
ALTER TYPE "Provider" ADD VALUE 'BANK_AA';

-- CreateTable
CREATE TABLE "bank_aa_data_sessions" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_aa_data_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_aa_data_sessions_connectionId_idx" ON "bank_aa_data_sessions"("connectionId");

