import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireUser } from "../middleware/auth.js";

export const legalEntitiesRouter = Router();

// The legal entity is the GST-registered company the numbers belong to — not
// the Clerk workspace, which is just a login boundary. A single workspace can
// legitimately hold more than one (a brand that bills through two companies),
// which is why every financial row already carries `legalEntityId` and why
// this is a collection rather than three columns on Organization.
//
// Until now these fields were collected in onboarding and thrown away.

// ---------------------------------------------------------------------------
// Bounded vocabularies
// ---------------------------------------------------------------------------
// Free text here would be worse than useless: the entire reason to capture
// category and revenue band is to group this org against others, and you
// cannot group "Beauty & personal care" with "beauty/personal-care". The
// backend owns the lists and serves them at GET /legal-entities/options, so
// the onboarding form renders from the same source that validates it — a
// dropdown option that the API would reject cannot exist.

export const CATEGORIES = [
  "Beauty & personal care",
  "Food & beverage",
  "Apparel & fashion",
  "Home & living",
  "Electronics",
  "Health & wellness",
  "Jewellery & accessories",
  "Other",
] as const;

export const REVENUE_RANGES = [
  "Under ₹10L",
  "₹10L – ₹50L",
  "₹50L – ₹1Cr",
  "₹1Cr – ₹5Cr",
  "₹5Cr+",
] as const;

export const PRIMARY_CHANNELS = [
  "Own website (Shopify)",
  "Amazon",
  "Flipkart",
  "Myntra",
  "Quick commerce",
  "Omnichannel",
] as const;

// ---------------------------------------------------------------------------
// GSTIN / PAN
// ---------------------------------------------------------------------------
// Both are checked structurally, not just for length. A malformed GSTIN is not
// a cosmetic problem — it is the identifier every GST return, e-invoice and
// input-credit claim is filed against, and it is far cheaper to reject a typo
// at entry than to discover it at filing.

// Positions 1-2 state code, 3-12 the PAN, 13 entity number for that state,
// 14 is 'Z' for all normal taxpayers, 15 a checksum character.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// State/UT codes actually issued (01–38), plus 97 (Other Territory) and
// 99 (Centre Jurisdiction). 00 and anything above 38 that isn't 97/99 is not a
// real jurisdiction, so a GSTIN carrying one is a typo by construction.
const GST_STATE_CODES = new Set<string>([
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")),
  "97",
  "99",
]);

// GSTIN's checksum: weight each of the first 14 characters alternately 1 and 2
// over base-36, sum the quotient and remainder of each product, and the check
// character is whatever completes the sum to a multiple of 36. This is the
// check that catches a transposed pair of digits — a format regex will not.
const GSTIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function gstinChecksumValid(gstin: string): boolean {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = GSTIN_ALPHABET.indexOf(gstin[i]!);
    if (value < 0) return false;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const expected = GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
  return expected === gstin[14];
}

// Empty string and null both mean "not provided" — an onboarding form that
// leaves GSTIN blank must not be rejected, and must not store "" either, or
// "has a GSTIN" becomes untestable.
const optionalUpper = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim().toUpperCase())
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional();

const profileShape = {
  name: z.string().trim().min(1, "name is required").max(200),
  gstin: optionalUpper(15),
  pan: optionalUpper(10),
  category: z.enum(CATEGORIES).nullable().optional(),
  revenueRange: z.enum(REVENUE_RANGES).nullable().optional(),
  primaryChannel: z.enum(PRIMARY_CHANNELS).nullable().optional(),
};

// The cross-field rules, applied to whatever subset of fields is present.
// Kept separate from the shape so create (all fields) and patch (any subset)
// can share exactly one definition of what "valid" means.
function refineProfile<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .superRefine((val: { gstin?: string | null; pan?: string | null }, ctx: z.RefinementCtx) => {
      const { gstin, pan } = val;

      if (gstin) {
        if (!GSTIN_RE.test(gstin)) {
          ctx.addIssue({ code: "custom", path: ["gstin"], message: "GSTIN must be 15 characters, e.g. 29AACCA1234M1Z5" });
        } else if (!GST_STATE_CODES.has(gstin.slice(0, 2))) {
          ctx.addIssue({ code: "custom", path: ["gstin"], message: `${gstin.slice(0, 2)} is not a valid GST state code` });
        } else if (!gstinChecksumValid(gstin)) {
          ctx.addIssue({ code: "custom", path: ["gstin"], message: "GSTIN checksum failed — check for a mistyped character" });
        }
      }

      if (pan && !PAN_RE.test(pan)) {
        ctx.addIssue({ code: "custom", path: ["pan"], message: "PAN must be 10 characters, e.g. AACCA1234M" });
      }

      // Characters 3-12 of a GSTIN ARE the PAN. If both were supplied and they
      // disagree, one of them is wrong and we cannot tell which — so neither is
      // stored rather than silently keeping a pair that can never both be true.
      if (gstin && pan && GSTIN_RE.test(gstin) && PAN_RE.test(pan) && gstin.slice(2, 12) !== pan) {
        ctx.addIssue({
          code: "custom",
          path: ["pan"],
          message: `PAN does not match the PAN embedded in the GSTIN (${gstin.slice(2, 12)})`,
        });
      }
    });
}

