import { getAuth } from "@clerk/express";
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { consume } from "../middleware/rateLimit.js";
import { recordError } from "../modules/observability/errorGroups.js";

// WHAT THE BROWSER SAW.
//
// request_metrics records how long Express took to produce a response, and that
// number can be excellent while the product is unusable. It does not include
// DNS, TLS, the network, the JavaScript bundle, React hydration, or the four
// sequential fetches a page makes before it renders anything. An 8ms server p95
// and a six-second largest-contentful-paint are perfectly compatible, and only
// one of them is the customer's opinion.
//
// It also records nothing at all about errors that happen after the response
// leaves — a component that throws during render returns 200 and a blank page.
//
// THIS IS THE ONE ROUTER IN THIS APP THAT ACCEPTS DATA FROM AN UNTRUSTED
// CLIENT, so every field is treated as hostile:
//
//   ROUTE IS AN ALLOWLIST, not a string. client_metrics is keyed on
//   (minute, route), so accepting whatever the client sends means any visitor
//   can mint unlimited rows. With a fixed list, the table's size is bounded by
//   time x routes no matter what arrives.
//
//   NUMBERS ARE CLAMPED. A negative LCP or a 10^9 ms TTFB would poison the mean
//   for every reader, permanently, and there is no way to tell afterwards which
//   sample was the bad one.
//
//   ERRORS REQUIRE A SESSION. Vitals aggregate into bounded rows, so anonymous
//   ones are safe. Errors create a row per distinct fingerprint, which is
//   unbounded — so an anonymous caller could fill error_groups with noise.
//   Requiring a signed-in user costs us errors thrown on the sign-in page
//   itself; that is a real gap, accepted knowingly, and it is the smaller of
//   the two problems.

export const telemetryRouter = Router();

/**
 * Every route the dashboard can report.
 *
 * Hard-coded rather than derived. It has to be updated when a page is added,
 * and that is the point: an unknown route is folded into "other" rather than
 * silently becoming a new row.
 */
const ROUTES = new Set([
  "/", "/overview", "/inventory", "/reconciliation", "/exceptions", "/ai-cfo", "/cash", "/profitability",
  "/settlements", "/connections", "/reports", "/settings", "/audit", "/approvals", "/notifications",
  "/onboarding", "/login", "other",
]);

const RATE_LIMIT = { max: 60, windowSeconds: 60, bucket: "telemetry" };

/** Milliseconds. Anything outside this is a broken clock, not a slow page. */
const MAX_MS = 120_000;

function clampMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_MS) return null;
  return Math.round(v);
}

function normaliseRoute(v: unknown): string {
  if (typeof v !== "string") return "other";
  // Query strings and ids are stripped before the allowlist is consulted, so
  // "/inventory?sku=X" is /inventory rather than "other".
  const path = v.split("?")[0]?.replace(/\/+$/, "") || "/";
  return ROUTES.has(path) ? path : "other";
}

async function limited(req: Parameters<typeof getAuth>[0] & { ip?: string }): Promise<boolean> {
  const key = getAuth(req).userId ?? req.ip ?? "anonymous";
  try {
    const d = await consume(key, RATE_LIMIT);
    return !d.allowed;
  } catch {
    // Fails open, like every other limiter here. Losing telemetry because Redis
    // is unwell is not worth a 500 on a beacon.
    return false;
  }
}

/**
 * Web Vitals beacon.
 *
 * Answers 204 in every case, including rejection. A beacon that returns an
 * error makes the browser's console noisy on the page it is measuring, and
 * there is nothing the client could usefully do about it anyway.
 */
