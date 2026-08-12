-- P6.6 — campaign-grain ad spend (§14).
--
-- Additive only. A separate table rather than columns on ad_spend, because a
-- campaign row is a finer grain of the SAME fact: sharing a table would let the
-- advertising cost layer (which sums ad_spend.spendAmount) silently double the
-- moment a campaign pull landed beside an account pull for the same day.
CREATE TABLE "ad_campaign_spend" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT,
    "channel" TEXT,
    "spendAmount" BIGINT NOT NULL,
    "impressions" INTEGER,
    "clicks" INTEGER,
    "conversions" INTEGER,
    "attributedRevenue" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_campaign_spend_pkey" PRIMARY KEY ("id")
);

-- Re-importing the same day's campaign export must update in place, not stack.
CREATE UNIQUE INDEX "ad_campaign_spend_connectionId_externalAccountId_campaignId_date_key"
    ON "ad_campaign_spend"("connectionId", "externalAccountId", "campaignId", "date");
CREATE INDEX "ad_campaign_spend_organizationId_legalEntityId_idx" ON "ad_campaign_spend"("organizationId", "legalEntityId");
CREATE INDEX "ad_campaign_spend_organizationId_date_idx" ON "ad_campaign_spend"("organizationId", "date");
CREATE INDEX "ad_campaign_spend_campaignId_idx" ON "ad_campaign_spend"("campaignId");
