import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { RECURRING_CADENCES, RECURRING_OUTFLOW_CATEGORIES } from "../calc/recurringOutflows.js";

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
const MAX_RECURRING_OUTFLOWS = 50;
const MAX_DIGEST_RECIPIENTS = 10;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

// The cadence fields are deliberately validated per-cadence rather than left
// all-optional: a MONTHLY entry with no dayOfMonth would silently default to
// the 1st, and a founder who meant the 25th would see rent leaving three weeks
// early with nothing anywhere saying so. An entry that cannot say WHEN it is
// paid is not a schedule, and the whole point of P2.2e is the date.
const recurringOutflowSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(80),
    category: z.enum(RECURRING_OUTFLOW_CATEGORIES),
    // Strictly positive. A zero-rupee salary line is not a schedule entry, it
    // is a row someone forgot to fill in, and it would sit in the UI looking
    // configured while contributing nothing.
    amountPaise: z.string().regex(/^[1-9]\d*$/, "must be a positive integer string"),
    cadence: z.enum(RECURRING_CADENCES),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    month: z.number().int().min(1).max(12).optional(),
    startDay: z.string().regex(DAY_KEY, "must be YYYY-MM-DD").optional(),
    endDay: z.string().regex(DAY_KEY, "must be YYYY-MM-DD").optional(),
  })
  .strict()
  .refine((e) => e.cadence !== "WEEKLY" || e.weekday !== undefined, {
    message: "weekly entries need a weekday",
    path: ["weekday"],
  })
  .refine((e) => e.cadence === "WEEKLY" || e.dayOfMonth !== undefined, {
    message: "monthly, quarterly and annual entries need a dayOfMonth",
    path: ["dayOfMonth"],
  })
  .refine((e) => (e.cadence !== "ANNUAL" && e.cadence !== "QUARTERLY") || e.month !== undefined, {
    message: "annual and quarterly entries need a month to anchor the cycle to",
    path: ["month"],
  })
  .refine((e) => !e.startDay || !e.endDay || e.startDay <= e.endDay, {
    message: "endDay must be on or after startDay",
    path: ["endDay"],
  });

export const orgSettingsSchema = z
  .object({
    // Below this, the cash.below_threshold anomaly rule fires (P2.1b). Paise,
    // as a string — the same wire convention every other money value in this
    // API already uses. null explicitly unsets it (no threshold configured,
    // not zero).
    cashThresholdPaise: z.string().regex(/^\d+$/, "must be a non-negative integer string").nullable(),

    // P3.3. Which digests this organisation wants, and where they go.
    // Recipients are explicit rather than "everyone in the org": a digest
    // carries the whole cash position, and membership is not the same question
    // as who should receive that by email.
    notificationDigest: z
      .object({
        daily: z.boolean(),
        weekly: z.boolean(),
        recipients: z.array(z.string().email()).max(MAX_DIGEST_RECIPIENTS),
      })
      .strict()
      .nullable(),

    // P5.3 (§20.14). The month the financial year starts in, 1-12. An Indian
    // company reports April-March, and a report that silently used the
    // calendar year would put Q4 in the wrong year for every customer this
    // product is built for. Stored as a number rather than a date because it
    // is a recurring boundary, not an instant.
    fiscalYearStartMonth: z.number().int().min(1).max(12).nullable(),

    // P5.2 (§22). Above this, an action stops being housekeeping and becomes
    // a decision that needs a second pair of eyes. Configurable because
    // "material" is a fact about the business — a ₹25,000 default is right
    // for a brand doing ₹2 Cr a year and absurd at either end of that range.
    // null means "use the default"; it is not zero.
    approvalThresholdPaise: z.string().regex(/^\d+$/, "must be a non-negative integer string").nullable(),

    // P2.2e. The fixed costs that leave on a DATE rather than as a rate —
    // payroll, rent, EMI, subscriptions, advance tax. Stored here rather than
    // as a table because it is configuration a founder types once, not
    // ingested records: a handful of rows per org, edited by hand, with no
    // relations and nothing to join against.
    recurringOutflows: z
      .array(recurringOutflowSchema)
      // Bounded because this is user-writable JSON on the organisation row.
      // Fifty covers every fixed cost a D2C brand actually has; more than that
      // is someone using the settings column as a table.
      .max(MAX_RECURRING_OUTFLOWS)
      // Two entries sharing an id would make the UI unable to tell which one an
      // edit refers to, and the forecast would still count both — so it is a
      // rejection, not a silent de-duplication.
      .refine((v) => new Set(v.map((e) => e.id)).size === v.length, "recurringOutflows ids must be unique")
      .nullable(),
  })
  .partial()
  .strict();

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export async function getOrgSettings(organizationId: string): Promise<OrgSettings> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return (org?.settings as OrgSettings | null) ?? {};
}
