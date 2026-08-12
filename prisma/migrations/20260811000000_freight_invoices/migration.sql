-- Courier freight invoices: what a courier CHARGED us to carry parcels.
-- Distinct from Settlement, which is what a courier COLLECTED and paid us.
--
-- Applied to the development database with `prisma db push` (a `migrate dev`
-- would have required resetting a database holding real merchant data). This
-- file exists so a fresh deploy reproduces the same schema.

-- AlterEnum
ALTER TYPE "MatchType" ADD VALUE 'SHIPMENT_FREIGHT';

-- CreateTable
CREATE TABLE "freight_invoices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3),
    "customerAccount" TEXT,
    "product" TEXT,
    "carrier" TEXT NOT NULL,
    "statedTotal" BIGINT,
    "grandTotal" BIGINT,
    "lineTotal" BIGINT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "fileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "freight_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "freight_invoice_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "awb" TEXT NOT NULL,
    "shipmentId" TEXT,
    "shipDate" TIMESTAMP(3) NOT NULL,
    "destination" TEXT,
    "serviceType" TEXT,
    "chargedWeightKg" DOUBLE PRECISION,
    "amount" BIGINT NOT NULL,
    "isReturnLeg" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "freight_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "freight_invoices_organizationId_carrier_idx" ON "freight_invoices"("organizationId", "carrier");

-- CreateIndex: re-uploading the same PDF must not double-count freight.
CREATE UNIQUE INDEX "freight_invoices_organizationId_invoiceNo_key" ON "freight_invoices"("organizationId", "invoiceNo");

-- CreateIndex
CREATE INDEX "freight_invoice_lines_organizationId_awb_idx" ON "freight_invoice_lines"("organizationId", "awb");

-- CreateIndex
CREATE INDEX "freight_invoice_lines_invoiceId_idx" ON "freight_invoice_lines"("invoiceId");

-- CreateIndex
CREATE INDEX "freight_invoice_lines_shipmentId_idx" ON "freight_invoice_lines"("shipmentId");

-- AddForeignKey
ALTER TABLE "freight_invoice_lines" ADD CONSTRAINT "freight_invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "freight_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
