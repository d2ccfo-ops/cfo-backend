import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { measureCpuBusy, sampleSystem } from "../../modules/observability/systemSampler.js";
import { readHostReport } from "../../modules/observability/hostFacts.js";
import { readRedisStats } from "../../modules/observability/redisInfo.js";
import { computeCloudCost } from "../../modules/observability/cloudCost.js";
import {
  addHistogram,
  emptyHistogram,
  hoursParam,
  quantileFromHistogram,
  since,
  type HistogramCounts,
} from "./shared.js";

export const internalInfraRouter = Router();

const HOUR_MS = 60 * 60_000;

/**
 * The machine RIGHT NOW, read straight from /proc with no database in the path.
 *
 * This exists because the stored samples have a floor: the sampler writes every
 * SAMPLE_INTERVAL_MS, so polling /system faster than that re-reads the same row
 * and produces a gauge that looks live and is not. Reading the OS directly has
 * no such floor — loadavg() is a couple of microseconds — so this is the one
 * endpoint that can honestly back a moving number.
 *
 * It deliberately does NOT write what it reads. A poll is a glance by one
 * operator, not an observation the history should carry; recording it would let
 * whoever happens to have the tab open decide the resolution of the stored
 * series.
 *
 * Answered by whichever of the four API children the request lands on, which is
 * fine for everything here EXCEPT procRss/procHeap — those describe that one
 * child, not the API as a whole. They are returned anyway because a single
 * child's heap is still the fastest way to spot a leak, but the field names
 * carry the caveat.
 */
internalInfraRouter.get("/live", async (_req, res) => {
  // Concurrently: the CPU measurement is a 250ms wait, and there is no reason
  // for the rest of the snapshot to queue behind it.
  const [s, cpu] = await Promise.all([sampleSystem(), measureCpuBusy()]);
  res.json({
    takenAt: new Date().toISOString(),
    // THE LIVE NUMBER. Measured over cpuWindowMs from per-core jiffy deltas —
    // what the CPU is actually doing, the same arithmetic top does.
    cpuBusyRatio: cpu.busyRatio,
    cpuWindowMs: cpu.windowMs,
    load1: s.load1,
    load5: s.load5,
    load15: s.load15,
    cpuCount: s.cpuCount,
    // Load over cores. Kept beside cpuBusyRatio rather than instead of it
    // because they answer different questions: this one is a queue depth
    // averaged over the last minute and can exceed 1.0; cpuBusyRatio is an
    // instantaneous utilisation and cannot.
    cpuSaturation: s.cpuCount > 0 ? s.load1 / s.cpuCount : null,
    memTotal: s.memTotal.toString(),
    memFree: s.memFree.toString(),
    memUsed: (s.memTotal - s.memFree).toString(),
    diskTotal: s.diskTotal.toString(),
    diskFree: s.diskFree.toString(),
    diskUsed: (s.diskTotal - s.diskFree).toString(),
    // One cluster child's process, not the API's total. See above.
    childProcRssBytes: s.procRssBytes.toString(),
    childProcHeapBytes: s.procHeapBytes.toString(),
  });
});

/**
 * How many points a history response may contain.
 *
 * At a 15s cadence a 7-day window is 40,320 rows — several megabytes of JSON to
 * draw a chart a few hundred pixels wide. Capping the points is not a loss of
 * information at that width; sending them all is.
 */
const MAX_SERIES_POINTS = 300;

/**
 * Reduce a series to at most MAX_SERIES_POINTS by keeping, from each bucket,
 * the single sample with the highest load.
 *
 * PEAK, NOT MEAN, and that choice is the whole point. This console exists to
 * answer "is the box big enough", and averaging is precisely what hides the
 * answer: this workload is bursty — the dashboard fires ~15 metric endpoints at
 * once — so a mean over a bucket flattens the spike that decides the question
 * into a number that says everything is fine.
 *
 * Keeping a REAL sample rather than averaging each field separately matters
 * too: an averaged point is a machine state that never existed, and its memory
 * figure would belong to a different instant than its load figure. Every point
 * returned here was actually observed, all of its fields together.
 */
