import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

// WHO IS ACTUALLY USING THIS PRODUCT.
//
// Nothing recorded it. The obvious substitute — deriving activity from
// AuditLog — is worse than no answer, because AuditLog only records writes.
// A founder who opens the dashboard every morning, reads their numbers and
// changes nothing appears completely dormant in it. That is not a small
// undercount, it is an undercount concentrated on exactly the behaviour this
// product is for, and every derived figure (DAU, retention, "dormant" lists)
// would be wrong in the same direction while looking perfectly plausible.
//
// So the fact gets written down: Membership.lastSeenAt, stamped by any
// authenticated request.
//
// THROTTLED IN PROCESS, NOT IN REDIS. The naive version writes a row on every
// request, putting a database write in front of all 89 read endpoints. The
// standard fix is a Redis SET NX EX as a distributed lock — but that trades one
// I/O for another on a box that is CPU-bound and where a page load already
// fires ~20 requests, and it buys precision nobody consumes.
//
// A per-process Map is enough. Four API workers each throttle independently, so
// the worst case is four writes per five minutes per active user instead of
// one. That is a rounding error against the traffic that provoked them, and it
// costs nothing on the request path.

const WINDOW_MS = 5 * 60_000;

/** (organizationId, clerkUserId) -> when we last wrote for that pair. */
const lastWrite = new Map<string, number>();

// Entries outlive the sessions that made them, so the Map is swept rather than
// left to grow for the process's lifetime. Hourly is far more often than
// necessary — the Map is bounded by concurrently active users either way — and
// cheap enough not to think about.
const sweep = setInterval(
  () => {
    const cutoff = Date.now() - WINDOW_MS * 2;
    for (const [key, at] of lastWrite) {
      if (at < cutoff) lastWrite.delete(key);
    }
  },
  60 * 60_000,
);
sweep.unref();

/** Test seam. */
export function resetLastSeenForTest(): void {
  lastWrite.clear();
}

/** True if this pair is due a write, and claims the window if so. */
export function claimWindow(organizationId: string, userId: string, now = Date.now()): boolean {
  const key = `${organizationId}|${userId}`;
  const previous = lastWrite.get(key);
  if (previous !== undefined && now - previous < WINDOW_MS) return false;
  lastWrite.set(key, now);
  return true;
}

/**
 * Stamp Membership.lastSeenAt, at most once per window per user per process.
 *
 * Never awaited and never able to fail a request. This is bookkeeping about the
 * request, not part of serving it — a person whose activity we failed to record
 * still gets their dashboard. updateMany rather than update because a member
 * Clerk knows about may have no Membership row yet (the webhook can lag); that
 * is a normal state, and it must be a no-op here rather than a thrown
 * RecordNotFound on a route that was working fine.
 */
export function markLastSeen(req: Request, _res: Response, next: NextFunction): void {
  const auth = req.auth;
  if (!auth) {
    next();
    return;
  }

  if (claimWindow(auth.organizationId, auth.userId)) {
    const at = new Date();
    const day = at.toISOString().slice(0, 10);

    void Promise.all([
      prisma.membership.updateMany({
        where: { organizationId: auth.organizationId, clerkUserId: auth.userId },
        data: { lastSeenAt: at },
      }),
      // Presence for the day, so a daily-active chart is possible at all.
      // lastSeenAt alone cannot produce one: it is overwritten, so yesterday's
      // actives vanish the moment the same person returns today.
      prisma.userActivityDay.upsert({
        where: {
          organizationId_clerkUserId_day: { organizationId: auth.organizationId, clerkUserId: auth.userId, day },
        },
        create: { organizationId: auth.organizationId, clerkUserId: auth.userId, day, lastSeenAt: at },
        update: { lastSeenAt: at },
      }),
    ]).catch((err: unknown) => {
      logger.warn({ err, userId: auth.userId }, "last_seen_write_failed");
    });
  }

  next();
}
