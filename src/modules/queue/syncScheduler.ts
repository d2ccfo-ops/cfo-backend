import { Queue, Worker } from "bullmq";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { redisConnection } from "../../lib/redis.js";
import { isDue } from "./syncCadence.js";
import { claimAndEnqueueSync } from "./syncQueue.js";

// Until this existed, data only moved when a human clicked "Sync now" or a
// webhook arrived — and five connectors (Meta Ads, Google Ads, Amazon,
// Flipkart, Zoho Books) have no webhook at all, so they had no automatic path
// whatsoever. Meta's long-lived token also expires after ~60 days with nothing
// touching it in between.
//
// ONE repeatable sweep, not one repeatable job per connection. That choice is
// deliberate: a per-connection scheduler has to be registered when a connection
// is created and torn down when it is deleted or disconnected, in every code
// path that does either — and any path that forgets leaves either a connection
// that silently never syncs or an orphan job hammering a row that no longer
// exists. A sweep reads the current table every time, so connecting, pausing
// and deleting need no scheduler bookkeeping at all and the schedule cannot
// drift from reality.

const SCHEDULER_QUEUE = "sync-scheduler";
const SWEEP_SCHEDULER_ID = "connection-sync-sweep";

// How often we LOOK for due connections — not how often anything syncs. Each
// connection's own cadence is decided below; a short sweep just means a
// connection starts close to when it actually became due.
const SWEEP_EVERY_MS = 5 * 60 * 1000;

// The cadence table and the due test live in ./syncCadence.ts — pure, no Redis.
export const syncSchedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    // The sweep is cheap and idempotent, and another one is along in five
    // minutes — retrying a failed sweep buys nothing and risks two sweeps
    // running at once.
    attempts: 1,
    removeOnComplete: { age: 60 * 60, count: 100 },
    removeOnFail: { age: 24 * 60 * 60, count: 100 },
  },
});

export interface SweepResult {
  considered: number;
  enqueued: number;
  skippedInFlight: number;
  failedToEnqueue: number;
}

export async function runSweep(now: Date = new Date()): Promise<SweepResult> {
  // Only ACTIVE. PENDING means a half-finished connect flow with no usable
  // credential, ERROR and DISCONNECTED are states a human has to leave.
  const connections = await prisma.connection.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, provider: true, syncStatus: true, lastSyncedAt: true, organizationId: true },
  });

  const due = connections.filter((c) => isDue(c, now));
  const result: SweepResult = {
    considered: connections.length,
    enqueued: 0,
    skippedInFlight: 0,
    failedToEnqueue: 0,
  };

  for (const connection of due) {
    try {
      // Same atomic claim the "Sync now" button uses, so a sweep racing a
      // click cannot produce two jobs for one connection.
      const claimed = await claimAndEnqueueSync(connection.id);
      if (claimed) result.enqueued += 1;
      else result.skippedInFlight += 1;
    } catch (err) {
      // One unenqueueable connection must not abandon the rest of the sweep —
      // the whole point is that this runs unattended.
      result.failedToEnqueue += 1;
      logger.error(
        { err, connectionId: connection.id, provider: connection.provider },
        "scheduled_sync_enqueue_failed"
      );
    }
  }

  return result;
}

export function startSyncScheduler() {
  const worker = new Worker(
    SCHEDULER_QUEUE,
    async () => {
      const result = await runSweep();
      // Logged every tick, including the quiet ones: "the sweep ran and found
      // nothing due" and "the sweep is not running" look identical from the
      // outside otherwise, and telling them apart is the first question when
      // data stops moving.
      logger.info(result, "sync_sweep_completed");
      return result;
    },
    {
      connection: redisConnection,
      // One sweep at a time. Two concurrent sweeps would not corrupt anything
      // (the atomic claim makes double-enqueue impossible) but they would
      // double every provider API call for no benefit.
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "sync_sweep_failed");
  });

  // upsert, not add: idempotent by scheduler id, so restarting the worker — or
  // running several worker processes — leaves exactly one sweep schedule rather
  // than stacking a new one per boot. Changing SWEEP_EVERY_MS takes effect on
  // the next boot for the same reason.
  void syncSchedulerQueue
    .upsertJobScheduler(SWEEP_SCHEDULER_ID, { every: SWEEP_EVERY_MS }, { name: "sweep" })
    .then(() => logger.info({ everyMs: SWEEP_EVERY_MS }, "sync_scheduler_registered"))
    .catch((err) => logger.error({ err }, "sync_scheduler_registration_failed"));

  return worker;
}
