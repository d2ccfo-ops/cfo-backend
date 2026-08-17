import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { requireSuperAdmin } from "../../middleware/requireSuperAdmin.js";
import { consume } from "../../middleware/rateLimit.js";
import { logger } from "../../lib/logger.js";
import { internalAccessRouter } from "./access.js";
import { internalAiRouter } from "./ai.js";
import { internalAlertsRouter } from "./alerts.js";
import { internalDeployRouter } from "./deploy.js";
import { internalInfraRouter } from "./infra.js";
import { internalEconomicsRouter } from "./economics.js";
import { internalErrorsRouter } from "./errors.js";
import { internalProductRouter } from "./product.js";
import { internalReliabilityRouter } from "./reliability.js";
import { internalJobsRouter } from "./jobs.js";
import { internalOverviewRouter } from "./overview.js";
import { internalTenantsRouter } from "./tenants.js";
import { internalUsersRouter } from "./users.js";

// The operations console's API. Cross-tenant, and therefore fenced off from
// everything else in this app.
//
// requireSuperAdmin is applied HERE, once, with router.use — the opposite of
// the rule calcCache follows two directories over, and for the opposite reason.
// There, a blanket middleware was dangerous because it would silently start
// caching endpoints added later. Here, a blanket middleware is the only safe
// arrangement, because the thing that would be applied by omission is
// AUTHORISATION: a route added to this router tomorrow and accidentally left
// off a per-route guard list would be an unauthenticated cross-tenant read of
// every customer's data. The failure mode of forgetting must be "denied", not
// "wide open", and only router.use gives that.
//
// NOTHING UNDER HERE MAY TOUCH TENANT DATA. That was originally written as
// "every handler is a GET", and the reasoning was about blast radius: a console
// that can change customer records is a far bigger thing to secure than one
// that can only look. That reasoning is intact and the rule it produced now has
// exactly two exceptions, both of which write only to the console's own
// machinery and neither of which can reach an organisation's rows:
//
//   /access   — the console's guest list. See access.ts; the alternative was
//               editing an env var and restarting the API, which is the same
//               power exercised by the same people with less of a record.
//   /deploy   — a REQUEST for a different image tag. It cannot deploy; a
//               root-owned agent on the host polls and applies. See deploy.ts.
//
// A third exception should be argued for on the same terms or refused. The
// question to ask is not "is this write small" but "can this write reach a
// tenant's data" — and for both of the above the answer is no by construction,
// not by care.
export const internalRouter = Router();

internalRouter.use(requireSuperAdmin);

// Writes are rate limited on top of authorisation. Not because an operator is
// expected to abuse it, but because these two endpoints are the only place a
// stolen operator session can do anything other than read — and a grant loop or
// a deploy loop should hit a wall long before it becomes interesting.
const INTERNAL_WRITE_LIMIT = { max: 30, windowSeconds: 60, bucket: "internal-write" };

function writeLimiter(req: Request, res: Response, next: NextFunction): void {
  // Keyed on the CLERK USER ID, not on req.auth. The generic rateLimit
  // middleware keys on req.auth.organizationId — which is exactly the field
  // this router exists to have none of, so it would silently degrade to keying
  // every operator in the world by IP.
  const key = getAuth(req).userId ?? req.ip ?? "anonymous";
  void consume(key, INTERNAL_WRITE_LIMIT)
    .then((decision) => {
      res.setHeader("X-RateLimit-Limit", String(INTERNAL_WRITE_LIMIT.max));
      res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
      if (decision.allowed) {
        next();
        return;
      }
      logger.warn({ userId: key, path: req.originalUrl }, "internal_console_write_rate_limited");
      res.setHeader("Retry-After", String(decision.resetSeconds));
      res.status(429).json({
        error: `More than ${INTERNAL_WRITE_LIMIT.max} console changes in a minute. Try again in ${decision.resetSeconds}s.`,
      });
    })
    .catch((err: unknown) => {
      // Fails OPEN, matching the rest of the app's limiters. The limiter is
      // depth behind an allowlist of named operators, not the control itself —
      // and a Redis outage must not stop the one page that can grant the access
      // needed to fix a Redis outage.
      logger.warn({ err, bucket: INTERNAL_WRITE_LIMIT.bucket }, "rate_limit_store_unavailable");
      next();
    });
}

internalRouter.use((req, res, next) => {
  if (req.method === "GET") {
    next();
    return;
  }
  writeLimiter(req, res, next);
});

internalRouter.use("/overview", internalOverviewRouter);
internalRouter.use("/ai", internalAiRouter);
internalRouter.use("/infra", internalInfraRouter);
internalRouter.use("/economics", internalEconomicsRouter);
internalRouter.use("/jobs", internalJobsRouter);
internalRouter.use("/tenants", internalTenantsRouter);
internalRouter.use("/users", internalUsersRouter);
internalRouter.use("/access", internalAccessRouter);
internalRouter.use("/alerts", internalAlertsRouter);
internalRouter.use("/errors", internalErrorsRouter);
internalRouter.use("/product", internalProductRouter);
internalRouter.use("/reliability", internalReliabilityRouter);
internalRouter.use("/deploy", internalDeployRouter);
