import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { prisma } from "../../lib/prisma.js";
import { redisConnection } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";

export interface SyncJobData {
  connectionId: string;
  /**
   * Why this run was enqueued (P5.5). Recorded on the SyncRun row so a
   * founder reading the history can tell a nightly pass from a repair pass
   * from someone pressing the button — three things that produce identical
   * rows otherwise, and only one of which is worth investigating when it
   * fails at 02:00.
   */
  trigger?: "MANUAL" | "SCHEDULED" | "REPAIR" | "BACKFILL";
  /**
   * §12.4 repair window. When set, the connector re-pulls from this many days
   * ago regardless of the stored cursor — the only way an edit made to an
   * order after its last sync, whose webhook was missed, ever gets corrected.
   */
  repairWindowDays?: number;
}

// One queue, shared by every provider — the job payload is just a
// connectionId, and modules/queue/syncWorker.ts looks up the provider (and
// therefore the right Connector) from the Connection row itself, the same
// way routes/connections/index.ts's inline sync used to. This is what
// actually protects the server: enqueuing is a single cheap Redis write, not
// an open DB connection or a held HTTP request, so it doesn't matter how
// many "Sync now" clicks arrive at once — they queue up safely and the
// worker's bounded concurrency (env.SYNC_WORKER_CONCURRENCY) decides how
// many actually run.
export const syncQueue = new Queue<SyncJobData>("connection-sync", {
  connection: redisConnection,
  defaultJobOptions: {
    // Transient failures (a rate limit, a dropped connection mid-pagination)
    // shouldn't require the founder to notice and re-click — retry with
    // backoff first. 3 total attempts, not more: a sync that fails 3 times
    // in a row is very likely a real problem (bad token, revoked access) that
    // retrying won't fix, and it should surface as FAILED rather than retry
    // forever.
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    // Completed/failed jobs are cheap but not free to keep in Redis forever —
    // bounded retention instead of the default (keep everything).
    removeOnComplete: { age: 60 * 60, count: 1000 },
    removeOnFail: { age: 24 * 60 * 60, count: 1000 },
  },
});

// jobId is unique per enqueue, NOT connectionId — a tempting shortcut, but
// wrong: BullMQ refuses to add a new job under a jobId that's still occupied
// by a *previous* job sitting in Redis under its removeOnComplete/
// removeOnFail retention window, silently no-op-ing the add. That would
// permanently wedge a connection the first time its jobId got reused after
// a completed sync. Real double-click/multi-tab dedup instead happens in
// Postgres — see routes/connections/index.ts's atomic
// `updateMany(... syncStatus: { in: ["IDLE", "FAILED"] } ...)` guard, which
// runs *before* this is ever called, so by the time we get here the caller
// has already confirmed no sync is in flight for this connection.
export function enqueueSync(connectionId: string, opts: Omit<SyncJobData, "connectionId"> = {}) {
  // BullMQ uses ":" as its own Redis key separator and rejects custom job
  // ids containing one — "-" instead.
  return syncQueue.add("sync", { connectionId, ...opts }, { jobId: `${connectionId}-${randomUUID()}` });
}

// The claim-then-enqueue transition, in ONE place because there are now two
// callers — the "Sync now" route and the scheduler sweep — and they must not
// drift. The atomic updateMany is the whole point: only IDLE/FAILED may become
// QUEUED, so a sweep that fires while a founder is mid-click (or while a job is
// already running) claims nothing and enqueues nothing. A plain read-then-write
// would have a TOCTOU gap wide enough to double-sync a connection.
//
// Returns false when the connection was already in flight. On a Redis failure
// the QUEUED flag is rolled back — otherwise the guard above would keep
// blocking this connection forever, wedging it with no way back to IDLE.
export async function claimAndEnqueueSync(
  connectionId: string,
  opts: Omit<SyncJobData, "connectionId"> = {}
): Promise<boolean> {
  const claimed = await prisma.connection.updateMany({
    where: { id: connectionId, syncStatus: { in: ["IDLE", "FAILED"] } },
    data: { syncStatus: "QUEUED", lastSyncError: null, syncProgressCurrent: null, syncProgressTotal: null },
  });
  if (claimed.count === 0) return false;

  try {
    // ---------------------------------------------------------------------------
    // A DEADLINE, BECAUSE THE ENQUEUE CAN HANG FOREVER
    // ---------------------------------------------------------------------------
    // lib/redis.ts sets `maxRetriesPerRequest: null` (BullMQ requires it) and
    // leaves ioredis's `enableOfflineQueue` at its default of true. With that
    // pair, a command issued while Redis is unreachable is parked in an
    // in-memory queue and its promise NEVER settles — it does not reject, so
    // the catch below was dead code for the exact outage it was written for.
    //
    // The consequence was not a slow request, it was a permanent one: POST
    // /connections/:id/sync awaited forever, Node applies no response timeout,
    // and the socket plus the whole auth chain stayed pinned until the client
    // gave up. Meanwhile the Postgres claim had already flipped the row to
    // QUEUED, which only IDLE/FAILED can leave — so the connection was wedged
    // too.
    //
    // Racing it converts an unbounded hang into a 5-second failure that the
    // rollback below can actually act on.
    await withDeadline(
      enqueueSync(connectionId, opts),
      ENQUEUE_TIMEOUT_MS,
      `enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms — the queue backend is unreachable`
    );
    return true;
  } catch (err) {
    // Rolled back so the IDLE/FAILED guard does not block this connection
    // forever. Logged rather than swallowed: if the compensating write also
    // fails the row STAYS QUEUED, and that is precisely the wedged state the
    // sweep in syncCadence.ts has to recover — silence here made it
    // undiagnosable.
    await prisma.connection
      .updateMany({ where: { id: connectionId, syncStatus: "QUEUED" }, data: { syncStatus: "IDLE" } })
      .catch((rollbackErr) => {
        logger.error(
          { err: rollbackErr, connectionId },
          "sync_claim_rollback_failed — connection left QUEUED, the stale-claim sweep will recover it"
        );
      });
    throw err;
  }
}

/** How long to wait for the queue to accept a job before treating it as down. */
const ENQUEUE_TIMEOUT_MS = 5_000;

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
    // The winning branch clears the timer so a resolved enqueue does not hold
    // the event loop open for five seconds.
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}
