import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

// A short-lived, org-scoped cache for the handful of WHOLE-ORGANISATION
// read-only computations that every dashboard request re-derives identically:
// the §28 data-status map, the reconciliation legs, the unranged COD position
// and the freight summary. Measured on the production box these are ~500ms of
// database CPU each time, recomputed six times per page load and again on
// every navigation — by far the largest remaining cost after the calc modules
// themselves were converted to SQL aggregation.
//
// WHY THIS IS SAFE ON A SYSTEM THAT REFUSES TO SHOW WRONG NUMBERS:
//   - Range-dependent and entity-dependent figures are NEVER cached — only
//     org-wide reads whose inputs change when data is written, not when the
//     picker moves.
//   - Every user action that writes those inputs INVALIDATES the org's keys
//     in the same request/job (sync completion, reconciliation run, manual
//     pair/write-off/exception, statement uploads, cost edits — see
//     invalidateOrgReads callers). A reader who presses a button sees its
//     effect immediately.
//   - The 60s TTL is the backstop for writers with no invalidation hook
//     (webhooks, OAuth connects, seed scripts running out of process). A
//     webhook's effect appearing within a minute is indistinguishable from
//     the sync cadence that produced it.
//
// Redis rather than in-process: the API runs as a cluster of workers plus a
// separate sync-worker process, and invalidation must reach all of them —
// an in-process map cannot be cleared by the worker that just finished a
// sync. Per the note in lib/redis.ts, this is a SECOND plain client, so a
// queue outage can't take caching down or vice versa.
//
// A Redis failure degrades to computing — never to failing the request, and
// never to serving anything stale beyond the TTL.

const cacheRedis = new Redis(env.REDIS_URL, {
  // Fail fast and fall through to compute rather than queueing commands
  // while Redis is down — a cache that blocks is worse than no cache.
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  // Connect on first use, not at import — scripts and tests import calc
  // modules (which import this) without ever touching the cache.
  lazyConnect: true,
});
cacheRedis.on("error", (err) => {
  // ioredis emits per-connection errors; without a listener they become
  // uncaught exceptions. One log line per incident is enough.
  logger.warn({ err: err.message }, "org_read_cache_redis_error");
});
// The cache must never be the thing keeping a process alive: check scripts
// and the harness import calc modules, do their work, and expect to exit —
// an open cache socket held every one of them hostage until a timeout.
// unref'd, the socket lives exactly as long as something else does.
cacheRedis.on("connect", () => {
  cacheRedis.stream?.unref?.();
});

const TTL_SECONDS = 60;

// Money values are BigInt and a few reads carry Dates; JSON has neither.
// Round-trip both through explicit markers so a cached value is
// indistinguishable from a computed one.
function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return { $big: v.toString() };
    return v;
  });
}

function decode(payload: string): unknown {
  return JSON.parse(payload, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("$big" in v && typeof v.$big === "string" && Object.keys(v).length === 1) return BigInt(v.$big);
      if ("$date" in v && typeof v.$date === "string" && Object.keys(v).length === 1) return new Date(v.$date);
    }
    return v;
  });
}

// Dates can't be caught in the replacer (JSON.stringify calls toJSON before
// the replacer sees the Date), so they're marked in a pre-pass.
function markDates(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(markDates);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = markDates(v);
    return out;
  }
  return value;
}

// Registry of cached read names, so invalidation deletes exact keys rather
// than scanning. A name registers itself the first time cachedOrgRead wraps
// its function — before any request can populate it.
const registeredNames = new Set<string>();

const keyFor = (name: string, organizationId: string) => `calc:${organizationId}:${name}`;

// In-flight coalescing per (name, org) within this process, layered UNDER the
// Redis read — a page-load burst must not stampede Redis misses into six
// parallel computations either.
const inFlight = new Map<string, Promise<unknown>>();

