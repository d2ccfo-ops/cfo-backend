import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

// Observability tables are the only ones here that grow with TIME rather than
// with the business, so they are the only ones that need a ceiling.
//
// The arithmetic is why this exists rather than being left for later.
// system_samples is one row a minute forever: 525,600 rows a year, from a
// process that will happily keep writing them after everyone has stopped
// looking. request_metrics is one row per (minute, route, method) that saw
// traffic — a few thousand a day in normal use, and it does not stop at night
// because health checks do not sleep.
//
// Neither table is worth keeping indefinitely. They answer "how is the system
// behaving lately"; nobody will ever ask what p95 was on a Tuesday last spring,
// and if they do, the answer is in the shape of the chart and not the row.
//
// THIRTY DAYS, and the same figure for both, deliberately: two retention
// windows means two ways to be surprised by a chart that ends early. It comfortably
// covers month-over-month comparison, which is the longest window any panel on
// the internal console actually plots.

const RETENTION_DAYS = 30;

export async function pruneObservability(now = new Date()): Promise<{ requestMetrics: number; systemSamples: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);

  const [requestMetrics, systemSamples] = await Promise.all([
    prisma.requestMetric.deleteMany({ where: { bucketStart: { lt: cutoff } } }),
    prisma.systemSample.deleteMany({ where: { takenAt: { lt: cutoff } } }),
  ]);

  return { requestMetrics: requestMetrics.count, systemSamples: systemSamples.count };
}

let timer: NodeJS.Timeout | null = null;

export function startObservabilityRetention(intervalMs = 24 * 60 * 60_000): void {
  if (timer) return;

  const run = () => {
    pruneObservability()
      .then((deleted) => {
        if (deleted.requestMetrics > 0 || deleted.systemSamples > 0) {
          logger.info({ ...deleted, retentionDays: RETENTION_DAYS }, "observability_pruned");
        }
      })
      .catch((err: unknown) => {
        logger.error({ err }, "observability_prune_failed");
      });
  };

  // Not on start. A deploy loop would otherwise run a full-table delete scan on
  // every restart, and there is nothing urgent about reclaiming rows that have
  // already been there a month.
  timer = setInterval(run, intervalMs);
  timer.unref();
}

export function stopObservabilityRetention(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
