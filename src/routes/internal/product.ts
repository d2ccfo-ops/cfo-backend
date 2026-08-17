import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

// THREE QUESTIONS THAT NEEDED NO NEW INSTRUMENTATION, only the join nobody had
// written: is the product fast enough, did that deploy break it, and do people
// who sign up ever reach the thing they signed up for.

export const internalProductRouter = Router();

const DAY_MS = 86_400_000;

/**
 * SLO AND ERROR BUDGET.
 *
 * Nearly free, because the hard decision was made months ago: request_metrics
 * stores a NON-CUMULATIVE LATENCY HISTOGRAM per (minute, route), not a mean.
 * Percentiles do not average, so a table of means could never have answered
 * this — "what fraction of requests were under 2 seconds" is exactly the shape
 * a histogram answers and exactly the shape a mean destroys.
 *
 * Two objectives, deliberately separate:
 *   LATENCY  — the share of requests inside the target
 *   AVAILABILITY — the share that were not 5xx
 * A page that is fast and broken passes the first and fails the second, and
 * merging them into one number hides which.
 *
 * The budget is what remains of the allowed failure for the window. Burn rate
 * is the honest alarm: 100% of a 30-day budget spent in three days is a
 * different situation from the same percentage spent evenly, and only the rate
 * distinguishes them.
 */
internalProductRouter.get("/slo", async (req, res) => {
  const days = Math.min(Number(req.query.days) > 0 ? Math.trunc(Number(req.query.days)) : 30, 90);
  const targetMs = Number(req.query.targetMs) > 0 ? Math.trunc(Number(req.query.targetMs)) : 2000;
  // 99% availability and 95% of reads under the target. Stated rather than
  // implied — an SLO whose objective is hidden in code is a number nobody can
  // argue with, which is the opposite of the point.
  const latencyObjective = 0.95;
  const availabilityObjective = 0.99;
  const from = new Date(Date.now() - days * DAY_MS);

  // THE BANDS ARE NON-CUMULATIVE, and this is the bug the first version of this
  // endpoint shipped with: `le250` holds requests between 100ms and 250ms, NOT
  // every request under 250ms. Reading one column reported 0.3% of traffic
  // inside a 2-second target on a dev box that answers in single-digit
  // milliseconds — a number absurd enough to notice, which is the only reason
  // it was caught. So every band at or below the target is summed.
  const BANDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
  const included = BANDS.filter((b) => b <= targetMs);
  if (included.length === 0) {
    res.status(400).json({ error: `targetMs must be at least ${BANDS[0]}ms — the histogram has no finer band.` });
    return;
  }
  // EXACT only when the target lands on a band edge. At 2000ms the honest
  // answer is "at least this good": everything up to 1000ms counts, and the
  // 1000–2500ms band contains requests on both sides of 2000 that the histogram
  // cannot separate. Reported as a floor rather than interpolated, because an
  // interpolation here would invent precision to make a number look tidier.
  const exact = (BANDS as readonly number[]).includes(targetMs);
  const sumCols = included.map((b) => `COALESCE(SUM("le${b}"),0)`).join(" + ");

  const rows = await prisma.$queryRawUnsafe<Array<{
    total: bigint; under: bigint; errors: bigint; cachehits: bigint;
  }>>(
    `SELECT COALESCE(SUM(count),0)::bigint     AS total,
            (${sumCols})::bigint               AS under,
            COALESCE(SUM(status5xx),0)::bigint AS errors,
            COALESCE(SUM("cacheHit"),0)::bigint AS cachehits
       FROM request_metrics
      WHERE "bucketStart" >= $1
        AND method = 'GET'`,
    from,
  );

  const r = rows[0];
  const total = Number(r?.total ?? 0);
  const under = Number(r?.under ?? 0);
  const errors = Number(r?.errors ?? 0);

  // Null, not 1.0, when nothing was served. A window with no traffic has no
  // achieved ratio, and reporting a perfect score for an idle system is the
  // kind of green that teaches people to ignore the panel.
  const latencyAchieved = total === 0 ? null : under / total;
  const availabilityAchieved = total === 0 ? null : (total - errors) / total;

  const budget = (achieved: number | null, objective: number) => {
    if (achieved === null) return { spent: null, remaining: null, burnRate: null };
    const allowed = 1 - objective;
    const used = 1 - achieved;
    const spent = allowed === 0 ? 0 : used / allowed;
    return {
      spent,
      remaining: Math.max(0, 1 - spent),
      // >1 means the budget will be gone before the window ends at this pace.
      burnRate: spent / 1,
    };
  };

  res.json({
    windowDays: days,
    targetMs,
    /**
     * TRUE when the target is a histogram band edge. When false the latency
     * figure is a FLOOR — the achieved ratio is at least this, and the band
     * straddling the target holds requests on both sides that cannot be split.
     */
    exact,
    countedUnderMs: included[included.length - 1],
    requests: total,
    latency: { objective: latencyObjective, achieved: latencyAchieved, budget: budget(latencyAchieved, latencyObjective) },
    availability: { objective: availabilityObjective, achieved: availabilityAchieved, errors, budget: budget(availabilityAchieved, availabilityObjective) },
    note:
      total === 0
        ? "No GET traffic recorded in this window, so there is no achieved ratio — not a perfect score."
        : null,
  });
});

