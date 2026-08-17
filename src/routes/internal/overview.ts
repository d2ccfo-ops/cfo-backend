import { Router } from "express";
import { costOf } from "../../lib/aiPricing.js";
import { prisma } from "../../lib/prisma.js";
import { quantileFromHistogram, since, emptyHistogram, addHistogram } from "./shared.js";

export const internalOverviewRouter = Router();

const DAY_MS = 24 * 60 * 60_000;

/**
 * The control tower: one call, everything that could be wrong.
 *
 * Deliberately ONE endpoint rather than the page fanning out to eight. The
 * lesson from the customer dashboard is on the record — twenty parallel
 * requests on one page load amplified each other by 5-9x on a CPU-bound box,
 * and the fix was to stop doing that. An internal page has no excuse to repeat
 * it.
 *
 * Every section reports null rather than zero when its source has no data, so
 * "not instrumented" and "nothing wrong" stay distinguishable. They are
 * opposite conclusions and a dashboard that confuses them is worse than none.
 */
internalOverviewRouter.get("/", async (_req, res) => {
  const now = new Date();
  const day = since(DAY_MS, now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [latestSample, requestRows, aiToday, aiMonth, failedSyncs, runningSyncs, openCritical, dau, orgs, connectionsInError, exhausted] =
    await Promise.all([
      prisma.systemSample.findFirst({ orderBy: { takenAt: "desc" } }),
      prisma.requestMetric.findMany({ where: { bucketStart: { gte: day } } }),
      prisma.agentRun.groupBy({
        by: ["model"],
        where: { startedAt: { gte: day } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
      }),
      prisma.agentRun.groupBy({
        by: ["model"],
        where: { startedAt: { gte: monthStart } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
      }),
      prisma.syncRun.count({ where: { startedAt: { gte: day }, status: "FAILED" } }),
      prisma.syncRun.count({ where: { status: "RUNNING" } }),
      prisma.anomaly.count({ where: { status: "OPEN", severity: "CRITICAL" } }),
      prisma.membership.count({ where: { lastSeenAt: { gte: day } } }),
      prisma.organization.count(),
      prisma.connection.count({ where: { status: "ERROR" } }),
      prisma.agentRun.count({ where: { startedAt: { gte: day }, status: "EXHAUSTED" } }),
    ]);

  const priceGroups = (
    groups: Array<{ model: string; _count: { _all: number }; _sum: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null } }>,
  ) => {
    let total = 0n;
    let runs = 0;
    let unpriced = 0;
    for (const g of groups) {
      runs += g._count._all;
      const cost = costOf(
        {
          inputTokens: g._sum.inputTokens ?? 0,
          outputTokens: g._sum.outputTokens ?? 0,
          cacheReadTokens: g._sum.cacheReadTokens ?? 0,
          cacheWriteTokens: g._sum.cacheWriteTokens ?? 0,
        },
        g.model,
        now,
      );
      if (cost === null) unpriced += g._count._all;
      else total += cost.total;
    }
    return { runs, costMicroUsd: total.toString(), unpricedRuns: unpriced };
  };

  // Requests over the last 24h, summed across every route.
  let hist = emptyHistogram();
  let requests = 0;
  let errors = 0;
  let cacheHit = 0;
  let cacheMiss = 0;
  for (const r of requestRows) {
    requests += r.count;
    errors += r.status4xx + r.status5xx;
    cacheHit += r.cacheHit;
    cacheMiss += r.cacheMiss;
    hist = addHistogram(hist, r);
  }

  const cpuSaturation =
    latestSample && latestSample.cpuCount > 0 ? latestSample.load1 / latestSample.cpuCount : null;

  res.json({
    at: now.toISOString(),
    system: latestSample
      ? {
          takenAt: latestSample.takenAt.toISOString(),
          cpuCount: latestSample.cpuCount,
          cpuSaturation,
          cpuIdle: cpuSaturation === null ? null : Math.max(0, 1 - cpuSaturation),
          memTotal: latestSample.memTotal.toString(),
          memFree: latestSample.memFree.toString(),
          memIdleRatio:
            latestSample.memTotal > 0n ? Number(latestSample.memFree) / Number(latestSample.memTotal) : null,
          diskTotal: latestSample.diskTotal.toString(),
          diskFree: latestSample.diskFree.toString(),
          // A sample older than a few minutes means the sampler is down, which
          // is itself the finding.
          staleSeconds: Math.round((now.getTime() - latestSample.takenAt.getTime()) / 1000),
        }
      : null,
    requests:
      requestRows.length === 0
        ? null
        : {
            windowHours: 24,
            count: requests,
            errors,
            errorRate: requests === 0 ? null : errors / requests,
            perMinute: requests / (24 * 60),
            p95: quantileFromHistogram(hist, 0.95),
            cacheHitRate: cacheHit + cacheMiss === 0 ? null : cacheHit / (cacheHit + cacheMiss),
          },
    ai: {
      today: priceGroups(aiToday),
      monthToDate: priceGroups(aiMonth),
      // Runs that hit the turn cap and produced nothing. Spend with no output,
      // which is why it sits on the front page rather than three clicks in.
      exhaustedToday: exhausted,
    },
    jobs: { failedLast24h: failedSyncs, running: runningSyncs },
    tenants: { organizations: orgs, connectionsInError, openCriticalAnomalies: openCritical },
    users: { activeLast24h: dau },
  });
});
