import { Queue, Worker } from "bullmq";
import { logger } from "../../lib/logger.js";
import { redisConnection } from "../../lib/redis.js";
import { runDailyBriefSweep } from "../ai/dailyBrief.js";

// P4.5's nightly narrative pass.
//
// Fires at 02:35 IST — thirty minutes after the snapshot capture (02:05) and
// five minutes after the anomaly sweep (02:30). The ordering is the whole
// point: the narrative describes the diff between last night's snapshot and
// the one before, so running it first would either find nothing or describe
// the day before yesterday while claiming to describe yesterday.
//
// The sweep itself lives in modules/ai/dailyBrief.ts, for the reason
// syncCadence.ts documents: a module that imports this file gets a Queue at
// module scope, which opens a Redis connection and keeps the importing process
// alive forever. Every script that generates a brief by hand imports the calc
// module, never this one.

const SCHEDULER_QUEUE = "ai-brief-scheduler";
const SWEEP_SCHEDULER_ID = "daily-brief-narrative";
const SWEEP_CRON = "35 2 * * *";
const SWEEP_TZ = "Asia/Kolkata";

export const aiBriefSchedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    // One attempt, unlike the snapshot capture's two. A retry costs a second
    // model call per organisation and the failure mode it would recover from —
    // a transient API error — leaves a stored row explaining itself. A founder
    // reading "the narrative could not be generated this morning" has lost
    // nothing: every figure it would have described is on the page beside it.
    attempts: 1,
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 50 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 50 },
  },
});

export function startAiBriefScheduler() {
  const worker = new Worker(
    SCHEDULER_QUEUE,
    async () => {
      const result = await runDailyBriefSweep();
      logger.info(result, "daily_brief_sweep_completed");
      if (result.failed.length > 0) logger.warn({ failed: result.failed }, "daily_brief_sweep_partial");
      return result;
    },
    { connection: redisConnection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "daily_brief_sweep_failed");
  });

  void aiBriefSchedulerQueue
    .upsertJobScheduler(SWEEP_SCHEDULER_ID, { pattern: SWEEP_CRON, tz: SWEEP_TZ }, { name: "narrate" })
    .then(() => logger.info({ pattern: SWEEP_CRON, tz: SWEEP_TZ }, "ai_brief_scheduler_registered"))
    .catch((err) => logger.error({ err }, "ai_brief_scheduler_registration_failed"));

  return worker;
}
