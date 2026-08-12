import { Queue, Worker } from "bullmq";
import { logger } from "../../lib/logger.js";
import { redisConnection } from "../../lib/redis.js";
import { runDigestSweep } from "../notifications/digest.js";
import { runNotificationSweep } from "../notifications/notifications.js";
import { runApprovalExpirySweep } from "../approvals/approvals.js";

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
const DAILY_DIGEST_ID = "notification-daily-digest";
const WEEKLY_DIGEST_ID = "notification-weekly-digest";
const SWEEP_CRON = "45 2 * * *";
// 07:00 IST, four hours after the emitters run, so a founder opening their
// inbox over breakfast is reading last night's findings rather than the
// previous morning's. Weekly goes out Monday at the same hour — same reason,
// and Monday because a weekly summary is a planning document.
const DAILY_DIGEST_CRON = "0 7 * * *";
const WEEKLY_DIGEST_CRON = "0 7 * * 1";
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
    async (job) => {
      // One worker, three schedules, dispatched on the job name. A queue per
      // schedule would mean three Redis connections and three workers for what
      // is one nightly concern.
      if (job.name === "daily-digest" || job.name === "weekly-digest") {
        const kind = job.name === "daily-digest" ? "daily" : "weekly";
        const result = await runDigestSweep(kind);
        logger.info(result, "digest_sweep_completed");
        // Skips are logged separately and at info: "nobody has configured a
        // digest" and "the digest is broken" must not look identical in a log.
        if (result.failed.length > 0) logger.error({ failed: result.failed, kind }, "digest_sweep_failures");
        return result;
      }
      // §22 expiry, folded into this sweep rather than given a scheduler of
      // its own. Marking a request EXPIRED is bookkeeping — decideApproval
      // checks the deadline itself, so a request that lapsed six hours ago
      // cannot be approved regardless of whether this has run.
      const expiry = await runApprovalExpirySweep();
      if (expiry.expired > 0) logger.info(expiry, "approval_expiry_sweep_completed");

      const result = await runNotificationSweep();
      logger.info(result, "notification_sweep_completed");
      return result;
    },
    { connection: redisConnection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "notification_sweep_failed");
  });

  const schedules: Array<[string, string, string]> = [
    [SWEEP_SCHEDULER_ID, SWEEP_CRON, "sweep"],
    [DAILY_DIGEST_ID, DAILY_DIGEST_CRON, "daily-digest"],
    [WEEKLY_DIGEST_ID, WEEKLY_DIGEST_CRON, "weekly-digest"],
  ];
  for (const [id, pattern, name] of schedules) {
    void notificationSchedulerQueue
      .upsertJobScheduler(id, { pattern, tz: SWEEP_TZ }, { name })
      .then(() => logger.info({ id, pattern, tz: SWEEP_TZ }, "notification_scheduler_registered"))
      .catch((err) => logger.error({ err, id }, "notification_scheduler_registration_failed"));
  }

  return worker;
}
