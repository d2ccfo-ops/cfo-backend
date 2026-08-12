import { Queue, Worker } from "bullmq";
import { logger } from "../../lib/logger.js";
import { redisConnection } from "../../lib/redis.js";
import { runDailySnapshotSweep } from "../calc/dailySnapshot.js";

// P2.2d's nightly capture. Without it the snapshot history has no writer and
// the daily brief has nothing to diff — the whole point is that yesterday's
// numbers are recorded before anyone thinks to ask for them, because by the
// time someone asks, the metric modules have already overwritten their own
// rows with today's belief.
//
// ONE sweep over every organisation rather than a repeatable job per org, for
// the reason syncScheduler.ts sets out at length: a per-org schedule has to be
// registered on creation and torn down on deletion in every code path that
// does either, and any path that forgets leaves an org silently unrecorded.
//
// The sweep ITSELF lives in modules/calc/dailySnapshot.ts. This file builds a
// Queue at module scope, so importing it opens a Redis connection that keeps
// the process alive forever — the trap that already cost this project a
// debugging session when the anomaly sweep briefly lived in its scheduler.
// Keeping the sweep out of here is what lets scripts/checkDailySnapshot.ts run
// it and terminate.

const SCHEDULER_QUEUE = "snapshot-scheduler";
const SWEEP_SCHEDULER_ID = "daily-snapshot-capture";

// 02:05 IST, twenty-five minutes ahead of the anomaly sweep so the two heavy
// per-org passes do not contend. A cron pattern rather than `every: 24h` for
// the reason anomalyScheduler.ts gives: `every` anchors to whenever the
// schedule was first created, so the capture time would wander with deploys
// and no one could say which hour a day's row was cut at.
//
// The hour matters less than it looks: captureDailySnapshot always targets
// YESTERDAY on the organisation's own calendar, and yesterday is complete at
// every instant of today, in every timezone. What the fixed instant does
// guarantee is that each org's target day advances by exactly one per run —
// one firing per UTC day means one local date per org per run, so no day is
// captured twice or skipped. (An org whose local firing time landed within an
// hour of midnight could have that upset by a DST transition; at 02:05 IST it
// does not, and IST has no DST regardless.)
const SWEEP_CRON = "5 2 * * *";
const SWEEP_TZ = "Asia/Kolkata";

export const snapshotSchedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    // Two attempts. The capture is idempotent — a retry rewrites the same day's
    // rows with the same target — but it runs the full calc stack per org, so a
    // genuinely broken run should not burn that work repeatedly. A missed night
    // shows up as a reported gap rather than as silence.
    attempts: 2,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 50 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 50 },
  },
});

export function startSnapshotScheduler() {
  const worker = new Worker(
    SCHEDULER_QUEUE,
    async () => {
      const result = await runDailySnapshotSweep();
      // Logged every night, including the quiet ones. "The capture ran and had
      // nothing to write" and "the capture is not running" look identical from
      // the outside otherwise, and telling them apart is the first question
      // when a brief stops reporting changes.
      logger.info(result, "daily_snapshot_sweep_completed");
      if (result.gaps.length > 0) {
        // Its own line at warn level: a hole in the history is not a failure of
        // tonight's run, so it would never surface as a failed job, and it
        // silently changes what every later diff means.
        logger.warn({ gaps: result.gaps }, "daily_snapshot_history_gap");
      }
      if (result.blocked.length > 0) {
        // An organisation with live connections that recorded nothing. Almost
        // always a stopped sync — and the capture refusing to write ₹0 for a
        // day nobody observed is the correct behaviour, so this warning is the
        // only place the problem surfaces at all.
        logger.warn({ blocked: result.blocked }, "daily_snapshot_blocked");
      }
      return result;
    },
    {
      connection: redisConnection,
      // One at a time. Two concurrent sweeps would not corrupt anything (each
      // row write is find-then-update on the same target day) but they would
      // double the calc work for no benefit.
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "daily_snapshot_sweep_failed");
  });

  // upsert, not add: idempotent by scheduler id, so restarting the worker — or
  // running several worker processes — leaves exactly one nightly schedule
  // rather than stacking a new one per boot.
  void snapshotSchedulerQueue
    .upsertJobScheduler(SWEEP_SCHEDULER_ID, { pattern: SWEEP_CRON, tz: SWEEP_TZ }, { name: "capture" })
    .then(() => logger.info({ pattern: SWEEP_CRON, tz: SWEEP_TZ }, "snapshot_scheduler_registered"))
    .catch((err) => logger.error({ err }, "snapshot_scheduler_registration_failed"));

  return worker;
}
