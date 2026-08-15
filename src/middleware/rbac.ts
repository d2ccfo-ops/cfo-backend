import type { MembershipRole } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { writeAudit } from "../lib/audit.js";

// §12.2 role enforcement (P5.1).
//
// Roles were STORED and never ENFORCED. Membership.role has been written by
// the Clerk webhook since the first week, and not one line of code read it —
// every authenticated member of an organisation could delete a connection,
// restamp product costs or write off a reconciliation exception. This closes
// that.
//
// WHERE IT IS ENFORCED, AND WHY THERE. This middleware is appended to the
// `requireAuth` array in middleware/auth.ts, so it runs on every route that
// spreads `...requireAuth` — all 89 of them — rather than being decorated onto
// handlers one at a time. That choice is the whole design: a per-handler guard
// is enforcement you can forget, and the route someone forgets is the one that
// matters. A new route written tomorrow is covered the moment it authenticates.
//
// THE POLICY IS METHOD-AND-PATH, NOT PER-HANDLER. Reads are open to every
// role; writes are gated by what is being written. That is coarse on purpose:
// a fine-grained matrix over 89 endpoints is a document nobody can hold in
// their head, and the failure mode of a rule nobody understands is that
// someone widens it to make a bug go away.

/**
 * The seven §12.2 roles, most privileged first.
 *
 * MEMBER is the eighth value and is deliberately kept: Postgres enum values
 * can be added but not removed without a table rewrite, and every existing
 * membership row in this database carries it. It maps to ANALYST everywhere
 * a decision is made — see normaliseRole.
 */
export const ROLE_ORDER: MembershipRole[] = [
  "OWNER",
  "ADMIN",
  "FINANCE_MANAGER",
  "ACCOUNTANT",
  "ANALYST",
  "VIEWER",
  "EXTERNAL_CA",
];

