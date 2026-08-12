import { Queue, Worker } from "bullmq";
import { logger } from "../../lib/logger.js";
import { redisConnection } from "../../lib/redis.js";
import { runAnomalySweep } from "../calc/anomalies.js";

// §17's nightly pass. Anomaly detection is only useful if it runs without
// anyone asking: a founder who has to click "check for anomalies" already
// suspects something, and the whole point is catching what they don't.
//
// ONE sweep over every organisation, not one repeatable job per org — the
// same reasoning syncScheduler.ts spells out at length: a per-org schedule
// has to be registered on org creation and torn down on deletion in every
// code path that does either, and any path that forgets leaves an org that
// silently never runs or an orphan job hammering a row that no longer
// exists. A sweep reads the current table every time.
//
// The sweep ITSELF lives in modules/calc/anomalies.ts, not here, mirroring
// the syncCadence.ts / syncScheduler.ts split: this file constructs a BullMQ
// Queue at module scope, so anything importing it opens a Redis connection
// and never exits. Keeping runAnomalySweep() out of here is what lets
// scripts/checkAnomalies.ts run it and terminate.

const SCHEDULER_QUEUE = "anomaly-scheduler";
const SWEEP_SCHEDULER_ID = "anomaly-nightly-sweep";

// 02:30 IST. Deliberately a cron pattern rather than `every: 24h`: `every`
// anchors to whenever the schedule was first created, so the run time would
// wander with deploys and nobody could say when the numbers refresh. Nightly
// means nightly, at a stated hour. 02:30 is after the day's orders have
// settled and well before anyone opens the dashboard.
const SWEEP_CRON = "30 2 * * *";
const SWEEP_TZ = "Asia/Kolkata";

export const anomalySchedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    // The sweep is idempotent (every finding upserts on dedupeKey) but not
    // cheap — it runs the full calc stack per org. One retry covers a
    // transient database blip; more would mean a genuinely broken run
    // burning the same work repeatedly, and tomorrow's sweep is along anyway.
    attempts: 2,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 50 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 50 },
  },
});

export function startAnomalyScheduler() {
  const worker = new Worker(
    SCHEDULER_QUEUE,
    async () => {
      const result = await runAnomalySweep();
      // Logged every night, including the quiet ones: "the sweep ran and
      // found nothing" and "the sweep is not running" look identical from
      // the outside otherwise, and telling them apart is the first question
      // when the Exceptions page stops changing.
      logger.info(result, "anomaly_sweep_completed");
      return result;
    },
    {
      connection: redisConnection,
      // One sweep at a time. Two concurrent sweeps would not corrupt anything
      // (every write upserts on dedupeKey) but they would double the calc
      // work for no benefit.
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "anomaly_sweep_failed");
  });

  // upsert, not add: idempotent by scheduler id, so restarting the worker —
  // or running several worker processes — leaves exactly one nightly schedule
  // rather than stacking a new one per boot.
  void anomalySchedulerQueue
    .upsertJobScheduler(SWEEP_SCHEDULER_ID, { pattern: SWEEP_CRON, tz: SWEEP_TZ }, { name: "sweep" })
    .then(() => logger.info({ pattern: SWEEP_CRON, tz: SWEEP_TZ }, "anomaly_scheduler_registered"))
    .catch((err) => logger.error({ err }, "anomaly_scheduler_registration_failed"));

  return worker;
}
