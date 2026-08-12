import { Router, type NextFunction, type Request, type Response } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { getOrgSettings, type OrgSettings, orgSettingsSchema } from "../modules/orgs/settings.js";

export const preferencesRouter = Router();

// Only pages that actually have a card grid. An open string would let a client
// fill the table with junk rows that nothing ever reads or cleans up.
const PAGES = ["overview"] as const;

// Card identities are the metric labels the frontend uses as its identity key
// (see components/ui/MetricCard and the Overview's METRICS_RAW). Bounded on
// both length and count: this is user-writable storage, and unbounded arrays of
// unbounded strings are how a preferences table becomes a place to stash data.
const MAX_CARDS = 40;
const MAX_LABEL_LENGTH = 120;

const pageSchema = z.enum(PAGES);

const layoutBodySchema = z.object({
  page: pageSchema,
  cardOrder: z
    .array(z.string().min(1).max(MAX_LABEL_LENGTH))
    .max(MAX_CARDS)
    // A duplicate would render two cards with the same React key and make
    // reordering behave unpredictably, so it is rejected rather than silently
    // de-duplicated — a client sending one has a bug worth surfacing.
    .refine((v) => new Set(v).size === v.length, "cardOrder must not contain duplicates"),
});

// Validation lives in SYNCHRONOUS middleware for the same reason lib/dateRange.ts
// does it: on Express 4 a throw inside an async handler never reaches
// middleware/errorHandler.ts — it becomes an unhandled rejection and the request
// hangs until the client times out.
function parseLayoutBody(req: Request, _res: Response, next: NextFunction) {
  try {
    parsedOn(req).layout = layoutBodySchema.parse(req.body);
    next();
  } catch (err) {
    next(err);
  }
}

function parsePageQuery(req: Request, _res: Response, next: NextFunction) {
  try {
    parsedOn(req).page = pageSchema.parse(req.query.page ?? "overview");
    next();
  } catch (err) {
    next(err);
  }
}

// P2.0: org-wide settings — everything above this point is per-USER
// (DashboardLayout follows a person across devices); this follows the
// ORGANIZATION instead. Schema lives in modules/orgs/settings.ts, shared with
// every calc module that only needs to read a setting (starting with P2.1b's
// cash-threshold anomaly rule).
//
// OWNER/ADMIN-writable is the intended gate once P5.1 (RBAC) lands. Until
// then, per the plan, any authenticated member of the org may read and write
// — same interim posture `/dashboard-layout` above never needed because it's
// scoped to one user already.
function parseOrgSettingsBody(req: Request, _res: Response, next: NextFunction) {
  try {
    parsedOn(req).orgSettings = orgSettingsSchema.parse(req.body);
    next();
  } catch (err) {
    next(err);
  }
}

// Lets the parsed values ride on the request without widening the global
// Express type for something only these routes use.
interface ParsedPrefs {
  layout?: z.infer<typeof layoutBodySchema>;
  page?: (typeof PAGES)[number];
  orgSettings?: OrgSettings;
}
function parsedOn(req: Request): ParsedPrefs {
  const r = req as Request & { parsedPrefs?: ParsedPrefs };
  r.parsedPrefs ??= {};
  return r.parsedPrefs;
}

// Returns null when the user has never customised the page, which the client
// reads as "use the built-in default set". Deliberately not returning the
// default order here: the catalogue of available cards lives in the frontend,
// and duplicating it server-side would give two places to update.
preferencesRouter.get("/dashboard-layout", ...requireAuth, parsePageQuery, async (req, res) => {
  const page = parsedOn(req).page!;
  const row = await prisma.dashboardLayout.findUnique({
    where: {
      organizationId_userId_page: {
        organizationId: req.auth!.organizationId,
        userId: req.auth!.userId,
        page,
      },
    },
    select: { cardOrder: true, updatedAt: true },
  });

  res.json({
    page,
    cardOrder: row?.cardOrder ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  });
});

preferencesRouter.put("/dashboard-layout", ...requireAuth, parseLayoutBody, async (req, res) => {
  const { page, cardOrder } = parsedOn(req).layout!;
  const row = await prisma.dashboardLayout.upsert({
    where: {
      organizationId_userId_page: {
        organizationId: req.auth!.organizationId,
        userId: req.auth!.userId,
        page,
      },
    },
    create: {
      organizationId: req.auth!.organizationId,
      userId: req.auth!.userId,
      page,
      cardOrder,
    },
    update: { cardOrder },
    select: { cardOrder: true, updatedAt: true },
  });

  res.json({ page, cardOrder: row.cardOrder, updatedAt: row.updatedAt.toISOString() });
});

// Lets a user get back to the shipped dashboard without hand-re-adding cards.
preferencesRouter.delete("/dashboard-layout", ...requireAuth, parsePageQuery, async (req, res) => {
  const page = parsedOn(req).page!;
  await prisma.dashboardLayout.deleteMany({
    where: { organizationId: req.auth!.organizationId, userId: req.auth!.userId, page },
  });
  res.json({ page, cardOrder: null, updatedAt: null });
});

// Returns {} rather than nulls-for-every-known-key when nothing has been set
// — the schema of "what settings exist" lives in orgSettingsSchema, not
// duplicated here as a set of defaults a consumer could drift out of sync
// with.
preferencesRouter.get("/org", ...requireAuth, async (req, res) => {
  res.json({ settings: await getOrgSettings(req.auth!.organizationId) });
});

preferencesRouter.put("/org", ...requireAuth, parseOrgSettingsBody, async (req, res) => {
  const patch = parsedOn(req).orgSettings!;
  // A merge, not a replace: several unrelated features write different keys
  // into this same JSON bag over time (cash threshold today; notification
  // digest and recurring-outflow settings later), and a PUT carrying only
  // one of them must not erase the others.
  const merged: OrgSettings = { ...(await getOrgSettings(req.auth!.organizationId)), ...patch };
  const updated = await prisma.organization.update({
    where: { id: req.auth!.organizationId },
    data: { settings: merged as Prisma.InputJsonValue },
    select: { settings: true },
  });
  res.json({ settings: updated.settings });
});
