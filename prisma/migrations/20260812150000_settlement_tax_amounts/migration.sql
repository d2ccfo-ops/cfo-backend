-- P1.4: GST-on-fee ingestion. Razorpay's /payments and /settlements
-- responses already carry a `tax` field (the GST portion of `fee`) that the
-- connector fetched and silently dropped. Applied to the development
-- database with `prisma db push` (a `migrate dev` would have required
-- resetting a database holding real merchant data); this file exists so a
-- fresh deploy reproduces the same schema.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "taxAmount" BIGINT;

-- AlterTable
ALTER TABLE "settlements" ADD COLUMN "taxAmount" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "settlement_lines" ADD COLUMN "taxAmount" BIGINT NOT NULL DEFAULT 0;
