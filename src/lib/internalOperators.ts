import { prisma } from "./prisma.js";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

// WHO MAY USE THE INTERNAL CONSOLE.
//
// Two sources, and the difference between them is the whole design.
//
//   ENVIRONMENT (INTERNAL_ADMIN_USER_IDS) — break glass. Set by deploy, changed
//   only by someone with shell access on the box, and NOT REVOKABLE FROM THE
//   CONSOLE. It is also still the feature switch: empty means /internal does not
//   exist at all, so nobody can grant their way into a console that was never
//   deliberately turned on.
//
//   DATABASE (internal_operators) — everyday grants, made from the console by an
//   existing operator, each one recording who granted it and when.
//
// The first is what makes the second safe. A compromised console session can add
// operators and remove operators it granted; it can never remove the accounts
// that were put there by deploy, so there is always a way back in and always at
// least one account whose access did not come from inside the blast radius.
//
// FAILURE IS CLOSED, WITH ONE DELIBERATE EXCEPTION. If the database read fails,
// a database-granted operator is denied — an unreadable operator table must not
// mean "let everyone in". Environment operators are checked first and never
// touch the database, so a Postgres outage still leaves the console reachable by
// exactly the people who could fix it. That is the point of break glass.

/** Parsed once. This list changes by deploy, visibly, and that is intentional. */
const ENV_OPERATORS: ReadonlySet<string> = new Set(
  (env.INTERNAL_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

/**
 * How long a database grant (or revocation) takes to be believed everywhere.
 *
 * A cache is not optional here: this runs on every /internal request, and the
 * console fires a dozen on one page load. Fifteen seconds is chosen against the
 * REVOKE direction, not the grant direction — a grant arriving late is an
 * operator pressing refresh, while a revoke arriving late is someone keeping
 * cross-tenant read access after being removed. Anything longer would need a
 * cross-process invalidation channel to stay defensible; anything shorter turns
 * a page load into a burst of identical queries.
 *
 * The API runs more than one process, so an in-process invalidation on write
 * cannot cover its siblings. This TTL is the real mechanism and the local
 * invalidation is only there to make the acting operator's own next request
 * consistent with what they just did.
 */
const CACHE_TTL_MS = 15_000;

let cache: { at: number; ids: ReadonlySet<string> } | null = null;

export function isEnvOperator(userId: string): boolean {
  return ENV_OPERATORS.has(userId);
}

export function envOperatorIds(): string[] {
  return [...ENV_OPERATORS];
}

/** Empty environment list means the console does not exist. Unchanged. */
export function internalConsoleEnabled(): boolean {
  return ENV_OPERATORS.size > 0;
}

export function invalidateOperatorCache(): void {
  cache = null;
}

async function dbOperatorIds(): Promise<ReadonlySet<string>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.ids;

  const rows = await prisma.internalOperator.findMany({
    where: { revokedAt: null },
    select: { clerkUserId: true },
  });
  const ids = new Set(rows.map((r) => r.clerkUserId));
  cache = { at: now, ids };
  return ids;
}

/**
 * The authorisation question, answered.
 *
 * Environment first and without touching the database — see the failure-is-
 * closed note above.
 */
export async function isOperator(userId: string): Promise<boolean> {
  if (ENV_OPERATORS.has(userId)) return true;
  try {
    return (await dbOperatorIds()).has(userId);
  } catch (err) {
    // Denied, and loudly. This is the branch where the console goes dark for
    // everyone except the break-glass accounts, and an operator staring at a
    // 404 needs this line to exist.
    logger.error({ err, userId }, "internal_operator_lookup_failed");
    return false;
  }
}

export interface OperatorEntry {
  /** null for environment entries — they have no row and no id to revoke. */
  id: string | null;
  clerkUserId: string;
  email: string | null;
  name: string | null;
  source: "environment" | "console";
  note: string | null;
  grantedAt: string | null;
  grantedByEmail: string | null;
  revokedAt: string | null;
  revokedByEmail: string | null;
  /**
   * FALSE for every environment entry. Rendered as a disabled control with the
   * reason, rather than a button that fails — the console should not offer an
   * action it knows the server will refuse.
   */
  revokable: boolean;
}

/**
 * Everyone who has, or has had, console access — both sources in one list.
 *
 * Revoked rows are included rather than filtered out. The question this page
 * answers is not only "who can see cross-tenant data" but "who could, and who
 * decided that", and dropping the revocations would answer only the first.
 */
export async function listOperators(): Promise<OperatorEntry[]> {
  const rows = await prisma.internalOperator.findMany({
    orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { grantedAt: "desc" }],
  });

  const fromDb: OperatorEntry[] = rows.map((r) => ({
    id: r.id,
    clerkUserId: r.clerkUserId,
    email: r.email,
    name: null,
    source: "console" as const,
    note: r.note,
    grantedAt: r.grantedAt.toISOString(),
    grantedByEmail: r.grantedByEmail,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    revokedByEmail: r.revokedByEmail,
    revokable: r.revokedAt === null,
  }));

  // Environment entries last only in construction; the caller sorts. They carry
  // no grant metadata because there is none to carry — nobody clicked anything.
  const fromEnv: OperatorEntry[] = [...ENV_OPERATORS].map((id) => ({
    id: null,
    clerkUserId: id,
    email: null,
    name: null,
    source: "environment" as const,
    note: null,
    grantedAt: null,
    grantedByEmail: null,
    revokedAt: null,
    revokedByEmail: null,
    revokable: false,
  }));

  // An id in both places is shown once, as environment: that is the source that
  // actually decides, and it is the one that cannot be revoked here.
  const envIds = new Set(ENV_OPERATORS);
  return [...fromEnv, ...fromDb.filter((e) => !envIds.has(e.clerkUserId))];
}

/** Active grants only — the count that must never reach zero. */
export async function activeOperatorCount(): Promise<number> {
  const dbCount = await prisma.internalOperator.count({ where: { revokedAt: null } });
  return ENV_OPERATORS.size + dbCount;
}
