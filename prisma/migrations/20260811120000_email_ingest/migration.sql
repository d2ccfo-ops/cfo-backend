-- Inbound email ingestion: per-org ingest addresses and a log of every email
-- received. Applied to the development database with `prisma db push` (a
-- `migrate dev` would have required resetting a database holding real merchant
-- data); this file exists so a fresh deploy reproduces the same schema.

-- CreateEnum
CREATE TYPE "InboundEmailStatus" AS ENUM ('PROCESSED', 'PARTIAL', 'FAILED', 'EMPTY');

-- CreateTable
CREATE TABLE "email_ingest_addresses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "email_ingest_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_emails" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "addressId" TEXT NOT NULL,
    "messageId" TEXT,
    "fromAddress" TEXT,
    "subject" TEXT,
    "attachmentCount" INTEGER NOT NULL,
    "status" "InboundEmailStatus" NOT NULL,
    "outcomes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_ingest_addresses_token_key" ON "email_ingest_addresses"("token");

-- CreateIndex
CREATE INDEX "email_ingest_addresses_organizationId_idx" ON "email_ingest_addresses"("organizationId");

-- One ACTIVE address per org (partial unique — Prisma cannot express this in the
-- schema, so it lives here). Concurrent page loads that both try to create the
-- first address collide on this instead of leaving two live addresses, either
-- of which a forwarding rule might target.
CREATE UNIQUE INDEX "email_ingest_addresses_one_active_per_org" ON "email_ingest_addresses"("organizationId") WHERE "disabledAt" IS NULL;

-- CreateIndex: webhook providers retry deliveries — the same email must not import twice.
CREATE UNIQUE INDEX "inbound_emails_organizationId_messageId_key" ON "inbound_emails"("organizationId", "messageId");

-- CreateIndex
CREATE INDEX "inbound_emails_organizationId_createdAt_idx" ON "inbound_emails"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "email_ingest_addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
