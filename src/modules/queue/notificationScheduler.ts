import { Queue, Worker } from "bullmq";
import { logger } from "../../lib/logger.js";
import { redisConnection } from "../../lib/redis.js";
import { runNotificationSweep } from "../notifications/notifications.js";

// §23's nightly pass (P3.1). Runs at 02:45 IST — AFTER the anomaly sweep at
// 02:30, and that ordering is the point: the first thing this emits is a
// notification per CRITICAL open anomaly, so running it first would notify
// about yesterday's findings and miss tonight's entirely.
//
// The sweep itself lives in modules/notifications, not here. This file builds
// a Queue at module scope, so importing it opens a Redis connection that never
// closes — the trap syncCadence.ts documents and that has already cost this
// project one debugging session.

const SCHEDULER_QUEUE = "notification-scheduler";
const SWEEP_SCHEDULER_ID = "notification-nightly-sweep";
const SWEEP_CRON = "45 2 * * *";
const SWEEP_TZ = "Asia/Kolkata";

export const notificationSchedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 50 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 50 },
  },
});

export function startNotificationScheduler() {
  const worker = new Worker(
    SCHEDULER_QUEUE,
    async () => {
      const result = await runNotificationSweep();
      logger.info(result, "notification_sweep_completed");
      return result;
    },
    { connection: redisConnection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "notification_sweep_failed");
  });

  void notificationSchedulerQueue
    .upsertJobScheduler(SWEEP_SCHEDULER_ID, { pattern: SWEEP_CRON, tz: SWEEP_TZ }, { name: "sweep" })
    .then(() => logger.info({ pattern: SWEEP_CRON, tz: SWEEP_TZ }, "notification_scheduler_registered"))
    .catch((err) => logger.error({ err }, "notification_scheduler_registration_failed"));

  return worker;
}
