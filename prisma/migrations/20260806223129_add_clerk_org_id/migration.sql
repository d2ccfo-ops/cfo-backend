-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "clerkOrgId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "organizations_clerkOrgId_key" ON "organizations"("clerkOrgId");

