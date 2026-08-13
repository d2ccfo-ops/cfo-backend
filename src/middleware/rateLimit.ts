import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";
import { redisConnection } from "../lib/redis.js";

// §27 per-organisation rate limiting (P5.7).
//
// WHY PER-ORGANISATION AND NOT PER-IP. Every request to this API carries a
// verified Clerk organisation claim, and an IP is neither stable (mobile
// networks, corporate NAT) nor meaningful (two colleagues behind one office IP
// are two tenants' worth of legitimate traffic). Limiting by org means one
// customer's runaway script cannot degrade another's dashboard, which is the
// only property that actually matters on a multi-tenant API.
//
// REDIS, NOT MEMORY. An in-memory counter is per-process, so it silently
// multiplies by however many API instances are running — a "60 per minute"
// limit that is really 180 across three pods is a limit nobody can reason
// about. It also resets on every deploy. The cost is one round trip per
// request, on a Redis connection this process already holds.
//
// FAILING OPEN IS DELIBERATE. If Redis is unreachable the request proceeds. A
// rate limiter that takes the product down when its counter store hiccups has
// caused a worse outage than the abuse it exists to prevent — and this is a
// fairness mechanism, not an authentication one. The failure is logged so it
// cannot be silent.

export interface RateLimitOptions {
  /** Requests allowed in the window. */
  max: number;
  windowSeconds: number;
  /** Distinguishes one limiter's counters from another's. */
  bucket: string;
}

// Reads generously, writes tightly, ingestion tightest of all. A dashboard
// page fans out to a dozen metric endpoints at once, so a read limit that
// looks strict on paper locks out ordinary use; an ingest endpoint accepts a
// 50 MB body and does real parsing work, so it earns a much lower ceiling.
export const READ_LIMIT: RateLimitOptions = { max: 600, windowSeconds: 60, bucket: "read" };
export const WRITE_LIMIT: RateLimitOptions = { max: 120, windowSeconds: 60, bucket: "write" };
export const INGEST_LIMIT: RateLimitOptions = { max: 20, windowSeconds: 60, bucket: "ingest" };
// The AI costs real money per call, which no other endpoint does.
export const AI_LIMIT: RateLimitOptions = { max: 30, windowSeconds: 60, bucket: "ai" };

export interface LimitDecision {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

/**
 * Fixed-window counter.
 *
 * Chosen over a sliding window deliberately: a sliding window needs either a
 * sorted set per key (memory that grows with traffic) or a Lua script, and the
 * failure mode it prevents — a burst straddling a window boundary spending
 * twice the budget — is not one this API cares about. Nothing here is billed
 * per request except the AI path, which has its own much lower ceiling.
 */
export async function consume(key: string, opts: RateLimitOptions): Promise<LimitDecision> {
  const window = Math.floor(Date.now() / 1000 / opts.windowSeconds);
  const redisKey = `ratelimit:${opts.bucket}:${key}:${window}`;

  const count = await redisConnection.incr(redisKey);
  if (count === 1) {
    // Only on the first hit of a window — re-expiring on every request would
    // turn a fixed window into a rolling one that never resets under sustained
    // load, and a client at exactly the limit would be locked out forever.
    await redisConnection.expire(redisKey, opts.windowSeconds);
  }

  return {
    allowed: count <= opts.max,
    remaining: Math.max(0, opts.max - count),
    resetSeconds: opts.windowSeconds - (Math.floor(Date.now() / 1000) % opts.windowSeconds),
  };
}

export function rateLimit(opts: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Falls back to the user id, then to the IP. An unauthenticated request
    // that reaches a limiter has already failed auth or is on its way to; the
    // IP is a poor key but better than an unbounded one.
    const key = req.auth?.organizationId ?? req.auth?.userId ?? req.ip ?? "anonymous";

    let decision: LimitDecision;
    try {
      decision = await consume(key, opts);
    } catch (err) {
      logger.warn({ err, bucket: opts.bucket }, "rate_limit_store_unavailable");
      next();
      return;
    }

    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
    res.setHeader("X-RateLimit-Reset", String(decision.resetSeconds));

    if (decision.allowed) {
      next();
      return;
    }

    res.setHeader("Retry-After", String(decision.resetSeconds));
    logger.warn({ key, bucket: opts.bucket, max: opts.max }, "rate_limit_exceeded");
    res.status(429).json({
      error: "rate_limited",
      // Named, with the number and the wait. "Too many requests" tells a
      // developer nothing about whether they are near a real ceiling or a
      // configuration mistake.
      message: `This organisation has made more than ${opts.max} ${opts.bucket} requests in ${opts.windowSeconds} seconds. Try again in ${decision.resetSeconds}s.`,
      retryAfterSeconds: decision.resetSeconds,
    });
  };
}

// Paths whose work is expensive enough to deserve their own ceiling. Matched
// as prefixes and kept short: a long list is one somebody stops maintaining.
const INGEST_PREFIXES = ["/connections/bank", "/connections/gokwik", "/connections/bluedart", "/connections/ad-spend", "/costs"];

/**
 * Pick the right bucket from the request itself.
 *
 * Exported and pure so the choice can be swept in tests over every real path,
 * rather than inferred from where somebody happened to mount a limiter.
 */
export function limitFor(method: string, rawPath: string): RateLimitOptions {
  // Lowercased for the same reason middleware/rbac.ts does it: Express 4 routes
  // case-insensitively, so /Costs reached the handler while missing this
  // prefix list and silently got the 120/min write ceiling instead of the
  // 20/min ingest one — the tighter limit that exists because the route parses
  // a 50 MB upload. Every prefix here is lowercase, and this value only picks a
  // bucket.
  const path = rawPath.toLowerCase();
  if (path.startsWith("/ai")) return AI_LIMIT;
  if (INGEST_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return INGEST_LIMIT;
  const isRead = method === "GET" || method === "HEAD" || method === "OPTIONS";
  return isRead ? READ_LIMIT : WRITE_LIMIT;
}

/**
 * The limiter that runs on every authenticated route.
 *
 * Appended to the requireAuth array rather than mounted in app.ts, for the
 * reason stated there: a limiter that runs before resolveOrgContext has no
 * organisation to key on and silently degrades to per-IP. Same discipline as
 * the RBAC guard — anything that authenticates is also limited.
 */
export async function enforceRateLimit(req: Request, res: Response, next: NextFunction) {
  const path = (req.originalUrl ?? req.path ?? "/").split("?")[0] ?? "/";
  return rateLimit(limitFor(req.method, path))(req, res, next);
}