function downsamplePeak<T extends { load1: number }>(rows: T[], maxPoints = MAX_SERIES_POINTS): T[] {
  if (rows.length <= maxPoints) return rows;
  const bucketSize = Math.ceil(rows.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += bucketSize) {
    const bucket = rows.slice(i, i + bucketSize);
    let peak = bucket[0]!;
    for (const row of bucket) if (row.load1 > peak.load1) peak = row;
    out.push(peak);
  }
  return out;
}

/**
 * The machine: what we provision, what we use, what sits idle.
 *
 * IDLE IS THE POINT. Capacity is billed on what is provisioned, not what is
 * consumed, so the gap between the two is money — and it is the one figure a
 * per-resource gauge does not show you. Both halves are returned for every
 * resource so the caller never has to reconstruct one from the other.
 *
 * On what these numbers mean and do not mean, see the header of
 * modules/observability/systemSampler.ts. Briefly: they are HOST-wide, so they
 * describe every container together and cannot attribute load to one of them.
 */
internalInfraRouter.get("/system", async (req, res) => {
  const hours = hoursParam(req, 24);
  const from = since(hours * HOUR_MS);

  const samples = await prisma.systemSample.findMany({
    where: { takenAt: { gte: from } },
    orderBy: { takenAt: "asc" },
  });

  if (samples.length === 0) {
    // No sample is not zero load. Say so, rather than returning a shape that
    // renders as a flat line at the bottom of a chart.
    res.json({ windowHours: hours, samples: [], summary: null, note: "No samples in this window. The sampler runs in the worker process; check that it is up." });
    return;
  }

  // The CHART is downsampled; the SUMMARY below is not. Averages and peaks are
  // computed over every stored sample, so thinning the line drawn on screen
  // never changes the figure quoted beside it.
  const series = downsamplePeak(samples).map((s) => ({
    takenAt: s.takenAt.toISOString(),
    load1: s.load1,
    load5: s.load5,
    load15: s.load15,
    cpuCount: s.cpuCount,
    // Load divided by cores: 1.0 is fully committed, above 1.0 is a queue.
    cpuSaturation: s.cpuCount > 0 ? s.load1 / s.cpuCount : null,
    memTotal: s.memTotal.toString(),
    memFree: s.memFree.toString(),
    memUsed: (s.memTotal - s.memFree).toString(),
    diskTotal: s.diskTotal.toString(),
    diskFree: s.diskFree.toString(),
    diskUsed: (s.diskTotal - s.diskFree).toString(),
    procRssBytes: s.procRssBytes.toString(),
    procHeapBytes: s.procHeapBytes.toString(),
  }));

  const latest = samples[samples.length - 1]!;
  const saturations = samples.filter((s) => s.cpuCount > 0).map((s) => s.load1 / s.cpuCount);
  const avgSaturation = saturations.length > 0 ? saturations.reduce((a, b) => a + b, 0) / saturations.length : null;
  const peakSaturation = saturations.length > 0 ? Math.max(...saturations) : null;

  const memUsedRatios = samples
    .filter((s) => s.memTotal > 0n)
    .map((s) => Number(s.memTotal - s.memFree) / Number(s.memTotal));
  const avgMemUsed = memUsedRatios.length > 0 ? memUsedRatios.reduce((a, b) => a + b, 0) / memUsedRatios.length : null;

  res.json({
    windowHours: hours,
    samples: series,
    summary: {
      sampleCount: samples.length,
      // Stated so a caller can tell a thinned line from a sparse one — a chart
      // with 300 points out of 40,320 and a chart with 300 points because the
      // sampler was down for six days look identical otherwise.
      seriesPoints: series.length,
      cpuCount: latest.cpuCount,
      // The idle figures, stated directly rather than left as 1 - used.
      avgCpuSaturation: avgSaturation,
      avgCpuIdle: avgSaturation === null ? null : Math.max(0, 1 - avgSaturation),
      peakCpuSaturation: peakSaturation,
      avgMemUsedRatio: avgMemUsed,
      avgMemIdle: avgMemUsed === null ? null : Math.max(0, 1 - avgMemUsed),
      memTotal: latest.memTotal.toString(),
      memFree: latest.memFree.toString(),
      // Disk is billed on PROVISIONED size, so unused space is pure waste and
      // is worth its own figure rather than only a percentage.
      diskTotal: latest.diskTotal.toString(),
      diskFree: latest.diskFree.toString(),
      diskUnusedRatio: latest.diskTotal > 0n ? Number(latest.diskFree) / Number(latest.diskTotal) : null,
    },
  });
});

