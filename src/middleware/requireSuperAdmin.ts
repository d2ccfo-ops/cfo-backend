import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";
import { internalConsoleEnabled, isOperator } from "../lib/internalOperators.js";

// THE ONE SURFACE IN THIS API THAT IS NOT SCOPED TO AN ORGANISATION.
//
// Every other authenticated route resolves a tenant from the verified Clerk
// org claim and refuses to run without one (middleware/auth.ts). That single
// rule is what makes this system multi-tenant-safe, and the internal console
// exists precisely to break it: "how much is every customer costing us" is not
// a question any organisation is allowed to ask.
//
// So it gets its own door, and the door is deliberately not built out of the
// existing one:
//
//   1. NOT A MembershipRole. Adding SUPERADMIN to that enum was the obvious
//      move and is wrong — MembershipRole is per-ORGANISATION, and granting a
//      role inside one tenant must never be able to grant reads across all of
//      them. Keeping the two authorities in different systems means no
//      sequence of ordinary membership edits can produce cross-tenant access.
//   2. NOT requireAuth. That chain resolves an org, applies org RBAC and keys
//      the rate limiter on the tenant. None of those mean anything here.
//   3. AN EXPLICIT ALLOWLIST OF CLERK USER IDS.
//
// POINT 3 USED TO SAY "FROM THE ENVIRONMENT, NOT A DATABASE FLAG", on the
// grounds that "a row anybody with database access can flip is not a boundary".
// That argument is answered rather than ignored, and it is worth writing down
// which half of it survived:
//
//   The half that does not hold. Anybody with database access on this box can
//   already read every tenant's rows directly — strictly more than this console
//   grants. A row they could flip does not cross a line their access had not
//   already crossed, so "not a boundary against DB access" was true of the
//   whole system, not an argument for env-only.
//
//   The half that does, and is kept intact. The environment list is the FEATURE
//   SWITCH and the BREAK GLASS. Empty still means /internal does not exist, so
//   nobody can grant their way into a console nobody turned on; and those
//   entries are NOT REVOKABLE from the console, so no compromised session and no
//   sequence of clicks can lock everyone out. Database grants are additive on
//   top of that floor, and each one records who made it — which is stronger
//   visibility than "it changed in a diff", not weaker.
//
// See lib/internalOperators.ts for the resolution order and why a database
// failure denies rather than admits.

export { internalConsoleEnabled };

/**
 * 404, NOT 403, ON EVERY REFUSAL.
 *
 * A 403 confirms the console exists and that the caller merely lacks the right
 * account — which is exactly the fact worth not confirming on an unauthenticated
 * internet-facing endpoint. To anyone not on the list, /internal is
 * indistinguishable from a route that was never written.
 *
 * The cost of that choice is an operator who adds their own ID wrong and sees a
 * blank 404 with no explanation, so every refusal is logged WITH the caller's
 * Clerk user id. Finding your own id in the logs is then the documented way to
 * populate the allowlist, and it never travels over the wire to the client.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  // Express 4 does not adopt a returned promise, so an async middleware here
  // would surface a rejection as an unhandled rejection rather than a response.
  // authorise() therefore resolves for every outcome and never rejects; the
  // catch is a belt-and-braces deny, not the expected path.
  void authorise(req, res, next).catch((err: unknown) => {
    logger.error({ err, path: req.originalUrl }, "internal_console_guard_threw");
    if (!res.headersSent) res.status(404).json({ error: "not_found" });
  });
}

async function authorise(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!internalConsoleEnabled()) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const { userId } = getAuth(req);

  if (!userId) {
    logger.warn({ path: req.originalUrl }, "internal_console_denied_unauthenticated");
    res.status(404).json({ error: "not_found" });
    return;
  }

  if (!(await isOperator(userId))) {
    // The userId is the actionable half of this line: to grant access, either
    // add it on the console's Access page or copy it into
    // INTERNAL_ADMIN_USER_IDS.
    logger.warn({ userId, path: req.originalUrl }, "internal_console_denied_not_allowlisted");
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Cross-tenant reads are the thing this API otherwise makes impossible, so
  // every one of them is recorded. It cannot go to AuditLog: that table is
  // keyed by organizationId and these requests belong to no organisation —
  // writing them there would mean either inventing a tenant or adding a
  // nullable key that weakens every other row's guarantee. The process log is
  // the honest place for an event with no tenant.
  logger.info({ userId, path: req.originalUrl, method: req.method }, "internal_console_access");
  next();
}
