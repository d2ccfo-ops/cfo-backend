import { getAuth } from "@clerk/express";
import type { MembershipRole } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { markLastSeen } from "./lastSeen.js";
import { enforceRateLimit } from "./rateLimit.js";
import { enforceRbac, normaliseRole } from "./rbac.js";

export interface AuthContext {
  organizationId: string;
  legalEntityId: string | null;
  userId: string;
  /**
   * THIS ORGANISATION'S role for this user, from the Membership row.
   *
   * It used to be Clerk's org role string ("org:admin"), which nothing read
   * and which cannot express the seven §12.2 roles — Clerk has two. The
   * Membership row is the authority now, and middleware/rbac.ts decides on it.
   */
  role: MembershipRole;
  /** Clerk's own role, kept for the webhook reconciliation path and for logs. */
  clerkRole: string;
  // §3. Carried on the auth context because lib/dateRange.ts's withDateRange
  // must stay SYNCHRONOUS (see the note there on Express 4 async throws), so it
  // cannot look the organisation up itself — but it always runs after this.
  timezone: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

// Deliberately not using @clerk/express's requireAuth() here: it's deprecated
// in favor of getAuth(), and — more importantly for a JSON API — its default
// behavior on an unauthenticated request is an HTTP redirect to "/", which is
// wrong for an API client (our frontend's fetch calls want a 401 to handle,
// not a redirect response). This does the same check via getAuth() directly
// and always returns JSON, then resolves Clerk's orgId (the tenant the user
// has selected in the org switcher) onto our internal Organization row — org
// scope always comes from this verified claim, never from a client header.
// Two middlewares, always in this order, and the second one is why RBAC
// cannot be forgotten on a new route: anything that authenticates is also
// authorised. See the note at the top of middleware/rbac.ts.
// markLastSeen is last, and belongs in this array for the same reason
// enforceRbac does: a route added tomorrow is covered the moment it
// authenticates. It is throttled and fire-and-forget, so it costs the request
// nothing — see middleware/lastSeen.ts.
export const requireAuth = [resolveOrgContext, enforceRbac, enforceRateLimit, markLastSeen];

// Signed-in user, no organisation required. Exists for exactly one situation:
// onboarding renders BEFORE the user has created an organisation, so an
// endpoint it needs (the legal-entity dropdown vocabularies) cannot demand
// one. Anything that reads or writes tenant data must use requireAuth instead
// — this deliberately leaves req.auth unset so a handler cannot accidentally
// treat an org-less request as scoped.
export const requireUser = [resolveUserOnly];

function resolveUserOnly(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  next();
}

async function resolveOrgContext(req: Request, res: Response, next: NextFunction) {
  const { userId, orgId, orgRole } = getAuth(req);

  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (!orgId) {
    res.status(403).json({ error: "no_organization_selected" });
    return;
  }

  const organization = await prisma.organization.findUnique({
    where: { clerkOrgId: orgId },
    select: { id: true, timezone: true },
  });

  if (!organization) {
    // Clerk knows about this org but our webhook hasn't synced it yet (or failed).
    res.status(409).json({ error: "organization_not_synced" });
    return;
  }

  // The Membership row is the authority on what this person may do. It is
  // looked up per request rather than trusted from the token, because a role
  // change has to take effect on the next request and a JWT does not expire
  // when someone is demoted.
  const membership = await prisma.membership.findUnique({
    where: { organizationId_clerkUserId: { organizationId: organization.id, clerkUserId: userId } },
    select: { role: true },
  });

  // No membership row is not a reason to lock someone out of an org Clerk says
  // they belong to — the webhook can lag or have failed, and the resulting
  // lockout would look like a total outage. It IS a reason not to grant
  // anything above what Clerk itself asserts, so an admin falls back to ADMIN
  // and everyone else to ANALYST. Never OWNER: that one is granted, not
  // inferred.
  const role: MembershipRole = membership
    ? normaliseRole(membership.role)
    : orgRole === "org:admin" || orgRole === "org:owner"
      ? "ADMIN"
      : "ANALYST";

  req.auth = {
    organizationId: organization.id,
    legalEntityId: null,
    userId,
    role,
    clerkRole: orgRole ?? "org:member",
    timezone: organization.timezone,
  };
  next();
}
