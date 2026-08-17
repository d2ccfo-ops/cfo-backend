import { createServer } from "node:http";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { redisConnection } from "./lib/redis.js";
import { aiBriefSchedulerQueue, startAiBriefScheduler } from "./modules/queue/aiBriefScheduler.js";
import { anomalySchedulerQueue, startAnomalyScheduler } from "./modules/queue/anomalyScheduler.js";
import { notificationSchedulerQueue, startNotificationScheduler } from "./modules/queue/notificationScheduler.js";
import { repairSchedulerQueue, startRepairScheduler } from "./modules/queue/repairScheduler.js";
import { snapshotSchedulerQueue, startSnapshotScheduler } from "./modules/queue/snapshotScheduler.js";
import { startSyncScheduler, syncSchedulerQueue } from "./modules/queue/syncScheduler.js";
import { startSyncWorker } from "./modules/queue/syncWorker.js";
import { startObservabilityRetention, stopObservabilityRetention } from "./modules/observability/retention.js";
import { startSystemSampler, stopSystemSampler } from "./modules/observability/systemSampler.js";
import { startAlertEvaluator, stopAlertEvaluator } from "./modules/observability/alerts.js";
import { startSyntheticProber, stopSyntheticProber } from "./modules/observability/synthetics.js";
import { startQueueDepthSampler, stopQueueDepthSampler } from "./modules/observability/queueDepthSampler.js";
import { startCostSnapshotWriter, stopCostSnapshotWriter } from "./modules/observability/costSnapshot.js";
import { startDigest, stopDigest } from "./modules/observability/digest.js";

// Separate process from src/index.ts's HTTP server, deliberately. Running
// sync jobs inline on the API server (the old behavior) meant a big backfill
// held an HTTP request, a Node event-loop turn, and a Prisma connection
// hostage for as long as it took; a crash mid-sync could take the whole API
// down with it (see cfo-docs/PROGRESS.md's "missing try/catch" bug history).
// A dedicated worker process means the API server stays responsive and
// scales independently of sync throughput — run more `npm run worker`
// instances to raise total sync throughput without touching the API tier at
// all, see env.ts's SYNC_WORKER_CONCURRENCY for the per-process cap.

const worker = startSyncWorker();
// Lives in the worker process, not the API. The API can be restarted, scaled to
// zero or crash without stopping the clock, and the sweep only ever talks to
// Postgres and Redis — exactly what this process already does.
const scheduler = startSyncScheduler();
// §17's nightly anomaly pass, here for the same reason — it only talks to
// Postgres and Redis, and the clock should not stop because the API tier is
// being restarted or scaled to zero.
const anomalyScheduler = startAnomalyScheduler();
// P2.2d's nightly snapshot capture, same reasoning again. It has to keep its
// own clock for a reason the other two do not share: a night it misses cannot
// be made up later, because the position metrics it records read current-state
// tables that hold no history to look back through.
const snapshotScheduler = startSnapshotScheduler();
// §23. Runs after the anomaly sweep on purpose — it emits a notification per
// CRITICAL open anomaly, so going first would notify about yesterday's
// findings and miss tonight's.
const notificationScheduler = startNotificationScheduler();
// P4.5's narrative, last in the chain at 02:35. It describes the diff the
// snapshot capture wrote thirty minutes earlier, so running it any earlier
// would have it describe the day before yesterday while claiming yesterday.
const aiBriefScheduler = startAiBriefScheduler();
// §12.4's trailing-window repair, at 01:30 — BEFORE the 02:05 snapshot
// capture, deliberately. The snapshot should record the corrected belief
// about yesterday, not the one repair exists to fix.
const repairScheduler = startRepairScheduler();
// Host sampling and observability retention, here rather than in the API for a
// reason specific to each. The sampler must run EXACTLY once per machine, and
// the API is four clustered processes that would each take an identical reading
// of the same host every minute; this process is deliberately single. The
// retention sweep is a bulk delete, and the API tier is the one place a
// long-running statement must never land. Neither uses BullMQ — they need a
// timer, not a distributed schedule, and a queue would add a Redis dependency
// to the one job whose entire purpose is to still work when things are unwell.
startSystemSampler();
startObservabilityRetention();
// Same argument, one step further: the evaluator raises "the queue is stuck" and
// "Redis is unreachable", so it must not be scheduled through either.
startAlertEvaluator();
// The outside view. Same process and the same argument one step further: the
// only check that can still be true when the app is down must not be scheduled
// by the app's own queue.
startSyntheticProber();
// BullMQ knows only NOW — getJobCounts keeps no history — so "141 waiting"
// cannot distinguish a queue draining from one wedged since Tuesday. One row a
// minute is what makes those two different pictures.
startQueueDepthSampler();
// Hourly rather than nightly, because the GCP half is prorated by elapsed time
// and a daily step would leave every month short by up to a day of compute.
startCostSnapshotWriter();
// Everything true but not urgent, once a day. It exists so the PAGE bar can
// stay high: without it, the only way to make an INFO-worthy fact visible is to
// promote it to WARN, and a WARN that fires daily is how alerting gets muted.
startDigest();

