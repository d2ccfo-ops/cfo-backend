-- AlterTable
ALTER TABLE "order_line_items" ADD COLUMN     "discountAmount" BIGINT,
ADD COLUMN     "refundedAmount" BIGINT,
ADD COLUMN     "refundedQuantity" INTEGER,
ADD COLUMN     "refundedTaxAmount" BIGINT,
ADD COLUMN     "taxAmount" BIGINT;

