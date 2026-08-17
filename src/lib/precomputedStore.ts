import { logger } from "./logger.js";
import { prisma } from "./prisma.js";

// THE DURABLE HALF OF calcCache.
//
// WHY THIS EXISTS. calcCache holds answers in Redis for sixty seconds. That is
// the right window for a figure that moves with the clock, and completely the
// wrong one for the expensive metrics: profiling on 2026-08-17 measured
// contribution-margin at 810ms over an eight-month window, revenue at 735ms,
// product-profitability at 647ms, and cost rising linearly with rows scanned.
// Under a 60s TTL that work is redone EVERY MINUTE for as long as anyone keeps
// the page open — and once a minute, forever, is not a cache, it is a schedule.
//
// The load test made the consequence concrete: one user on a cold cache took
// the box to 74% CPU while sixty users on a warm one sat at 15%. Cold is the
// only regime that hurts, and a TTL guarantees a return to it.
//
// WHAT CHANGES. Nothing about the answers. This stores the exact body calcCache
// already produced, under the exact key it already computes, and returns it
// byte-for-byte. No calc module is touched, so no figure can move — which is
// the property that made this the right first step rather than decomposing
// 1,800 lines of layered margin logic into day-additive components.
//
// WHY IT IS SAFE TO KEEP INDEFINITELY. Because it is NOT time-bounded, it must
// be invalidated by writes rather than by a clock — and it is: every write path
// a user can observe already calls invalidateOrgReads (sync completion and
// failure, reconciliation runs, manual pair/write-off/exception, uploads,
// inbound email, cost edits), which now drops these rows too. Rows are DELETED
// on invalidation, never marked stale and served anyway. A figure whose inputs
// have changed is not a slightly old figure, it is a wrong one.
//
// THE ONE THING IT DELIBERATELY DOES NOT COVER. Figures that move with the
// clock rather than with a write — the stale-COD bucket ageing parcels into
// itself, freshness counting minutes since a sync. Those have no write to
// invalidate them, so they are kept out by name below rather than being served
// from a row that nothing will ever expire.

/**
 * Metric names whose answer changes with the passage of time alone.
 *
 * Redis' 60s TTL is what keeps these honest, so they must never be persisted
 * here — nothing would ever invalidate them.
 */
const CLOCK_DRIVEN = new Set(["status", "cash-forecast", "reconciliation-summary"]);

export function isPersistable(name: string): boolean {
  return !CLOCK_DRIVEN.has(name);
}

/**
 * Read a previously computed body. Returns null on anything unexpected: a
 * durable cache that can fail a request is worse than no durable cache.
 */
export async function readPrecomputed(organizationId: string, variant: string): Promise<string | null> {
  try {
    const row = await prisma.precomputedResponse.findUnique({
      where: { organizationId_variant: { organizationId, variant } },
      select: { body: true },
    });
    return row?.body ?? null;
  } catch (err) {
    logger.warn({ err, variant }, "precomputed_read_failed");
    return null;
  }
}

/** Store a computed body. Fire-and-forget: never on the request's critical path. */
export function writePrecomputed(organizationId: string, variant: string, body: string): void {
  prisma.precomputedResponse
    .upsert({
      where: { organizationId_variant: { organizationId, variant } },
      create: { organizationId, variant, body, computedAt: new Date() },
      update: { body, computedAt: new Date() },
    })
    .catch((err: unknown) => {
      logger.warn({ err, variant }, "precomputed_write_failed");
    });
}

/**
 * Drop everything stored for an organisation.
 *
 * Called from invalidateOrgReads, so it runs on every observable write. Awaited
 * by nothing — a failed invalidation must not fail the write — but it is
 * logged, because unlike the Redis half there is no TTL underneath to bound the
 * damage if this silently stops working.
 */
export function invalidatePrecomputed(organizationId: string): void {
  prisma.precomputedResponse
    .deleteMany({ where: { organizationId } })
    .catch((err: unknown) => {
      logger.error({ err, organizationId }, "precomputed_invalidate_failed");
    });
}
