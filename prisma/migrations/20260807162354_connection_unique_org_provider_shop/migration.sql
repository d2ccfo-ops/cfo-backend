-- CreateIndex
CREATE UNIQUE INDEX "connections_organizationId_provider_externalAccountId_key" ON "connections"("organizationId", "provider", "externalAccountId");
