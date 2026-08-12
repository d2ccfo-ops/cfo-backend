import { Worker, type Job } from "bullmq";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { redisConnection } from "../../lib/redis.js";
import { amazonConnector } from "../connectors/amazon/index.js";
import { bankConnector } from "../connectors/bank/index.js";
import { bluedartConnector } from "../connectors/bluedart/index.js";
import { clickpostConnector } from "../connectors/clickpost/index.js";
import { delhiveryConnector } from "../connectors/delhivery/index.js";
import { flipkartConnector } from "../connectors/flipkart/index.js";
import { gokwikConnector } from "../connectors/gokwik/index.js";
import { googleAdsConnector } from "../connectors/googleAds/index.js";
import { metaAdsConnector } from "../connectors/metaAds/index.js";
import { razorpayConnector } from "../connectors/razorpay/index.js";
import { setuConnector } from "../connectors/setu/index.js";
import { shiprocketConnector } from "../connectors/shiprocket/index.js";
import { shopifyConnector } from "../connectors/shopify/index.js";
import { zohoBooksConnector } from "../connectors/zohoBooks/index.js";
import { toConnectorContext, type Connector } from "../connectors/types.js";
import { runReconciliation } from "../calc/reconciliation.js";
import type { SyncJobData } from "./syncQueue.js";

// Duplicated from routes/connections/index.ts's CONNECTORS map deliberately
// rather than imported — that file also owns the Express route layer, and
// this worker must be importable (and startable) from src/worker.ts without
// pulling in Express/Clerk at all. If a third place ever needs this map,
// promote it to its own module then.
const CONNECTORS: Record<string, Connector> = {
  SHOPIFY: shopifyConnector,
  RAZORPAY: razorpayConnector,
  SHIPROCKET: shiprocketConnector,
  BANK: bankConnector,
  META_ADS: metaAdsConnector,
  GOOGLE_ADS: googleAdsConnector,
  DELHIVERY: delhiveryConnector,
  BANK_AA: setuConnector,
  AMAZON: amazonConnector,
  FLIPKART: flipkartConnector,
  CLICKPOST: clickpostConnector,
  ZOHO_BOOKS: zohoBooksConnector,
  BLUEDART: bluedartConnector,
  GOKWIK: gokwikConnector,
};

function cursorFor(provider: string, lastSyncedAt: Date | null): string | null {
  if (!lastSyncedAt) return null;
  if (provider === "RAZORPAY") return String(Math.floor(lastSyncedAt.getTime() / 1000));
  if (provider === "SHIPROCKET" || provider === "META_ADS" || provider === "GOOGLE_ADS") {
    return lastSyncedAt.toISOString().slice(0, 10);
  }
  return lastSyncedAt.toISOString();
}

async function processSyncJob(job: Job<SyncJobData>) {
  const { connectionId } = job.data;
  const connection = await prisma.connection.findUnique({ where: { id: connectionId } });
  // Deleted between enqueue and now, or this is a stale retried job for a
  // connection that no longer exists — nothing to do, and definitely not a
  // failure worth retrying.
  if (!connection) return;

  const connector = CONNECTORS[connection.provider];
  if (!connector) {
    logger.error({ connectionId, provider: connection.provider }, "sync_job_unsupported_provider");
    return;
  }

  await prisma.connection.update({
    where: { id: connectionId },
    data: { syncStatus: "SYNCING", syncStartedAt: new Date(), syncProgressCurrent: null, syncProgressTotal: null },
  });

  const ctx = toConnectorContext(connection);
  // Real progress, not a fake spinner — see modules/connectors/types.ts's
  // ConnectorContext.reportProgress. Only Shopify calls this today; every
  // other connector just leaves the connection showing "Syncing…" with no
  // count, which is honest (we don't have a real total for them yet)
  // rather than fabricating one. Failures here are swallowed, not thrown —
  // a progress *update* failing shouldn't fail an otherwise-successful sync.
  ctx.reportProgress = async (current, total) => {
    try {
      await prisma.connection.update({
        where: { id: connectionId },
        data: { syncProgressCurrent: current, syncProgressTotal: total },
      });
    } catch (err) {
      logger.warn({ err, connectionId }, "sync_progress_update_failed");
    }
  };

  const result = await connector.sync(ctx, cursorFor(connection.provider, connection.lastSyncedAt));

  await prisma.connection.update({
    where: { id: connectionId },
    data: {
      syncStatus: "IDLE",
      lastSyncedAt: new Date(),
      lastSyncError: null,
      syncProgressCurrent: null,
      syncProgressTotal: null,
      syncStartedAt: null,
    },
  });

  // Matches are derived state: any sync that lands new orders/payments makes
  // the stored matches stale, and a row whose money visibly arrived would keep
  // saying "No payment found" until someone happened to press the Run button.
  // Ran for every provider rather than a data-bearing allowlist — the engine
  // is idempotent and sub-second, and an allowlist is a trap for the next
  // connector. Isolated: the pull succeeded, so a recon failure must log, not
  // fail the job and re-trigger the whole sync.
  try {
    await runReconciliation(connection.organizationId);
  } catch (err) {
    logger.error({ err, connectionId, organizationId: connection.organizationId }, "post_sync_reconciliation_failed");
  }

  return result;
}

