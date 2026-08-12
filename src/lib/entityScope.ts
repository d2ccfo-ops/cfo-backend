import type { NextFunction, Request, Response } from "express";
import { prisma } from "./prisma.js";

// §12.2 legal-entity scoping (P5.6).
//
// THE PROBLEM. The entity picker in the UI has been cosmetic since it shipped:
// it changes a label and nothing else. Every figure on every page is the whole
// organisation's, whichever entity is selected. On a single-entity org that is
// invisible and harmless. The moment a second entity exists it is a wrong
// number presented as a filtered one — which is the worst shape a wrong number
// can take, because the reader specifically asked for a subset.
//
// WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT.
//
// It resolves and VALIDATES the requested entity — it must exist and belong to
// the caller's organisation, or the request is refused. That guard matters at
// one entity as much as at ten: an id from another tenant must never resolve.
//
// It threads the entity into the read paths that can honour it. Not every
// calculation can: ad spend is recorded per ad account with no entity column,
// and bank balances belong to an account rather than to an entity. For those,
// an endpoint asked to filter by entity must SAY it cannot, not answer with
// the organisation-wide figure under an entity label.
//
// The single-entity shortcut is the one place this is permissive, and it is
// provably safe: when an organisation has exactly one entity, filtering by it
// and not filtering are the same set of rows. Accepting it silently there
// keeps the picker working today without pretending to a capability that does
// not exist yet.

export interface EntityScope {
  /** Null means "everything in the organisation". */
  legalEntityId: string | null;
  /** How many entities the organisation has. 1 makes any filter a no-op. */
  entityCount: number;
}

/**
 * Where a Prisma `where` clause gets its scope.
 *
 * One helper rather than `...(entityId ? { legalEntityId: entityId } : {})`
 * repeated across thirty call sites: the repeated form is how one of them ends
 * up spelled slightly differently and silently stops filtering.
 */
export function scopeWhere(organizationId: string, scope?: EntityScope | null): { organizationId: string; legalEntityId?: string } {
  if (!scope?.legalEntityId) return { organizationId };
  // A single-entity organisation needs no filter, and adding one would exclude
  // rows whose legalEntityId is null — which is a real state for records
  // ingested before entities existed.
  if (scope.entityCount <= 1) return { organizationId };
  return { organizationId, legalEntityId: scope.legalEntityId };
}

/** True when a filter would actually change the answer. */
export function scopeIsMeaningful(scope?: EntityScope | null): boolean {
  return Boolean(scope?.legalEntityId) && (scope?.entityCount ?? 0) > 1;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      entityScope?: EntityScope;
    }
  }
}

/**
 * Resolve ?legalEntityId= into req.entityScope.
 *
 * Async, and therefore mounted per route rather than folded into
 * withDateRange — that one has to stay synchronous (see the note in
 * dateRange.ts about Express 4 async throws).
 */
export async function withEntityScope(req: Request, res: Response, next: NextFunction) {
  const organizationId = req.auth?.organizationId;
  if (!organizationId) {
    next();
    return;
  }

  const raw = typeof req.query.legalEntityId === "string" ? req.query.legalEntityId.trim() : "";
  const entities = await prisma.legalEntity.findMany({ where: { organizationId }, select: { id: true } });

  if (raw === "" || raw === "all") {
    req.entityScope = { legalEntityId: null, entityCount: entities.length };
    req.auth!.legalEntityId = null;
    next();
    return;
  }

  if (!entities.some((e) => e.id === raw)) {
    // 404 rather than 403: a valid id belonging to another organisation must
    // not be confirmed to exist.
    res.status(404).json({
      error: "unknown_legal_entity",
      message: "No legal entity with that id in this organisation.",
    });
    return;
  }

  req.entityScope = { legalEntityId: raw, entityCount: entities.length };
  req.auth!.legalEntityId = raw;

  // Attach the caveat centrally rather than in each handler. A per-handler
  // note is a note somebody forgets on the one endpoint that matters, and the
  // failure is silent: an organisation-wide figure served under an entity
  // label, to a reader who specifically asked for a subset.
  if (scopeIsMeaningful(req.entityScope)) {
    const path = (req.baseUrl ?? "") + (req.route?.path ?? req.path ?? "");
    if (!ENTITY_SCOPED_PATHS.has(path.replace(/\/$/, ""))) {
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        if (body && typeof body === "object" && !Array.isArray(body)) {
          return json({
            ...(body as Record<string, unknown>),
            entityScopeWarning: `This figure covers the whole organisation. ${path} cannot be broken down by legal entity — the records behind it carry no entity.`,
          });
        }
        return json(body as never);
      };
    }
  }

  next();
}

/**
 * The endpoints that genuinely filter by entity.
 *
 * Everything else gets a warning attached to its response automatically — see
 * withEntityScope. That direction is deliberate: a list of what IS supported
 * is short and auditable, while a list of what is NOT has to be updated every
 * time an endpoint is added, and the one somebody forgets answers with the
 * organisation-wide figure under an entity label.
 */
export const ENTITY_SCOPED_PATHS = new Set([
  "/metrics/revenue",
  "/metrics/revenue-ladder",
  "/metrics/sales",
  "/metrics/rto-rate",
  "/metrics/contribution-margin",
  "/metrics/product-profitability",
]);

/**
 * For endpoints that cannot honour an entity filter.
 *
 * Returns a message when the request asked for something the endpoint cannot
 * do, and null when it is safe to proceed. The caller decides whether to
 * refuse or to attach it as a warning — but it must do one of the two. What it
 * must never do is answer with the organisation-wide figure under an entity
 * label.
 */
export function unsupportedScopeMessage(scope: EntityScope | undefined, what: string): string | null {
  if (!scopeIsMeaningful(scope)) return null;
  return `${what} cannot be broken down by legal entity — the underlying records carry no entity. This figure covers the whole organisation.`;
}
