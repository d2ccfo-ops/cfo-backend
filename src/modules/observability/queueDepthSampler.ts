import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { readQueueInventory } from "./queueInventory.js";

// BULLMQ ONLY KNOWS NOW.
//
// getJobCounts answers what is waiting this instant and keeps no history. So
// the queues panel can say "141 waiting" and cannot say whether that is a queue
// draining after a backfill or a queue that has been stuck at 141 since
// Tuesday. Those two need opposite responses — wait, versus go and find out why
// nothing is consuming — and in a single reading they are identical.
//
// One row per (minute, queue). Written by the worker on a plain interval, same
// reason as the alert evaluator and the prober: the one thing that must not
// stop when the queue stops is the record of the queue having stopped.
//
// The unique key is (bucketStart, queue) and the write is an upsert, so two
// workers sampling the same minute converge on one row instead of doubling the
// series. Last writer wins, which is correct — they are both reading the same
// Redis a few hundred milliseconds apart.

const INTERVAL_MS = 60_000;

export async function sampleQueueDepth(now = Date.now()): Promise<number> {
  const inv = await readQueueInventory();
  if (inv.error) {
    // Nothing is written. A row of zeroes for a Redis outage is a lie that
    // outlives the outage: the chart would show every queue empty and calm at
    // the exact moment nothing could be read at all.
    logger.warn({ error: inv.error }, "queue_depth_sample_skipped");
    return 0;
  }

  const bucketStart = new Date(Math.floor(now / 60_000) * 60_000);
  let written = 0;
  for (const q of inv.queues) {
    if (q.error) continue;
    const data = {
      waiting: q.waiting,
      active: q.active,
      delayed: q.delayed,
      failed: q.failed,
      completed: q.completed,
      paused: q.isPaused,
    };
    try {
      await prisma.queueDepthSample.upsert({
        where: { bucketStart_queue: { bucketStart, queue: q.name } },
        create: { bucketStart, queue: q.name, ...data },
        update: data,
      });
      written += 1;
    } catch (err) {
      logger.warn({ err, queue: q.name }, "queue_depth_sample_write_failed");
    }
  }
  return written;
}

let timer: NodeJS.Timeout | null = null;

export function startQueueDepthSampler(intervalMs = INTERVAL_MS): void {
  if (timer) return;
  const tick = () => {
    void sampleQueueDepth().catch((err: unknown) => logger.error({ err }, "queue_depth_sampler_failed"));
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

export function stopQueueDepthSampler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
