import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

export interface AuthContext {
  organizationId: string;
  legalEntityId: string | null;
  userId: string;
  role: "org:admin" | "org:member" | string;
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
export const requireAuth = [resolveOrgContext];

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

  req.auth = {
    organizationId: organization.id,
    legalEntityId: null,
    userId,
    role: orgRole ?? "org:member",
    timezone: organization.timezone,
  };
  next();
}
