import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { readQueueInventory } from "../../modules/observability/queueInventory.js";
import { daysParam, limitParam, since } from "./shared.js";
import { classifySyncError } from "./syncErrorClass.js";

export const internalJobsRouter = Router();

const DAY_MS = 24 * 60 * 60_000;

/** Sync health across every tenant, by provider. */
internalJobsRouter.get("/summary", async (req, res) => {
  const days = daysParam(req, 7);
  const from = since(days * DAY_MS);

  const byProvider = await prisma.syncRun.groupBy({
    by: ["provider", "status"],
    where: { startedAt: { gte: from } },
    _count: { _all: true },
    _sum: { recordsWritten: true },
    _avg: { durationMs: true },
  });

  const providers = new Map<
    string,
    { provider: string; total: number; succeeded: number; empty: number; failed: number; running: number; recordsWritten: number; avgDurationMs: number | null }
  >();

  for (const g of byProvider) {
    const p = providers.get(g.provider) ?? {
      provider: g.provider,
      total: 0,
      succeeded: 0,
      empty: 0,
      failed: 0,
      running: 0,
      recordsWritten: 0,
      avgDurationMs: null,
    };
    p.total += g._count._all;
    if (g.status === "SUCCEEDED") p.succeeded += g._count._all;
    else if (g.status === "EMPTY") p.empty += g._count._all;
    else if (g.status === "FAILED") p.failed += g._count._all;
    else if (g.status === "RUNNING") p.running += g._count._all;
    p.recordsWritten += g._sum.recordsWritten ?? 0;
    if (g._avg.durationMs !== null) {
      p.avgDurationMs = p.avgDurationMs === null ? g._avg.durationMs : (p.avgDurationMs + g._avg.durationMs) / 2;
    }
    providers.set(g.provider, p);
  }

  const rows = [...providers.values()]
    .map((p) => ({
      ...p,
      avgDurationMs: p.avgDurationMs === null ? null : Math.round(p.avgDurationMs),
      // EMPTY counts as a success: a store with no orders yesterday is a real
      // thing and not a fault. It stays its own column so a RUN of empty
      // nights is still visible as one.
      successRate: p.total === 0 ? null : (p.succeeded + p.empty) / p.total,
    }))
    .sort((a, b) => (a.successRate ?? 1) - (b.successRate ?? 1));

  res.json({ windowDays: days, providers: rows });
});

/**
 * SUCCESSFUL-LOOKING FAILURES.
 *
 * A sync whose cursor does not advance is fetching nothing while reporting
 * success. Every other column looks healthy — status SUCCEEDED, no error, a
 * sensible duration — so this is invisible in the run history and needs to be
 * asked for directly.
 *
 * Counts CONSECUTIVE leading runs sharing the newest cursor, not merely runs
 * that happen to share it. The difference matters: a cursor that moved and came
 * back is a different fault from one that never moved, and lumping them
 * together would report a healthy connection as stuck.
 */
internalJobsRouter.get("/stalled-cursors", async (req, res) => {
  const days = daysParam(req, 14);
  const minRuns = Number(req.query.minRuns) > 0 ? Math.trunc(Number(req.query.minRuns)) : 3;
  const from = since(days * DAY_MS);

  const rows = await prisma.$queryRaw<
    Array<{
      connectionId: string;
      organizationId: string;
      provider: string;
      cursor: string | null;
      runsSameCursor: bigint | number;
      lastRunAt: Date;
      recordsWritten: bigint | number | null;
    }>
  >`
    WITH ranked AS (
      SELECT "connectionId", "organizationId", provider, cursor, "startedAt", "recordsWritten",
             ROW_NUMBER() OVER (PARTITION BY "connectionId" ORDER BY "startedAt" DESC) AS rn
      FROM sync_runs
      WHERE "startedAt" >= ${from} AND status IN ('SUCCEEDED', 'EMPTY')
    ),
    latest AS (SELECT * FROM ranked WHERE rn = 1)
    SELECT l."connectionId",
           l."organizationId",
           l.provider::text AS provider,
           l.cursor,
           l."startedAt" AS "lastRunAt",
           COALESCE(
             (SELECT MIN(r.rn) FROM ranked r
               WHERE r."connectionId" = l."connectionId"
                 AND r.cursor IS DISTINCT FROM l.cursor),
             (SELECT MAX(r2.rn) + 1 FROM ranked r2 WHERE r2."connectionId" = l."connectionId")
           ) - 1 AS "runsSameCursor",
           (SELECT SUM(r3."recordsWritten") FROM ranked r3
             WHERE r3."connectionId" = l."connectionId"
               AND r3.cursor IS NOT DISTINCT FROM l.cursor) AS "recordsWritten"
    FROM latest l
    ORDER BY "runsSameCursor" DESC
  `;

  const stalled = rows
    .map((r) => ({
      connectionId: r.connectionId,
      organizationId: r.organizationId,
      provider: r.provider,
      cursor: r.cursor,
      runsSameCursor: Number(r.runsSameCursor),
      lastRunAt: r.lastRunAt.toISOString(),
      recordsWrittenSince: r.recordsWritten === null ? null : Number(r.recordsWritten),
    }))
    .filter((r) => r.runsSameCursor >= minRuns);

  res.json({ windowDays: days, minRuns, stalled });
});

