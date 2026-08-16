import type { NextFunction, Request, Response } from "express";
import { readCachedResponse, writeCachedResponse } from "../lib/orgReadCache.js";

// Serves a metric endpoint's previous answer when nothing that feeds it has
// changed. See the long note in lib/orgReadCache.ts for why this is the lever
// that matters: the endpoints are individually fast and the box is CPU-bound,
// so the only real saving is not doing the work twice.
//
// APPLIED PER ROUTE, NEVER AS router.use(). Two reasons, and both are
// correctness rather than taste:
//
//   1. router.use() runs BEFORE the route's own middleware chain, so
//      req.entityScope would not exist yet — and the resolved scope is part of
//      the identity of the answer. Mounting it after withEntityScope on each
//      route is what makes the key honest.
//   2. An allowlist that is a list of call sites cannot drift. A blanket
//      middleware silently starts caching every endpoint added later,
//      including ones that are per-user rather than per-org (notifications,
//      preferences) — which would serve one person's data to another. That
//      failure is invisible in testing with a single account.
//
// WHAT MAKES A CACHED ANSWER THE SAME ANSWER. The key carries every input the
// handler can see: organisation, the RESOLVED entity scope (not the requested
// one — withEntityScope collapses a filter to a no-op on single-entity orgs,
// so two different URLs legitimately share a body), and the full query string
// in canonical order so ?from=X&to=Y and ?to=Y&from=X are one entry rather
// than two. Anything not in the key must not be able to change the body.
//
// Time is the exception that is handled by the TTL rather than the key. A few
// figures move with the clock and not with any write — the stale-COD bucket
// ages parcels into itself, freshness counts minutes since a sync. Sixty
// seconds of a clock-driven figure standing still is the same staleness the
// org-wide cache above already accepts, and far less than the sync cadence
// that produces the underlying data.
//
// Errors are never cached: a 500 that cached itself would outlive the incident
// that caused it, and a 400 belongs to the request that was malformed, not to
// the organisation.

/** Query string with keys sorted, so equivalent URLs share one cache entry. */
function canonicalQuery(req: Request): string {
  const entries = Object.entries(req.query)
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

export function calcCache(name: string) {
  return function calcCacheMiddleware(req: Request, res: Response, next: NextFunction): void {
    const organizationId = req.auth?.organizationId;
    // No organisation means no key that could be scoped to one. Never guess.
    if (!organizationId || req.method !== "GET") {
      next();
      return;
    }

    const scope = req.entityScope;
    // The resolved scope, including entityCount: a one-entity org that grows a
    // second entity changes what legalEntityId=null means, and that must not
    // be answered from a body computed under the old shape.
    const scopeKey = `${scope?.legalEntityId ?? "-"}/${scope?.entityCount ?? "-"}`;
    const variant = `${name}|${scopeKey}|${canonicalQuery(req)}`;

    readCachedResponse(organizationId, variant)
      .then((hit) => {
        if (hit !== null) {
          // Sent as a pre-serialised body rather than through res.json, which
          // would parse it only to stringify it again. The header is set by
          // hand for the same reason.
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("X-Calc-Cache", "hit");
          res.send(hit);
          return;
        }

        res.setHeader("X-Calc-Cache", "miss");
        // Wrap res.json rather than res.send: every handler here answers with
        // res.json, and wrapping the narrower method means a handler that
        // streams or sends a file is left alone instead of being captured.
        const originalJson = res.json.bind(res);
        res.json = ((body: unknown) => {
          if (res.statusCode === 200) {
            try {
              void writeCachedResponse(organizationId, variant, JSON.stringify(body));
            } catch {
              // A body that will not serialise is the handler's problem to
              // report, not this middleware's to swallow — fall through and
              // let express raise it as it would have without caching.
            }
          }
          return originalJson(body);
        }) as typeof res.json;

        next();
      })
      .catch(() => {
        // A cache that fails must degrade to computing, never to erroring.
        next();
      });
  };
}