/**
 * DID THAT DEPLOY BREAK ANYTHING?
 *
 * Both halves already existed and nothing joined them: deployment_requests
 * knows when each version landed, request_metrics knows the error rate per
 * minute. The comparison is the same window before and after, which is what
 * makes it fair — a deploy at 2am compared against a working afternoon would
 * indict every night release.
 */
internalProductRouter.get("/deploy-impact", async (req, res) => {
  const windowMin = Math.min(Number(req.query.windowMinutes) > 0 ? Math.trunc(Number(req.query.windowMinutes)) : 30, 240);
  const limit = Math.min(Number(req.query.limit) > 0 ? Math.trunc(Number(req.query.limit)) : 10, 50);

  const deploys = await prisma.deploymentRequest.findMany({
    where: { status: "APPLIED", finishedAt: { not: null } },
    orderBy: { finishedAt: "desc" },
    take: limit,
  });

  const impacts = await Promise.all(
    deploys.map(async (d) => {
      const at = d.finishedAt as Date;
      const span = windowMin * 60_000;
      const [before, after] = await Promise.all([
        prisma.requestMetric.aggregate({
          where: { bucketStart: { gte: new Date(at.getTime() - span), lt: at } },
          _sum: { count: true, status5xx: true, totalMs: true },
        }),
        prisma.requestMetric.aggregate({
          where: { bucketStart: { gte: at, lt: new Date(at.getTime() + span) } },
          _sum: { count: true, status5xx: true, totalMs: true },
        }),
      ]);

      const shape = (a: typeof before) => {
        const n = a._sum.count ?? 0;
        return {
          requests: n,
          errors: a._sum.status5xx ?? 0,
          errorRate: n === 0 ? null : (a._sum.status5xx ?? 0) / n,
          meanMs: n === 0 ? null : Math.round((a._sum.totalMs ?? 0) / n),
        };
      };
      const b = shape(before);
      const a2 = shape(after);

      return {
        id: d.id,
        service: d.service,
        fromTag: d.fromTag,
        toTag: d.toTag,
        at: at.toISOString(),
        by: d.requestedByEmail,
        windowMinutes: windowMin,
        before: b,
        after: a2,
        // Null when either side had no traffic — a deploy into a quiet window
        // has no measurable impact, and inventing one would make every 3am
        // release look either perfect or catastrophic.
        errorRateDelta: b.errorRate === null || a2.errorRate === null ? null : a2.errorRate - b.errorRate,
        latencyDeltaMs: b.meanMs === null || a2.meanMs === null ? null : a2.meanMs - b.meanMs,
      };
    }),
  );

  res.json({ windowMinutes: windowMin, deploys: impacts });
});