telemetryRouter.post("/telemetry/vitals", async (req, res) => {
  res.status(204).end();

  try {
    if (await limited(req)) return;

    const body = req.body as { route?: unknown; metrics?: unknown };
    const route = normaliseRoute(body.route);
    const m = (body.metrics ?? {}) as Record<string, unknown>;

    const lcp = clampMs(m.lcp);
    const inp = clampMs(m.inp);
    const ttfb = clampMs(m.ttfb);
    const fcp = clampMs(m.fcp);
    const clsRaw = typeof m.cls === "number" && Number.isFinite(m.cls) && m.cls >= 0 && m.cls <= 100 ? m.cls : null;

    if (lcp === null && inp === null && ttfb === null && fcp === null && clsRaw === null) return;

    const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    // Google's published bands. Named constants would hide that these are not
    // ours to choose.
    const lcpGood = lcp !== null && lcp <= 2500 ? 1 : 0;
    const lcpPoor = lcp !== null && lcp > 4000 ? 1 : 0;
    const lcpNeedsWork = lcp !== null && !lcpGood && !lcpPoor ? 1 : 0;

    const inc = {
      samples: 1,
      lcpSum: lcp ?? 0, lcpCount: lcp === null ? 0 : 1, lcpGood, lcpNeedsWork, lcpPoor,
      inpSum: inp ?? 0, inpCount: inp === null ? 0 : 1,
      clsSumMilli: clsRaw === null ? 0 : Math.round(clsRaw * 1000), clsCount: clsRaw === null ? 0 : 1,
      ttfbSum: ttfb ?? 0, ttfbCount: ttfb === null ? 0 : 1,
      fcpSum: fcp ?? 0, fcpCount: fcp === null ? 0 : 1,
    };

    await prisma.clientMetric.upsert({
      where: { bucketStart_route: { bucketStart, route } },
      create: { bucketStart, route, ...inc },
      update: {
        samples: { increment: inc.samples },
        lcpSum: { increment: inc.lcpSum }, lcpCount: { increment: inc.lcpCount },
        lcpGood: { increment: inc.lcpGood }, lcpNeedsWork: { increment: inc.lcpNeedsWork }, lcpPoor: { increment: inc.lcpPoor },
        inpSum: { increment: inc.inpSum }, inpCount: { increment: inc.inpCount },
        clsSumMilli: { increment: inc.clsSumMilli }, clsCount: { increment: inc.clsCount },
        ttfbSum: { increment: inc.ttfbSum }, ttfbCount: { increment: inc.ttfbCount },
        fcpSum: { increment: inc.fcpSum }, fcpCount: { increment: inc.fcpCount },
      },
    });
  } catch (err) {
    // The response already went out. Nothing here may throw into a handler that
    // has finished; a failed beacon is a lost sample, not an incident.
    logger.warn({ err }, "telemetry_vitals_failed");
  }
});

/**
 * Client-side exceptions.
 *
 * Funnelled through the SAME fingerprinting as server errors, deliberately: one
 * errors page, one masking rule, one status workflow. `source: "browser"` is
 * what tells them apart, and a fault that happens in both places genuinely is
 * one fault.
 */
telemetryRouter.post("/telemetry/errors", async (req, res) => {
  res.status(204).end();

  try {
    const auth = getAuth(req);
    // See the header note: unbounded fingerprints from anonymous callers is the
    // one shape of abuse this router cannot absorb.
    if (!auth.userId) return;
    if (await limited(req)) return;

    const body = req.body as { name?: unknown; message?: unknown; stack?: unknown; route?: unknown; kind?: unknown };
    const message = typeof body.message === "string" ? body.message.slice(0, 1000) : "";
    if (!message) return;

    const err = new Error(message);
    err.name = typeof body.name === "string" ? body.name.slice(0, 120) : "BrowserError";
    // The browser's stack, verbatim, minus the synthetic first line Error()
    // just produced. topFrame() reads this to fingerprint, so a wrong stack
    // here would group unrelated faults together.
    if (typeof body.stack === "string") err.stack = `${err.name}: ${message}\n${body.stack.slice(0, 4000)}`;

    await recordError({
      error: err,
      route: normaliseRoute(body.route),
      method: typeof body.kind === "string" ? body.kind.slice(0, 40) : "render",
      source: "browser",
      organizationId: auth.orgId ?? null,
    });
  } catch (err) {
    logger.warn({ err }, "telemetry_errors_failed");
  }
});