/** MEMBER ≡ ANALYST. Stated in one place so no policy has to know about it. */
export function normaliseRole(role: MembershipRole | string | null | undefined): MembershipRole {
  if (role === "MEMBER" || role === null || role === undefined) return "ANALYST";
  return (ROLE_ORDER as string[]).includes(role) ? (role as MembershipRole) : "ANALYST";
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Who may write what. Longest prefix wins, so a specific rule can carve out of
// a general one.
interface WritePolicy {
  prefix: string;
  roles: MembershipRole[];
  /** Printed in the 403 so a refusal explains itself. */
  what: string;
}

const WRITE_POLICIES: WritePolicy[] = [
  // Credentials. An API key or an OAuth token is the keys to the business's
  // money, and a FINANCE_MANAGER who can read every figure still has no reason
  // to be able to rotate or revoke one.
  { prefix: "/connections", roles: ["OWNER", "ADMIN"], what: "connecting, disconnecting or re-authorising a data source" },
  // Membership and org settings.
  { prefix: "/organization", roles: ["OWNER", "ADMIN"], what: "changing the organisation or its members" },
  { prefix: "/legal-entities", roles: ["OWNER", "ADMIN"], what: "changing legal entities" },
  // Costs are the accountant's job — the one write an ACCOUNTANT has that a
  // FINANCE_MANAGER does not need to grant them.
  { prefix: "/costs", roles: ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT"], what: "entering or restamping product costs" },
  // Everything else that writes: acknowledging an anomaly, writing off an
  // exception, running a scenario, marking a notification read, asking the AI.
  { prefix: "/", roles: ["OWNER", "ADMIN", "FINANCE_MANAGER"], what: "this action" },
];

// Writes that are really reads. A handler is a write because of its METHOD,
// but a few POSTs compute something and store nothing that matters — refusing
// them to an analyst would make the product unusable for the role whose entire
// job is analysis.
//
// Each entry earns its place: none of them changes a figure anyone else sees.
const READ_LIKE_WRITES = [
  // A scenario is a what-if. It persists nothing.
  /^\/metrics\/cash-forecast\/scenario$/,
  // Asking a question. The conversation is the asker's own.
  //
  // Both transports, and the optional group is load-bearing. /ai/ask/stream is
  // the SAME orchestrator run with progress events attached — it reads the same
  // tools, spends the same tokens and writes the same AgentRun. When it was
  // added it did not match this exact-anchored pattern, so it fell through to
  // the catch-all "/" policy and every ANALYST asking a question got a 403,
  // while the identical question on /ai/ask succeeded. A permission that
  // depends on which transport the client picked is a bug in both directions.
  /^\/ai\/ask(\/stream)?$/,
  // Marking one's own notification read.
  /^\/notifications\/[^/]+\/read$/,
  /^\/notifications\/read-all$/,
  // A person's own dashboard layout, which follows the USER and not the org.
  /^\/preferences\/dashboard-layout$/,
];

/**
 * Exceptions that a path prefix cannot express, checked before the prefix
 * policies. Each is an exact-shape match, never a prefix, so a route added
 * underneath one of these does not inherit its permission.
 */
const EXPLICIT_POLICIES: Array<{ pattern: RegExp; roles: MembershipRole[]; what: string }> = [
  {
    // Triggering a resync. It sits under /connections, but it neither reads
    // nor changes a credential — it asks an existing connection to fetch
    // again. Refusing it to the person who noticed the data was stale, and
    // making them find an admin, is the kind of rule that gets a system's
    // permissions turned off entirely.
    pattern: /^\/connections\/[^/]+\/sync$/,
    roles: ["OWNER", "ADMIN", "FINANCE_MANAGER"],
    what: "triggering a sync",
  },
];

export interface RbacDecision {
  allowed: boolean;
  /** Null when allowed. */
  reason: string | null;
  requiredRoles: MembershipRole[];
}

/**
 * The decision, as a pure function.
 *
 * Separated from the middleware so it can be unit-tested exhaustively over
 * every (role × method × path) combination that matters, with no Express and
 * no database. An access-control rule that is only exercised through HTTP is
 * a rule whose edge cases are untested.
 */
export function decideAccess(role: MembershipRole, method: string, rawPath: string): RbacDecision {
  const normalised = normaliseRole(role);
  // ---------------------------------------------------------------------------
  // CASE. Express 4 routes case-INSENSITIVELY by default; these policies match
  // case-SENSITIVELY. That gap was a privilege escalation, not a cosmetic one:
  // POST /Connections/shopify/connect reaches the real handler, misses the
  // /connections prefix and every explicit pattern, and falls through to the
  // catch-all "/" policy — so a FINANCE_MANAGER, who must never touch
  // credentials, could set a provider access token by capitalising one letter.
  // Reproduced against this repo's own Express before this fix.
  //
  // Lowercasing here is safe precisely because every prefix and pattern below
  // is lowercase ASCII, and this value is used ONLY to choose a policy — never
  // to route, and never to look anything up. The audit row records the path as
  // it actually arrived, so a probing attempt is still visible as one.
  //
  // app.ts also sets "case sensitive routing", so a capitalised path now 404s
  // before it gets here. Both, deliberately: the routing flag is a global
  // someone could turn off, and this function is unit-tested.
  const path = rawPath.toLowerCase();

  if (READ_METHODS.has(method.toUpperCase())) {
    // Reads: all roles, including EXTERNAL_CA. §12.2 says an external CA is
    // brought in to look at the books; a CA who cannot read them is not
    // a role, it is a locked door.
    return { allowed: true, reason: null, requiredRoles: ROLE_ORDER };
  }

  for (const e of EXPLICIT_POLICIES) {
    if (!e.pattern.test(path)) continue;
    return e.roles.includes(normalised)
      ? { allowed: true, reason: null, requiredRoles: e.roles }
      : {
          allowed: false,
          reason: `Your role (${normalised}) cannot perform ${e.what}. That needs ${e.roles.join(", ")}.`,
          requiredRoles: e.roles,
        };
  }

  if (READ_LIKE_WRITES.some((re) => re.test(path))) {
    // Still not open to VIEWER or EXTERNAL_CA: running a scenario or asking
    // the AI costs money and writes an audit row, and a read-only guest
    // should not be able to do either.
    const roles: MembershipRole[] = ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT", "ANALYST"];
    return roles.includes(normalised)
      ? { allowed: true, reason: null, requiredRoles: roles }
      : { allowed: false, reason: `Your role (${normalised}) is read-only.`, requiredRoles: roles };
  }

  const policy =
    [...WRITE_POLICIES]
      .filter((p) => path === p.prefix || path.startsWith(p.prefix === "/" ? "/" : `${p.prefix}/`) || path === p.prefix)
      .sort((a, b) => b.prefix.length - a.prefix.length)[0] ?? WRITE_POLICIES[WRITE_POLICIES.length - 1]!;

  if (policy.roles.includes(normalised)) return { allowed: true, reason: null, requiredRoles: policy.roles };
  return {
    allowed: false,
    reason: `Your role (${normalised}) cannot perform ${policy.what}. That needs ${policy.roles.join(", ")}.`,
    requiredRoles: policy.roles,
  };
}

/** Runs on every authenticated route. See the note at the top of this file. */
export function enforceRbac(req: Request, res: Response, next: NextFunction) {
  const auth = req.auth;
  if (!auth) {
    // resolveOrgContext already answered. Defensive only.
    next();
    return;
  }

  // originalUrl carries the query string; the policy is about the path.
  const path = req.originalUrl.split("?")[0] ?? "/";
  const decision = decideAccess(auth.role, req.method, path);

  if (decision.allowed) {
    next();
    return;
  }

  // §29: a refused write is a security event, and the ones worth reading are
  // the refusals, not the successes. Fire-and-forget so a failure to audit
  // cannot turn a clean 403 into a 500 — the refusal itself has already
  // happened either way.
  void writeAudit({
    organizationId: auth.organizationId,
    actorType: "USER",
    actorId: auth.userId,
    action: "rbac.denied",
    entityType: "ROUTE",
    entityId: `${req.method} ${path}`,
    metadata: { role: auth.role, requiredRoles: decision.requiredRoles },
  }).catch(() => {});

  res.status(403).json({
    error: "insufficient_role",
    message: decision.reason,
    yourRole: normaliseRole(auth.role),
    requiredRoles: decision.requiredRoles,
  });
}

/**
 * Explicit per-route guard, for the handful of places the path policy cannot
 * express — "only an OWNER may transfer ownership", say. Composes on top of
 * enforceRbac rather than replacing it.
 */
export function requireRole(...roles: MembershipRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = normaliseRole(req.auth?.role);
    if (roles.includes(role)) {
      next();
      return;
    }
    res.status(403).json({
      error: "insufficient_role",
      message: `This action needs ${roles.join(" or ")}. Your role is ${role}.`,
      yourRole: role,
      requiredRoles: roles,
    });
  };
}
