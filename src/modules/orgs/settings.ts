import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

// P2.0: org-wide settings — as opposed to DashboardLayout (per-USER, follows
// a person across devices), this follows the ORGANIZATION, because a
// cash-alert threshold or a fiscal-year start is a fact about the business,
// not about whoever happens to be logged in.
//
// This schema is the actual source of truth for which settings exist —
// Organization.settings is an untyped JSON column with none of its own. A
// new setting is a key added here, not a migration: the known consumers land
// on separate, later plan items (cashThresholdPaise for P2.1b's anomaly rule
// now; notification-digest and recurring-outflow settings for P3.3/P2.2e
// later), and this is shared by routes/preferences.ts (read/write, with
// validation) and every calc module that only needs to read.
export const orgSettingsSchema = z
  .object({
    // Below this, the cash.below_threshold anomaly rule fires (P2.1b). Paise,
    // as a string — the same wire convention every other money value in this
    // API already uses. null explicitly unsets it (no threshold configured,
    // not zero).
    cashThresholdPaise: z.string().regex(/^\d+$/, "must be a non-negative integer string").nullable(),
  })
  .partial()
  .strict();

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export async function getOrgSettings(organizationId: string): Promise<OrgSettings> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return (org?.settings as OrgSettings | null) ?? {};
}
