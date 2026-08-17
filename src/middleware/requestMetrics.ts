import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

// HOW FAST IS THIS API, ACROSS ALL TENANTS — the question nothing could answer.
//
// pino-http already logs every request, but a log line is not a measurement:
// answering "what is p95 on /metrics/revenue this week" from logs means
// shipping and indexing them somewhere, which is a bigger commitment than the
// question deserves. Prometheus is the other standard answer and is also a new
// piece of infrastructure on a box already running seven containers.
//
// So: aggregate in the process, flush a summary row once a minute.
//
// WHAT MAKES THIS SAFE TO PUT IN FRONT OF EVERY REQUEST. The hot path does no
// I/O at all — it increments integers in a Map on the response's 'finish'
// event, after the client already has its bytes. The only database work
// happens on a timer, at most (routes x methods) upserts a minute. A per-request
// insert was the first design and would have written more rows than the orders
// table while carrying no information the aggregate does not.
//
// WHY THE COUNTERS ARE WRITTEN WITH increment. Four API cluster workers each
// hold their own Map and each flush into the same (minute, route, method) row.
// Read-modify-write would let two of them clobber each other and silently
// undercount by up to 4x. `increment` pushes the addition into Postgres where
// it is atomic.

/**
 * Non-cumulative latency bands, in milliseconds, paired with their column.
 *
 * One list of pairs rather than two parallel arrays: parallel arrays are one
 * careless edit away from a bound being mapped to the wrong column, and that
 * error would be completely invisible — every number would still add up, they
 * would just be filed under the wrong latency.
 */
const BANDS = [
  [10, "le10"],
  [25, "le25"],
  [50, "le50"],
  [100, "le100"],
  [250, "le250"],
  [500, "le500"],
  [1000, "le1000"],
  [2500, "le2500"],
  [5000, "le5000"],
] as const;

type BandField = (typeof BANDS)[number][1] | "leInf";

/** Which histogram column a duration lands in. Exported for its test. */
export function bandOf(ms: number): BandField {
  for (const [bound, field] of BANDS) {
    if (ms <= bound) return field;
  }
  return "leInf";
}

/** Floor to the minute, UTC. The grain of the table. */
export function minuteBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

/**
 * The route PATTERN this request matched, never its URL.
 *
 * Express fills req.route only once a handler matches, and it holds the
 * pattern — "/:id/sync" — while req.originalUrl holds the resolved path. Using
 * the latter would key this table by resource id and query string, growing a
 * row per order per minute. Anything unmatched collapses into one bucket
 * rather than being dropped: a flood of 404s is a real signal, and it is only
 * a signal if it is countable.
 */
export function routeOf(req: Request): string {
  const path = req.route?.path;
  if (typeof path !== "string") return "(unmatched)";
  const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const joined = `${base}${path}`;
  if (joined.length === 0) return "/";
  // A router mounted at /x with a route at "/" produces "/x/", which is the
  // same endpoint as "/x" and must not be two rows.
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

interface Bucket {
  bucketStart: Date;
  route: string;
  method: string;
  count: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  totalMs: number;
  maxMs: number;
  cacheHit: number;
  cacheMiss: number;
  bands: Record<BandField, number>;
}

function emptyBands(): Record<BandField, number> {
  return { le10: 0, le25: 0, le50: 0, le100: 0, le250: 0, le500: 0, le1000: 0, le2500: 0, le5000: 0, leInf: 0 };
}

const buckets = new Map<string, Bucket>();

// A ceiling on distinct keys held in memory, in case a future route pattern
// turns out to carry something high-cardinality after all. Dropping is
// preferable to an unbounded Map in a long-lived process — but it is LOUD, not
// silent, because a metrics table that quietly stopped recording a route is
// worse than one that is obviously broken.
const MAX_KEYS = 2000;
let droppedKeys = 0;

export interface Observation {
  at: Date;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  cache: "hit" | "miss" | null;
}

/** Fold one finished request into the in-memory aggregate. Pure, for its test. */
export function observe(o: Observation): void {
  const bucketStart = minuteBucket(o.at);
  const key = `${bucketStart.getTime()}|${o.route}|${o.method}`;

  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_KEYS) {
      droppedKeys += 1;
      return;
    }
    b = {
      bucketStart,
      route: o.route,
      method: o.method,
      count: 0,
      status2xx: 0,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
      totalMs: 0,
      maxMs: 0,
      cacheHit: 0,
      cacheMiss: 0,
      bands: emptyBands(),
    };
    buckets.set(key, b);
  }

  b.count += 1;
  b.totalMs += o.durationMs;
  if (o.durationMs > b.maxMs) b.maxMs = o.durationMs;
  b.bands[bandOf(o.durationMs)] += 1;

  if (o.status >= 500) b.status5xx += 1;
  else if (o.status >= 400) b.status4xx += 1;
  else if (o.status >= 300) b.status3xx += 1;
  else if (o.status >= 200) b.status2xx += 1;

  if (o.cache === "hit") b.cacheHit += 1;
  else if (o.cache === "miss") b.cacheMiss += 1;
}