/**
 * ACTIVATION FUNNEL, over tables that already exist.
 *
 * Every step is a count of organisations that reached a real milestone, not a
 * page view — which is why this could be built today and "feature adoption"
 * could not. Counted at the ORGANISATION level throughout: a company with four
 * logins that never connected a source has not activated four times.
 *
 * Deliberately NOT filtered to a window. A funnel measured over 7 days reports
 * that nobody activated last week, which is true and useless; this is the
 * lifetime state of every tenant, which is the question being asked.
 */
internalProductRouter.get("/funnel", async (_req, res) => {
  const [total, connected, withOrders, askedAi, resolvedException] = await Promise.all([
    prisma.organization.count(),
    prisma.connection.groupBy({ by: ["organizationId"] }).then((r) => r.length),
    prisma.order.groupBy({ by: ["organizationId"] }).then((r) => r.length),
    prisma.agentRun.groupBy({ by: ["organizationId"] }).then((r) => r.length),
    prisma.anomaly
      .groupBy({ by: ["organizationId"], where: { status: "RESOLVED" } })
      .then((r) => r.length),
  ]);

  const steps = [
    { step: "Signed up", detail: "an organisation exists", count: total },
    { step: "Connected a source", detail: "at least one connection", count: connected },
    { step: "Saw real figures", detail: "at least one order ingested", count: withOrders },
    { step: "Asked the AI", detail: "at least one agent run", count: askedAi },
    { step: "Resolved an exception", detail: "closed an anomaly", count: resolvedException },
  ];

  res.json({
    organizations: total,
    steps: steps.map((s, i) => ({
      ...s,
      // Share of ALL signups, and share of the previous step. The second is
      // where a funnel actually leaks and the first is the only one people
      // usually show.
      pctOfTotal: total === 0 ? null : s.count / total,
      pctOfPrevious: i === 0 ? null : (steps[i - 1]?.count ?? 0) === 0 ? null : s.count / (steps[i - 1]?.count ?? 1),
    })),
  });
});

/**
 * RETENTION BY SIGNUP MONTH.
 *
 * Organisations grouped by the month they were created, against whether anyone
 * from them has been active in the last 7 and 30 days. Not a full cohort grid —
 * user_activity_days only began recording on 2026-08-17, so week-by-week
 * retention for a cohort from May would be measuring the instrumentation rather
 * than the product. `coverageFrom` is returned so the page can say so.
 */
internalProductRouter.get("/cohorts", async (_req, res) => {
  const [orgs, active7, active30, earliest] = await Promise.all([
    prisma.organization.findMany({ select: { id: true, createdAt: true } }),
    prisma.membership.findMany({
      where: { lastSeenAt: { gte: new Date(Date.now() - 7 * DAY_MS) } },
      select: { organizationId: true },
    }),
    prisma.membership.findMany({
      where: { lastSeenAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
      select: { organizationId: true },
    }),
    prisma.userActivityDay.findFirst({ orderBy: { day: "asc" }, select: { day: true } }),
  ]);

  const a7 = new Set(active7.map((m) => m.organizationId));
  const a30 = new Set(active30.map((m) => m.organizationId));

  const byMonth = new Map<string, { signed: number; active7: number; active30: number }>();
  for (const o of orgs) {
    const month = o.createdAt.toISOString().slice(0, 7);
    const row = byMonth.get(month) ?? { signed: 0, active7: 0, active30: 0 };
    row.signed += 1;
    if (a7.has(o.id)) row.active7 += 1;
    if (a30.has(o.id)) row.active30 += 1;
    byMonth.set(month, row);
  }

  res.json({
    coverageFrom: earliest?.day ?? null,
    cohorts: [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, r]) => ({
        month,
        signed: r.signed,
        active7: r.active7,
        active30: r.active30,
        retention7: r.signed === 0 ? null : r.active7 / r.signed,
        retention30: r.signed === 0 ? null : r.active30 / r.signed,
      })),
  });
});