interface MetricRow extends HistogramCounts {
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
}

/**
 * Per-route traffic and latency.
 *
 * Percentiles come from summed histogram bands, not from an average — see
 * quantileFromHistogram in ./shared.ts for why that distinction is the whole
 * reason the table stores bands at all.
 */
internalInfraRouter.get("/requests", async (req, res) => {
  const hours = hoursParam(req, 24);
  const from = since(hours * HOUR_MS);

  const rows = await prisma.requestMetric.findMany({ where: { bucketStart: { gte: from } } });

  if (rows.length === 0) {
    res.json({ windowHours: hours, routes: [], totals: null, note: "No request metrics in this window." });
    return;
  }

  const byRoute = new Map<string, MetricRow>();
  for (const r of rows) {
    const key = `${r.method} ${r.route}`;
    const existing = byRoute.get(key);
    if (!existing) {
      byRoute.set(key, { ...r });
      continue;
    }
    existing.count += r.count;
    existing.status2xx += r.status2xx;
    existing.status3xx += r.status3xx;
    existing.status4xx += r.status4xx;
    existing.status5xx += r.status5xx;
    existing.totalMs += r.totalMs;
    existing.maxMs = Math.max(existing.maxMs, r.maxMs);
    existing.cacheHit += r.cacheHit;
    existing.cacheMiss += r.cacheMiss;
    Object.assign(existing, addHistogram(existing, r));
  }

  const routes = [...byRoute.values()]
    .map((r) => {
      const p50 = quantileFromHistogram(r, 0.5);
      const p95 = quantileFromHistogram(r, 0.95);
      const p99 = quantileFromHistogram(r, 0.99);
      const cacheTotal = r.cacheHit + r.cacheMiss;
      return {
        route: r.route,
        method: r.method,
        count: r.count,
        errors: r.status4xx + r.status5xx,
        status: { s2xx: r.status2xx, s3xx: r.status3xx, s4xx: r.status4xx, s5xx: r.status5xx },
        errorRate: r.count === 0 ? null : (r.status4xx + r.status5xx) / r.count,
        meanMs: r.count === 0 ? null : Math.round(r.totalMs / r.count),
        maxMs: r.maxMs,
        p50, p95, p99,
        // Null, not zero, when a route is not cached at all. Zero would read as
        // "the cache is failing on this route" rather than "there is no cache
        // in front of it", which are opposite conclusions.
        cacheHitRate: cacheTotal === 0 ? null : r.cacheHit / cacheTotal,
        cacheHit: r.cacheHit,
        cacheMiss: r.cacheMiss,
      };
    })
    .sort((a, b) => (b.p95.ms ?? 0) - (a.p95.ms ?? 0));

  const all = [...byRoute.values()].reduce(
    (acc, r) => {
      acc.count += r.count;
      acc.errors += r.status4xx + r.status5xx;
      acc.totalMs += r.totalMs;
      acc.cacheHit += r.cacheHit;
      acc.cacheMiss += r.cacheMiss;
      acc.hist = addHistogram(acc.hist, r);
      return acc;
    },
    { count: 0, errors: 0, totalMs: 0, cacheHit: 0, cacheMiss: 0, hist: emptyHistogram() },
  );

  const cacheTotal = all.cacheHit + all.cacheMiss;
  res.json({
    windowHours: hours,
    routes,
    totals: {
      count: all.count,
      errors: all.errors,
      errorRate: all.count === 0 ? null : all.errors / all.count,
      requestsPerMinute: all.count / (hours * 60),
      meanMs: all.count === 0 ? null : Math.round(all.totalMs / all.count),
      p50: quantileFromHistogram(all.hist, 0.5),
      p95: quantileFromHistogram(all.hist, 0.95),
      p99: quantileFromHistogram(all.hist, 0.99),
      cacheHitRate: cacheTotal === 0 ? null : all.cacheHit / cacheTotal,
    },
  });
});

