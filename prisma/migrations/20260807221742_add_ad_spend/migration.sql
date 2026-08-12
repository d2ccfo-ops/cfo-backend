-- CreateTable
CREATE TABLE "ad_spend" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "spendAmount" BIGINT NOT NULL,
    "impressions" INTEGER,
    "clicks" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_spend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ad_spend_organizationId_legalEntityId_idx" ON "ad_spend"("organizationId", "legalEntityId");

-- CreateIndex
CREATE INDEX "ad_spend_date_idx" ON "ad_spend"("date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_spend_connectionId_externalAccountId_date_key" ON "ad_spend"("connectionId", "externalAccountId", "date");