// Concurrency (not queue depth) is the real backpressure valve: however many
// jobs pile up in Redis — one click, one click from every org at once, a
// burst of scheduled repair syncs later — only SYNC_WORKER_CONCURRENCY of
// them ever hold a Prisma connection or an outbound HTTP request to a
// provider API at the same time. Everything else waits in Redis, which is
// cheap and durable, instead of piling up as open DB connections, open
// sockets, or blocked Node event-loop work the way the old inline
// request-handler version did. A rate limiter is layered on top as a second,
// coarser guard against thundering-herd bursts (e.g. many orgs clicking
// "Sync now" in the same second), independent of how many worker processes
// are running.
export function startSyncWorker() {
  const worker = new Worker<SyncJobData>("connection-sync", processSyncJob, {
    connection: redisConnection,
    concurrency: env.SYNC_WORKER_CONCURRENCY,
    limiter: { max: 20, duration: 1_000 },
    // BullMQ's default (maxStalledCount: 1) marks a job permanently failed
    // the *first* time its lock isn't renewed in time — which happens any
    // time this worker process restarts mid-job (a deploy, or in dev, `tsx
    // watch` picking up a source change — a real, recurring event for this
    // project, not a rare edge case; confirmed live when editing this very
    // file killed an in-flight sync outright). 3 tolerates a couple of
    // restarts before genuinely giving up — the job just starts over from
    // the beginning on retry (no partial-progress resumption exists), which
    // is an acceptable cost for not losing an in-progress sync to a routine
    // restart.
    maxStalledCount: 3,
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, connectionId: job.data.connectionId }, "sync_job_completed");
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    logger.error(
      { jobId: job.id, connectionId: job.data.connectionId, attemptsMade: job.attemptsMade, err },
      "sync_job_attempt_failed"
    );
    // Only surface FAILED (and give up) once BullMQ has genuinely stopped
    // trying — either it's exhausted all retry attempts, OR the error is a
    // BullMQ UnrecoverableError, which skips the retry count entirely (e.g.
    // "job stalled more than allowable limit" — a worker process that died/
    // restarted mid-job, losing its lock). Checking attemptsMade alone was a
    // real bug found in practice: an UnrecoverableError on attempt 1 of 3
    // left the connection stuck showing SYNCING forever, since BullMQ had
    // already given up but this handler hadn't recognized that yet.
    const attemptsAllowed = job.opts.attempts ?? 1;
    const isUnrecoverable = err.name === "UnrecoverableError";
    if (isUnrecoverable || job.attemptsMade >= attemptsAllowed) {
      await prisma.connection.update({
        where: { id: job.data.connectionId },
        data: {
          syncStatus: "FAILED",
          lastSyncError: err.message.slice(0, 500),
          syncProgressCurrent: null,
          syncProgressTotal: null,
          syncStartedAt: null,
        },
      });
    }
  });

  logger.info({ concurrency: env.SYNC_WORKER_CONCURRENCY }, "sync_worker_started");
  return worker;
}
