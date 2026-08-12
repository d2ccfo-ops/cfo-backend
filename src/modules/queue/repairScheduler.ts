import { Queue, Worker } from "bullmq";
import { logger } from "../../lib/logger.js";
import { redisConnection } from "../../lib/redis.js";
import { runRepairSweep } from "../sync/repair.js";

// §12.4's nightly repair pass (P5.5).
//
// Fires at 01:30 IST, before the 02:05 snapshot capture — deliberately. The
// snapshot records what the system believed about yesterday, and it should
// record the CORRECTED belief. Running repair after the capture would mean
// every night's snapshot was taken from data known to be a day stale in
// exactly the way repair exists to fix.
//
// The sweep itself lives in modules/sync/repair.ts. That module imports the
// sync queue (it has to — it enqueues), so it is one of the few modules in
// this codebase that cannot be imported by a script that wants to terminate.
// This scheduler is its only caller.

const SCHEDULER_QUEUE = "repair-scheduler";
const SWEEP_SCHEDULER_ID = "trailing-window-repair";
const SWEEP_CRON = "30 1 * * *";
const SWEEP_TZ = "Asia/Kolkata";

export const repairSchedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    // One attempt. The sweep only ENQUEUES — the syncs it schedules have
    // their own retry policy, and re-running the sweep would just re-claim
    // connections whose repair is already in flight.
    attempts: 1,
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 50 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 50 },
  },
});

export function startRepairScheduler() {
  const worker = new Worker(
    SCHEDULER_QUEUE,
    async () => {
      const result = await runRepairSweep();
      logger.info(result, "repair_sweep_completed");
      return result;
    },
    { connection: redisConnection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "repair_sweep_failed");
  });

  void repairSchedulerQueue
    .upsertJobScheduler(SWEEP_SCHEDULER_ID, { pattern: SWEEP_CRON, tz: SWEEP_TZ }, { name: "repair" })
    .then(() => logger.info({ pattern: SWEEP_CRON, tz: SWEEP_TZ }, "repair_scheduler_registered"))
    .catch((err) => logger.error({ err }, "repair_scheduler_registration_failed"));

  return worker;
}
