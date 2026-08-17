-- The durable half of calcCache. See src/lib/precomputedStore.ts.
-- Purely additive: one new table, no changes to any existing one.
CREATE TABLE "precomputed_responses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "precomputed_responses_pkey" PRIMARY KEY ("id")
);

-- The read path is always (organizationId, variant); the unique index serves
-- the lookup as well as enforcing one row per key.
CREATE UNIQUE INDEX "precomputed_responses_organizationId_variant_key" ON "precomputed_responses"("organizationId", "variant");

-- Invalidation deletes by organisation alone, on every observable write.
CREATE INDEX "precomputed_responses_organizationId_idx" ON "precomputed_responses"("organizationId");
