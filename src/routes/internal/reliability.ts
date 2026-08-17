import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { TARGETS } from "../../modules/observability/synthetics.js";
import { buildDigest } from "../../modules/observability/digest.js";
import { daysParam, hoursParam } from "./shared.js";

// UPTIME AS A STRANGER SEES IT, QUEUE DEPTH OVER TIME, WHAT THE BROWSER
// MEASURED, AND WHETHER THE BACKUP HAS EVER BEEN RESTORED.
//
// Four reads that have one thing in common: each answers a question the rest of
// this console structurally cannot. Everything else here is the system
// reporting on itself, which stops being true at precisely the moment it
// matters most.

export const internalReliabilityRouter = Router();

const DAY_MS = 86_400_000;

/**
 * SYNTHETIC UPTIME.
 *
 * Availability is `ok` probes over total probes, and `ok` is per-target — a 307
 * from the dashboard is the healthy answer, because that redirect is proof the
 * app booted and the auth middleware ran. Anything that scored "under 400" as
 * healthy would call a redirect loop fine.
 */
internalReliabilityRouter.get("/uptime", async (req, res) => {
  const hours = hoursParam(req, 24, 24 * 30);
  const from = new Date(Date.now() - hours * 3_600_000);

  const [totals, failures, recent, latest] = await Promise.all([
    prisma.syntheticCheck.groupBy({ by: ["target"], where: { at: { gte: from } }, _count: { _all: true }, _sum: { ms: true }, _max: { ms: true } }),
    prisma.syntheticCheck.groupBy({ by: ["target"], where: { at: { gte: from }, ok: false }, _count: { _all: true } }),
    // The failures themselves, verbatim. A count tells you something broke; the
    // message tells you whether it was DNS, TLS, Caddy or the app.
    prisma.syntheticCheck.findMany({ where: { at: { gte: from }, ok: false }, orderBy: { at: "desc" }, take: 50 }),
    prisma.syntheticCheck.findMany({ where: { at: { gte: from } }, orderBy: { at: "desc" }, take: TARGETS.length * 3 }),
  ]);

  const failMap = new Map(failures.map((f) => [f.target, f._count._all]));
  const latestByTarget = new Map<string, (typeof latest)[number]>();
  for (const r of latest) if (!latestByTarget.has(r.target)) latestByTarget.set(r.target, r);

  const targets = TARGETS.map((t) => {
    const agg = totals.find((x) => x.target === t.name);
    const probes = agg?._count._all ?? 0;
    const failed = failMap.get(t.name) ?? 0;
    const last = latestByTarget.get(t.name) ?? null;
    return {
      target: t.name,
      url: t.url,
      covers: t.covers,
      expect: t.expect,
      probes,
      failed,
      // Null, never 1.0, when nothing was probed. A target with no probes has
      // no measured availability, and rendering that as perfect is how a dead
      // prober reads as a healthy product.
      availability: probes === 0 ? null : (probes - failed) / probes,
      meanMs: probes === 0 ? null : Math.round((agg?._sum.ms ?? 0) / probes),
      worstMs: agg?._max.ms ?? null,
      lastAt: last?.at.toISOString() ?? null,
      lastOk: last?.ok ?? null,
      lastStatus: last?.statusCode ?? null,
      lastError: last?.error ?? null,
      tlsDaysRemaining: last?.tlsDaysRemaining ?? null,
    };
  });

  res.json({
    windowHours: hours,
    /**
     * THE CAVEAT TRAVELS WITH THE NUMBER. The prober runs on the same VM as
     * everything it probes, so it cannot see a network partition between this
     * datacenter and the internet.
     */
    probedFrom: "the worker process on the same VM — this measures DNS, TLS, Caddy and the app, not the path from the outside world",
    targets,
    failures: recent.map((f) => ({
      target: f.target, at: f.at.toISOString(), statusCode: f.statusCode, ms: f.ms, error: f.error,
    })),
    /** Zero probes at all means the prober is not running — a different fault entirely. */
    probing: targets.some((t) => t.probes > 0),
  });
});

/**
 * QUEUE DEPTH OVER TIME.
 *
 * Same numbers the queues panel shows live, with the one dimension BullMQ does
 * not keep. "141 waiting" cannot distinguish a queue draining from a queue
 * wedged; the series can.
 */
internalReliabilityRouter.get("/queue-history", async (req, res) => {
  const hours = hoursParam(req, 24, 24 * 30);
  const from = new Date(Date.now() - hours * 3_600_000);

  const samples = await prisma.queueDepthSample.findMany({
    where: { bucketStart: { gte: from } },
    orderBy: { bucketStart: "asc" },
  });

  const byQueue = new Map<string, Array<{ at: string; waiting: number; active: number; failed: number; delayed: number; paused: boolean }>>();
  for (const s of samples) {
    const list = byQueue.get(s.queue) ?? [];
    list.push({ at: s.bucketStart.toISOString(), waiting: s.waiting, active: s.active, failed: s.failed, delayed: s.delayed, paused: s.paused });
    byQueue.set(s.queue, list);
  }

  const first = samples[0]?.bucketStart ?? null;
  res.json({
    windowHours: hours,
    /** Sampling began here. Anything earlier is absent, not zero. */
    samplingSince: first?.toISOString() ?? null,
    queues: [...byQueue.entries()].map(([queue, points]) => ({
      queue,
      points,
      peakWaiting: points.reduce((a, p) => Math.max(a, p.waiting), 0),
      // The measure that separates "busy" from "stuck": how long the queue has
      // been non-empty without ever reaching zero.
      minutesNonEmpty: points.filter((p) => p.waiting > 0).length,
      currentWaiting: points[points.length - 1]?.waiting ?? 0,
    })),
  });
});

