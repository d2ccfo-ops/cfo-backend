import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { redisConnection } from "./lib/redis.js";
import { anomalySchedulerQueue, startAnomalyScheduler } from "./modules/queue/anomalyScheduler.js";
import { startSyncScheduler, syncSchedulerQueue } from "./modules/queue/syncScheduler.js";
import { startSyncWorker } from "./modules/queue/syncWorker.js";

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
    // Closed before the connections they use. The schedulers go first so no
    // new sweep can enqueue work into a queue that is about to disappear.
    await scheduler.close();
    await syncSchedulerQueue.close();
    await anomalyScheduler.close();
    await anomalySchedulerQueue.close();
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
