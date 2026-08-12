-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "productType" TEXT,
    "vendor" TEXT,
    "status" TEXT NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "externalVariantId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "inventoryQuantity" INTEGER NOT NULL DEFAULT 0,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_organizationId_legalEntityId_idx" ON "products"("organizationId", "legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "products_connectionId_externalProductId_key" ON "products"("connectionId", "externalProductId");

-- CreateIndex
CREATE INDEX "product_variants_productId_idx" ON "product_variants"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_productId_externalVariantId_key" ON "product_variants"("productId", "externalVariantId");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