// A liveness socket, and nothing more. This process does no HTTP work — every
// line above talks to Postgres and Redis — but a container platform decides
// whether a revision started by connecting to $PORT, and kills the revision if
// nothing answers. Without these few lines the worker deploys and is then
// terminated as failed, while its logs show the schedulers registering
// perfectly, which is a confusing way to spend an evening.
//
// Only when PORT is set, so running `npm run worker` locally alongside the API
// does not race it for a port. Cloud Run always sets it; a laptop does not.
//
// It reports process liveness, deliberately — NOT queue health. A worker whose
// Redis connection has dropped should keep failing this check silently rather
// than be restarted in a loop, because the restart does not fix Redis and the
// loop erases the logs that would say what is wrong.
const healthPort = process.env.PORT ? Number(process.env.PORT) : null;
const healthServer = healthPort
  ? createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", process: "worker" }));
    }).listen(healthPort, () => logger.info({ port: healthPort }, "worker_health_listening"))
  : null;

// Re-entrancy guard. Without it a second signal — or the same signal delivered
// to both the `tsx watch` wrapper and this child, which is what happens on
// every dev restart — runs the whole teardown twice: the second pass calls
// close() on resources the first pass already closed, and once redis has quit
// those throw "Connection is closed" as an unhandled error, so the process dies
// on its way out instead of exiting cleanly. Observed directly on 9 Aug 2026.
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "sync_worker_shutting_down");
  try {
    // First, so the platform stops counting this instance as healthy while the
    // queues below are still draining.
    healthServer?.close();
    // Timers before the Prisma disconnect below, or a sample already in flight
    // writes into a client that is closing.
    stopSystemSampler();
    stopAlertEvaluator();
    stopSyntheticProber();
    stopQueueDepthSampler();
    stopCostSnapshotWriter();
    stopDigest();
    stopObservabilityRetention();
    // Closed before the connections they use. The schedulers go first so no
    // new sweep can enqueue work into a queue that is about to disappear.
    await scheduler.close();
    await syncSchedulerQueue.close();
    await anomalyScheduler.close();
    await anomalySchedulerQueue.close();
    await snapshotScheduler.close();
    await snapshotSchedulerQueue.close();
    await notificationScheduler.close();
    await notificationSchedulerQueue.close();
    await aiBriefScheduler.close();
    await aiBriefSchedulerQueue.close();
    await repairScheduler.close();
    await repairSchedulerQueue.close();
    await worker.close();
    await redisConnection.quit();
    await prisma.$disconnect();
  } catch (err) {
    // Already tearing down — a failure here changes nothing except the exit
    // code, and a noisy stack trace on every restart trains people to ignore
    // the log.
    logger.warn({ err, signal }, "sync_worker_shutdown_unclean");
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