/** Recent runs, newest first, filterable. */
internalJobsRouter.get("/runs", async (req, res) => {
  const days = daysParam(req, 7);
  const limit = limitParam(req, 100);
  const from = since(days * DAY_MS);

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;

  const runs = await prisma.syncRun.findMany({
    where: {
      startedAt: { gte: from },
      ...(status ? { status: status as never } : {}),
      ...(provider ? { provider: provider as never } : {}),
    },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      organizationId: true,
      connectionId: true,
      provider: true,
      trigger: true,
      status: true,
      recordsFetched: true,
      recordsWritten: true,
      cursor: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
    },
  });

  res.json({
    windowDays: days,
    runs: runs.map((r) => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      // recordsFetched stays null where it is null. A failed run does not know
      // what it fetched, and 0 would claim it looked and found nothing.
    })),
  });
});

/**
 * Why syncs fail, grouped.
 *
 * Credential-decrypt failures are separated from everything else because they
 * are a different kind of problem: the stored credential can no longer be read
 * at all, which no amount of retrying fixes. On this deployment they are also
 * the loudest single error class — the seeded demo connections carry
 * placeholder credentials — so leaving them in the general bucket would bury
 * every real provider error underneath them.
 */
internalJobsRouter.get("/errors", async (req, res) => {
  const days = daysParam(req, 7);
  const from = since(days * DAY_MS);

  const rows = await prisma.$queryRaw<Array<{ provider: string; error: string; count: bigint; lastAt: Date }>>`
    SELECT provider::text AS provider,
           COALESCE(error, '(no message)') AS error,
           COUNT(*) AS count,
           MAX("startedAt") AS "lastAt"
    FROM sync_runs
    WHERE "startedAt" >= ${from} AND status = 'FAILED'
    GROUP BY 1, 2
    ORDER BY count DESC
    LIMIT 200
  `;

  const grouped = rows.map((r) => ({
    provider: r.provider,
    error: r.error.slice(0, 500),
    class: classifySyncError(r.error),
    count: Number(r.count),
    lastAt: r.lastAt.toISOString(),
  }));

  const byClass = new Map<string, number>();
  for (const g of grouped) byClass.set(g.class, (byClass.get(g.class) ?? 0) + g.count);

  res.json({
    windowDays: days,
    errors: grouped,
    byClass: [...byClass.entries()].map(([cls, count]) => ({ class: cls, count })).sort((a, b) => b.count - a.count),
  });
});

/**
 * THE QUEUES THEMSELVES, as opposed to the history of what came out of them.
 *
 * Every other route on this router reads sync_runs — the record of finished
 * work. None of them can answer "is anything stuck right now", because a job
 * that is waiting has not written a row yet. That gap is what this closes, and
 * it is the difference between noticing a stall at 09:00 and noticing it in
 * tomorrow's failure count.
 *
 * 503 rather than 500 when Redis is unreachable: the console renders the body's
 * `error` next to a retry, and "the queue store is down" is a real answer to
 * the question the panel asks, not an internal fault hidden behind a 500.
 */
internalJobsRouter.get("/queues", async (_req, res) => {
  const inventory = await readQueueInventory();
  res.status(inventory.error ? 503 : 200).json(inventory);
});