const createSchema = refineProfile(z.object(profileShape));
const patchSchema = refineProfile(
  z.object({ ...profileShape, name: profileShape.name.optional() }).refine(
    (v) => Object.keys(v).length > 0,
    "at least one field must be provided"
  )
);

// Validation runs in SYNCHRONOUS middleware for the same reason as
// routes/preferences.ts and lib/dateRange.ts: on Express 4 a throw inside an
// async handler never reaches middleware/errorHandler.ts — it becomes an
// unhandled rejection and the request hangs until the client times out.
interface ParsedEntity {
  create?: z.infer<typeof createSchema>;
  patch?: z.infer<typeof patchSchema>;
}
function parsedOn(req: Request): ParsedEntity {
  const r = req as Request & { parsedEntity?: ParsedEntity };
  r.parsedEntity ??= {};
  return r.parsedEntity;
}

function parseCreate(req: Request, _res: Response, next: NextFunction) {
  try {
    parsedOn(req).create = createSchema.parse(req.body);
    next();
  } catch (err) {
    next(err);
  }
}

function parsePatch(req: Request, _res: Response, next: NextFunction) {
  try {
    parsedOn(req).patch = patchSchema.parse(req.body);
    next();
  } catch (err) {
    next(err);
  }
}

const SELECT = {
  id: true,
  name: true,
  gstin: true,
  pan: true,
  category: true,
  revenueRange: true,
  primaryChannel: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Served to the onboarding and settings forms so their dropdowns cannot drift
// from what this file will accept. Deliberately org-free: onboarding renders
// this form BEFORE the user has created an organisation, so requiring an org
// here would make the page unfillable at exactly the moment it is needed.
legalEntitiesRouter.get("/options", ...requireUser, (_req, res) => {
  res.json({
    categories: CATEGORIES,
    revenueRanges: REVENUE_RANGES,
    primaryChannels: PRIMARY_CHANNELS,
  });
});

legalEntitiesRouter.get("/", ...requireAuth, async (req, res) => {
  const entities = await prisma.legalEntity.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: { createdAt: "asc" },
    select: SELECT,
  });
  res.json({ legalEntities: entities });
});

legalEntitiesRouter.post("/", ...requireAuth, parseCreate, async (req, res) => {
  const body = parsedOn(req).create!;
  const entity = await prisma.legalEntity.create({
    data: { organizationId: req.auth!.organizationId, ...body },
    select: SELECT,
  });
  res.status(201).json({ legalEntity: entity });
});

// What onboarding calls. An UPSERT rather than a create, because
// modules/orgs/legalEntity.ts's getOrCreateDefaultLegalEntity may already have
// materialised a placeholder entity named after the workspace — a connector
// row cannot exist without one. If onboarding POSTed blindly, the org would
// end up with two entities and every financial row pointing at the empty one.
//
// "Primary" is the oldest entity, matching that placeholder, and matching what
// getOrCreateDefaultLegalEntity itself returns (findFirst, no ordering, but
// there is exactly one when it matters).
legalEntitiesRouter.put("/primary", ...requireAuth, parseCreate, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const body = parsedOn(req).create!;

  const existing = await prisma.legalEntity.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const entity = existing
    ? await prisma.legalEntity.update({ where: { id: existing.id }, data: body, select: SELECT })
    : await prisma.legalEntity.create({ data: { organizationId, ...body }, select: SELECT });

  res.status(existing ? 200 : 201).json({ legalEntity: entity, created: !existing });
});

legalEntitiesRouter.patch("/:id", ...requireAuth, parsePatch, async (req, res) => {
  const organizationId = req.auth!.organizationId;

  // Scoped by org in the WHERE, not checked after the fetch — an id belonging
  // to another tenant must read as "not found", never as "forbidden", and must
  // never be updatable by guessing a cuid.
  const { count } = await prisma.legalEntity.updateMany({
    where: { id: req.params.id, organizationId },
    data: parsedOn(req).patch!,
  });
  if (count === 0) {
    res.status(404).json({ error: "legal_entity_not_found" });
    return;
  }

  const entity = await prisma.legalEntity.findUnique({ where: { id: req.params.id }, select: SELECT });
  res.json({ legalEntity: entity });
});