/** Current aggregate, emptied. Callers own what they take. */
export function drain(): Bucket[] {
  const out = [...buckets.values()];
  buckets.clear();
  return out;
}

/** Test seam only — discards without writing. */
export function resetForTest(): void {
  buckets.clear();
  droppedKeys = 0;
}

export async function flush(): Promise<void> {
  const pending = drain();
  if (droppedKeys > 0) {
    logger.warn({ droppedKeys, maxKeys: MAX_KEYS }, "request_metrics_cardinality_cap_hit");
    droppedKeys = 0;
  }
  if (pending.length === 0) return;

  for (const b of pending) {
    try {
      await prisma.requestMetric.upsert({
        where: { bucketStart_route_method: { bucketStart: b.bucketStart, route: b.route, method: b.method } },
        create: {
          bucketStart: b.bucketStart,
          route: b.route,
          method: b.method,
          count: b.count,
          status2xx: b.status2xx,
          status3xx: b.status3xx,
          status4xx: b.status4xx,
          status5xx: b.status5xx,
          totalMs: b.totalMs,
          maxMs: b.maxMs,
          cacheHit: b.cacheHit,
          cacheMiss: b.cacheMiss,
          ...b.bands,
        },
        update: {
          count: { increment: b.count },
          status2xx: { increment: b.status2xx },
          status3xx: { increment: b.status3xx },
          status4xx: { increment: b.status4xx },
          status5xx: { increment: b.status5xx },
          totalMs: { increment: b.totalMs },
          // Not an increment: a maximum is not additive. Postgres has no
          // "greatest of existing and new" in a Prisma update, so this is the
          // one field that can lose a spike when two workers flush the same
          // minute concurrently. Documented rather than fixed because maxMs is
          // a garnish and the histogram is the load-bearing latency record.
          maxMs: b.maxMs,
          cacheHit: { increment: b.cacheHit },
          cacheMiss: { increment: b.cacheMiss },
          le10: { increment: b.bands.le10 },
          le25: { increment: b.bands.le25 },
          le50: { increment: b.bands.le50 },
          le100: { increment: b.bands.le100 },
          le250: { increment: b.bands.le250 },
          le500: { increment: b.bands.le500 },
          le1000: { increment: b.bands.le1000 },
          le2500: { increment: b.bands.le2500 },
          le5000: { increment: b.bands.le5000 },
          leInf: { increment: b.bands.leInf },
        },
      });
    } catch (err) {
      // Telemetry must never be able to take the API down, and a lost minute of
      // metrics is not worth a retry queue.
      logger.error({ err, route: b.route }, "request_metrics_flush_failed");
    }
  }
}

/**
 * Routes that are measured but never recorded.
 *
 * /internal/infra/live is polled every couple of seconds by any open console
 * tab. Recorded, one operator watching a gauge for an hour would be ~1,800
 * requests — more traffic than the entire product generates today, sitting at
 * the top of "busiest routes" and dragging every aggregate with it. The
 * observability system would end up reporting mostly itself.
 *
 * This is a narrow exemption, not a policy: every other /internal route IS
 * recorded, because console usage is real load on the box and hiding it would
 * be its own kind of lie. Only the self-polling one is dropped.
 */
const UNRECORDED_ROUTES = new Set(["/internal/infra/live"]);

/**
 * The middleware. Records on 'finish', so nothing here is on the path between
 * the request arriving and the response being written.
 */
export function requestMetrics() {
  return function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      if (UNRECORDED_ROUTES.has(routeOf(req))) return;
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const header = res.getHeader("X-Calc-Cache");
      const cache = header === "hit" ? "hit" : header === "miss" ? "miss" : null;
      observe({
        at: new Date(),
        route: routeOf(req),
        method: req.method,
        status: res.statusCode,
        durationMs,
        cache,
      });
    });
    next();
  };
}

let timer: NodeJS.Timeout | null = null;

export function startRequestMetricsFlush(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void flush();
  }, intervalMs);
  // unref so a script that imports the app is not held open by this timer.
  timer.unref();
}

export function stopRequestMetricsFlush(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