export function cachedOrgRead<T>(
  name: string,
  compute: (organizationId: string) => Promise<T>
): (organizationId: string) => Promise<T> {
  registeredNames.add(name);
  return async (organizationId: string): Promise<T> => {
    const flightKey = `${name}:${organizationId}`;
    const existing = inFlight.get(flightKey);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      const key = keyFor(name, organizationId);
      try {
        const hit = await cacheRedis.get(key);
        if (hit !== null) return decode(hit) as T;
      } catch {
        // Redis unavailable — compute.
      }
      const value = await compute(organizationId);
      try {
        await cacheRedis.set(key, encode(markDates(value)), "EX", TTL_SECONDS);
      } catch {
        // Not being able to store is not an error worth a request failing.
      }
      return value;
    })();

    inFlight.set(flightKey, promise);
    promise.finally(() => inFlight.delete(flightKey)).catch(() => {});
    return promise;
  };
}

// ---------------------------------------------------------------------------
// WHOLE-RESPONSE CACHE
//
// The block above caches org-wide reads, which is deliberately the safest
// subset: one key per (org, name), nothing that moves when the picker moves.
// Measured afterwards, that is not where the time goes. Firing the overview's
// twenty requests together makes each one 4.9-8.9x slower than it is alone,
// because two vCPUs are shared by Postgres, three Node processes, Caddy and
// Redis — one test cycle spent 39.1 SECONDS of Postgres execution time across
// 779 calls. Every endpoint is already fast; the box has nowhere to run them.
//
// So the win is not computing faster, it is not computing again. These are
// GET requests whose answer is a pure function of (organisation, entity,
// window) over data that changes only when something is written — and every
// write that matters already calls invalidateOrgReads. That makes the whole
// serialised body cacheable, not just its org-wide parts.
//
// Bodies are stored as the exact JSON string Express was about to send, which
// is why there is no BigInt codec here: money is already strings by this
// point (res.json would throw on a BigInt), so a cached body is byte-identical
// to a computed one rather than merely equivalent to it.
//
// Variants cannot be enumerated the way registeredNames enumerates the block
// above — there is one key per window the reader has looked at. Each written
// key is therefore recorded in a per-org index set so invalidation deletes
// exact keys instead of SCANning the keyspace on a shared Redis.

const RESPONSE_PREFIX = "resp";
const responseKeyFor = (organizationId: string, variant: string) =>
  `${RESPONSE_PREFIX}:${organizationId}:${variant}`;
const indexKeyFor = (organizationId: string) => `calcidx:${organizationId}`;

export async function readCachedResponse(organizationId: string, variant: string): Promise<string | null> {
  try {
    return await cacheRedis.get(responseKeyFor(organizationId, variant));
  } catch {
    // Redis unavailable — the caller computes, exactly as before caching.
    return null;
  }
}

export async function writeCachedResponse(organizationId: string, variant: string, body: string): Promise<void> {
  const key = responseKeyFor(organizationId, variant);
  const index = indexKeyFor(organizationId);
  try {
    // Pipelined so a page-load burst costs one round trip per response rather
    // than three. The index outlives its members on purpose: at 2x the body
    // TTL it is still present to be read when the last body it names expires.
    await cacheRedis
      .multi()
      .set(key, body, "EX", TTL_SECONDS)
      .sadd(index, key)
      .expire(index, TTL_SECONDS * 2)
      .exec();
  } catch {
    // Not being able to store is not an error worth failing a request over.
  }
}

/**
 * Drop every cached read for this organisation — both the org-wide
 * computations and any whole responses derived from them. Called by the write
 * paths a user can observe cause-and-effect through: sync job completion and
 * failure, reconciliation runs, manual pair/write-off/exception actions,
 * statement/CSV/PDF uploads (direct and via inbound email), and cost edits.
 * Fire-and-forget: invalidation failing must not fail the write that
 * triggered it — the TTL bounds the damage at 60 seconds.
 */
export function invalidateOrgReads(organizationId: string): void {
  const named = [...registeredNames].map((name) => keyFor(name, organizationId));
  if (named.length > 0) cacheRedis.del(...named).catch(() => {});

  // Responses are read out of the index rather than guessed, because their
  // keys carry windows nobody here can enumerate. The index is deleted last;
  // if the process dies between the two, the bodies still expire on their TTL.
  const index = indexKeyFor(organizationId);
  cacheRedis
    .smembers(index)
    .then((keys) => (keys.length > 0 ? cacheRedis.del(...keys, index) : cacheRedis.del(index)))
    .catch(() => {});
}