/**
 * WHAT THE BROWSER MEASURED.
 *
 * Bands are Google's published Web Vitals thresholds, so "poor" means what it
 * means everywhere else rather than what looked reasonable here.
 */
internalReliabilityRouter.get("/rum", async (req, res) => {
  const days = daysParam(req, 7, 30);
  const from = new Date(Date.now() - days * DAY_MS);

  const [byRoute, first] = await Promise.all([
    prisma.clientMetric.groupBy({
      by: ["route"],
      where: { bucketStart: { gte: from } },
      _sum: {
        samples: true, lcpSum: true, lcpCount: true, lcpGood: true, lcpNeedsWork: true, lcpPoor: true,
        inpSum: true, inpCount: true, clsSumMilli: true, clsCount: true, ttfbSum: true, ttfbCount: true, fcpSum: true, fcpCount: true,
      },
    }),
    prisma.clientMetric.findFirst({ orderBy: { bucketStart: "asc" }, select: { bucketStart: true } }),
  ]);

  const mean = (sum: number | null, count: number | null) => (count && count > 0 ? Math.round((sum ?? 0) / count) : null);

  const routes = byRoute
    .map((r) => {
      const s = r._sum;
      const lcpTotal = s.lcpCount ?? 0;
      return {
        route: r.route,
        views: s.samples ?? 0,
        lcpMeanMs: mean(s.lcpSum, s.lcpCount),
        lcpGoodShare: lcpTotal === 0 ? null : (s.lcpGood ?? 0) / lcpTotal,
        lcpPoorShare: lcpTotal === 0 ? null : (s.lcpPoor ?? 0) / lcpTotal,
        inpMeanMs: mean(s.inpSum, s.inpCount),
        ttfbMeanMs: mean(s.ttfbSum, s.ttfbCount),
        fcpMeanMs: mean(s.fcpSum, s.fcpCount),
        // Stored x1000 to keep the column an integer; CLS is unitless.
        cls: s.clsCount && s.clsCount > 0 ? (s.clsSumMilli ?? 0) / s.clsCount / 1000 : null,
      };
    })
    .sort((a, b) => b.views - a.views);

  const totalViews = routes.reduce((a, r) => a + r.views, 0);
  res.json({
    windowDays: days,
    /**
     * Null means no browser has ever reported. That is a beacon that is not
     * deployed, NOT a fast site — and the two must never render the same.
     */
    recordingSince: first?.bucketStart.toISOString() ?? null,
    views: totalViews,
    routes,
    thresholds: { lcpGoodMs: 2500, lcpPoorMs: 4000, note: "Google's published Web Vitals bands, not cut points chosen here." },
  });
});

/**
 * HAS THE BACKUP EVER BEEN RESTORED?
 *
 * An empty list is the most important answer this endpoint can give, so it is
 * returned as an explicit `everRehearsed: false` rather than as an empty array
 * a page might render as a tidy "no issues".
 */
internalReliabilityRouter.get("/restore-drills", async (_req, res) => {
  const drills = await prisma.restoreDrill.findMany({ orderBy: { at: "desc" }, take: 24 });
  const lastOk = drills.find((d) => d.ok) ?? null;
  res.json({
    everRehearsed: drills.length > 0,
    lastSuccessAt: lastOk?.at.toISOString() ?? null,
    daysSinceSuccess: lastOk ? Math.floor((Date.now() - lastOk.at.getTime()) / DAY_MS) : null,
    drills: drills.map((d) => ({
      id: d.id,
      at: d.at.toISOString(),
      ok: d.ok,
      backupObject: d.backupObject,
      backupBytes: d.backupBytes === null ? null : d.backupBytes.toString(),
      tables: d.tables,
      orders: d.orders,
      organizations: d.organizations,
      durationMs: d.durationMs,
      error: d.error,
      agentVersion: d.agentVersion,
    })),
  });
});

/**
 * THE DIGEST, EXACTLY AS IT WOULD BE DELIVERED.
 *
 * Read-only and side-effect free: it builds the message and does not send it or
 * touch the sent-once marker. Showing a description of the digest rather than
 * the digest is how a daily email quietly becomes wrong without anyone noticing.
 */
internalReliabilityRouter.get("/digest/preview", async (_req, res) => {
  const digest = await buildDigest();
  res.json(digest);
});
