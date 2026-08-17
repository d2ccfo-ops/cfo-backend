import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

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
//   3. AN EXPLICIT ALLOWLIST OF CLERK USER IDS, from the environment. Not a
//      database flag: a row anybody with database access can flip is not a
//      boundary, and this list should change by deploy, visibly.
//
// Absence of the variable is the feature switch — same pattern as
// DEMO_LOGIN_EMAIL. Unset means /internal does not exist at all, which is what
// every deployment should look like until somebody deliberately turns it on.

/** Parsed once at module load: the list changes by deploy, not by request. */
const ALLOWLIST: ReadonlySet<string> = new Set(
  (env.INTERNAL_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

export function internalConsoleEnabled(): boolean {
  return ALLOWLIST.size > 0;
}

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

  if (!ALLOWLIST.has(userId)) {
    // The userId is the actionable half of this line: to grant access, copy it
    // into INTERNAL_ADMIN_USER_IDS.
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
