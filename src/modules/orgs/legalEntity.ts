import { prisma } from "../../lib/prisma.js";

// Onboarding doesn't yet persist a real LegalEntity (see cfo-docs/PROGRESS.md
// — the GSTIN/PAN/category form fields are still UI-only). Every connector
// row requires a legalEntityId FK though, so this creates a placeholder one
// named after the org the first time it's needed, rather than blocking
// connector setup on a form that isn't wired up yet.
export async function getOrCreateDefaultLegalEntity(organizationId: string) {
  const existing = await prisma.legalEntity.findFirst({ where: { organizationId } });
  if (existing) return existing;

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  return prisma.legalEntity.create({ data: { organizationId, name: org.name } });
}