/**
 * Postgres, read straight out of the catalogue.
 *
 * Connections matter more here than on a normal deployment: the API runs four
 * clustered processes, each holding its own pool, against a max_connections of
 * 100 — so the ceiling is reached by configuration long before it is reached by
 * traffic. Breaking the count out by application and state is what makes that
 * visible rather than a single "87 of 100" that looks fine until it isn't.
 */
internalInfraRouter.get("/database", async (_req, res) => {
  const [connections, settings, tables] = await Promise.all([
    prisma.$queryRaw<Array<{ state: string | null; count: bigint }>>`
      SELECT state, COUNT(*) AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state
    `,
    prisma.$queryRaw<Array<{ name: string; setting: string }>>`
      SELECT name, setting FROM pg_settings
      WHERE name IN ('max_connections', 'shared_buffers', 'work_mem', 'effective_cache_size')
    `,
    prisma.$queryRaw<Array<{ table: string; bytes: bigint; rows: bigint }>>`
      -- c.relname, qualified: pg_stat_user_tables carries a relname too, and
      -- an unqualified reference is an ambiguous-column error at run time.
      SELECT c.relname AS "table",
             pg_total_relation_size(c.oid) AS bytes,
             COALESCE(s.n_live_tup, 0) AS rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 25
    `,
  ]);

  const total = connections.reduce((acc, c) => acc + Number(c.count), 0);
  const maxConnections = Number(settings.find((s) => s.name === "max_connections")?.setting ?? 0);

  res.json({
    connections: {
      total,
      max: maxConnections || null,
      utilisation: maxConnections > 0 ? total / maxConnections : null,
      byState: connections.map((c) => ({ state: c.state ?? "unknown", count: Number(c.count) })),
    },
    settings: Object.fromEntries(settings.map((s) => [s.name, s.setting])),
    tables: tables.map((t) => ({ table: t.table, bytes: t.bytes.toString(), rows: Number(t.rows) })),
  });
});

/**
 * Redis, from its own INFO. See modules/observability/redisInfo.ts.
 *
 * The figure to watch is memoryUsedRatio against maxmemory, because the policy
 * here is noeviction: a full instance does not shed old keys, it fails writes —
 * and it would do so to the queue, the response cache and the rate limiter at
 * the same time, presenting as three unrelated faults.
 */
internalInfraRouter.get("/redis", async (_req, res) => {
  res.json(await readRedisStats());
});

/**
 * WHAT ONLY THE HOST CAN SEE.
 *
 * Per-container CPU and memory, kernel OOM kills, the nightly backup, egress and
 * TLS expiry — none of it reachable from inside this container, all of it
 * collected by the root-owned deploy agent and posted on its heartbeat.
 *
 * The previous answer to per-container metrics was "mount the Docker socket into
 * the API", which is root on the host behind an internet-facing Express app.
 * The agent removed the need: it was already root, already polling, already
 * reporting. Nothing here required a new privilege.
 */
internalInfraRouter.get("/host", async (_req, res) => {
  const report = await readHostReport();
  res.json(report);
});
