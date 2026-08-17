import { Queue, type Job } from "bullmq";
import { redisConnection } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";

// WHAT IS ACTUALLY IN THE QUEUES, read from BullMQ itself.
//
// The console's jobs page carried two hand-written panels here — a 24h queue
// depth chart and a list of nightly sweeps — and both were invented. This
// replaces them with what BullMQ will actually tell us, which is not the same
// shape, and the difference is the point:
//
//   * DEPTH IS INSTANTANEOUS. BullMQ keeps counts, not history. Nothing in this
//     deployment records how deep a queue was an hour ago, so a 24h chart could
//     only ever have been drawn from numbers nobody measured. What is real is
//     "right now, N jobs are waiting", and that is what this returns. A real
//     history would need queue depth added to the SystemSample sampler; until
//     someone does that, the honest panel is a snapshot and says so.
//
//   * THE SCHEDULE IS REAL AND LIVES IN REDIS. Every sweep registers through
//     upsertJobScheduler, so getJobSchedulers returns the actual cron pattern,
//     the actual timezone and the next fire time BullMQ itself computed. The
//     fixture listed eight jobs at made-up times; there are seven queues and
//     their real patterns disagree with every one of them.
//
// QUEUES ARE DISCOVERED, NOT LISTED. Scanning for `bull:*:meta` reports the
// queues that exist rather than the ones this file remembers — the same choice
// made in cloudCost.ts, and for the same reason: a hard-coded list is wrong the
// first time someone adds a scheduler and nobody notices, and the failure is
// silent (a queue backing up in a panel that never mentions it). It also means
// no Queue object is ever constructed for a name that does not already exist,
// so reading the page cannot create a phantom queue.

/** BullMQ's default key prefix. Every queue in this app uses it. */
const PREFIX = "bull";

/**
 * Ceilings on discovery. Not tuning — termination guarantees. SCAN returns a
 * cursor the server chooses, and a loop that trusts it to reach "0" is a loop
 * that can hang an observability endpoint on a keyspace that keeps changing.
 */
const MAX_QUEUES = 64;
const MAX_SCAN_ITERATIONS = 200;
const SCAN_COUNT = 500;

/** How many finished jobs to inspect when looking for the most recent one. */
const RECENT_SAMPLE = 3;

export interface QueueScheduler {
  id: string;
  /** The job name each fire produces, e.g. "sweep". */
  jobName: string | null;
  /** Cron pattern, when the schedule is a cron. Mutually exclusive with everyMs. */
  pattern: string | null;
  /** Fixed interval in ms, when the schedule is an interval. */
  everyMs: number | null;
  timezone: string | null;
  /** BullMQ's own computed next fire time, ISO. Null if it could not compute one. */
  nextRunAt: string | null;
  /**
   * TRUE when the next fire time is already in the past.
   *
   * BullMQ advances `next` only when the scheduler actually produces a job, so
   * a next-run stuck behind the current time is not a display quirk — it means
   * nothing has consumed this schedule since then, i.e. the worker is down or
   * wedged. It is the one thing on this panel that finds a dead worker without
   * waiting for a missing row to be noticed the next morning.
   */
  overdue: boolean;
}

export interface QueueLastRun {
  status: "completed" | "failed";
  jobName: string;
  finishedAt: string;
  durationMs: number | null;
  /** Present only on a failure, and never truncated to look tidy. */
  error: string | null;
}

export interface QueueStatus {
  name: string;
  isPaused: boolean;
  /** Jobs enqueued and not yet picked up — the number that means "backing up". */
  waiting: number;
  active: number;
  /**
   * Includes the scheduler's own next job. Every scheduler queue sits at
   * delayed:1 permanently by design — that is the pending next fire, not a
   * backlog — so this number must never be styled as a warning on its own.
   */
  delayed: number;
  failed: number;
  completed: number;
  /**
   * Every count BullMQ reports, including states this app does not use, so a
   * queue stuck in one of them is visible rather than invisible.
   */
  counts: Record<string, number>;
  schedulers: QueueScheduler[];
  /**
   * Null is not "never ran". Finished jobs are trimmed by removeOnComplete /
   * removeOnFail (an hour for completions on connection-sync), so a quiet queue
   * legitimately has nothing to report and must not be drawn as a failure.
   */
  lastRun: QueueLastRun | null;
  /** Set when this one queue could not be read; the rest are still returned. */
  error?: string;
}

export interface QueueInventory {
  readAt: string;
  queues: QueueStatus[];
  /** Total waiting across every queue — the single number worth alerting on. */
  totalWaiting: number;
  totalFailed: number;
  /** Schedules whose next fire time has already passed. Non-zero means a worker is not running. */
  overdueSchedules: number;
  /** True when discovery stopped at MAX_QUEUES rather than running out. */
  truncated: boolean;
  error?: string;
}

/**
 * Queue objects are cached because constructing one attaches listeners to the
 * shared ioredis connection. Seven per request, every 60s, would be a slow leak
 * in the one process that must not leak.
 */
const queueCache = new Map<string, Queue>();

function queueFor(name: string): Queue {
  let q = queueCache.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnection });
    queueCache.set(name, q);
  }
  return q;
}

async function discoverQueueNames(): Promise<{ names: string[]; truncated: boolean }> {
  const names = new Set<string>();
  let cursor = "0";
  let iterations = 0;

  do {
    const [next, keys] = await redisConnection.scan(
      cursor,
      "MATCH",
      `${PREFIX}:*:meta`,
      "COUNT",
      SCAN_COUNT,
    );
    cursor = next;
    for (const key of keys) {
      // bull:<name>:meta. Greedy, because BullMQ only warns about colons in a
      // queue name rather than rejecting them — anchoring on the suffix is the
      // one split that stays right if someone uses one.
      const match = /^bull:(.+):meta$/.exec(key);
      if (match?.[1]) names.add(match[1]);
    }
    iterations += 1;
  } while (cursor !== "0" && iterations < MAX_SCAN_ITERATIONS && names.size < MAX_QUEUES);

  return { names: [...names].sort(), truncated: names.size >= MAX_QUEUES };
}

function toLastRun(job: Job, status: "completed" | "failed"): QueueLastRun | null {
  if (!job.finishedOn) return null;
  return {
    status,
    jobName: job.name,
    finishedAt: new Date(job.finishedOn).toISOString(),
    durationMs: job.processedOn ? job.finishedOn - job.processedOn : null,
    error: status === "failed" ? (job.failedReason ?? "failed with no reason recorded") : null,
  };
}

/**
 * The most recently FINISHED job, whichever way it finished.
 *
 * Both lists are sampled and compared on finishedOn rather than trusting either
 * to be ordered the way this code expects. A cheaper "just take the newest
 * failure" would report a queue as failing hours after it recovered, which is
 * the specific wrong answer that makes an ops panel worse than no panel.
 */
async function readLastRun(queue: Queue): Promise<QueueLastRun | null> {
  const [completed, failed] = await Promise.all([
    queue.getJobs(["completed"], 0, RECENT_SAMPLE - 1),
    queue.getJobs(["failed"], 0, RECENT_SAMPLE - 1),
  ]);

  const candidates = [
    ...completed.map((j) => toLastRun(j, "completed")),
    ...failed.map((j) => toLastRun(j, "failed")),
  ].filter((r): r is QueueLastRun => r !== null);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  return candidates[0] ?? null;
}

async function readQueue(name: string, now: number): Promise<QueueStatus> {
  const base: QueueStatus = {
    name,
    isPaused: false,
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
    counts: {},
    schedulers: [],
    lastRun: null,
  };

  try {
    const queue = queueFor(name);
    const [counts, isPaused, schedulers, lastRun] = await Promise.all([
      queue.getJobCounts(),
      queue.isPaused(),
      queue.getJobSchedulers(0, 49, true),
      readLastRun(queue),
    ]);

    return {
      ...base,
      isPaused,
      // "waiting", not "wait". getJobCounts returns the long form; the short
      // one is what the Redis list is called, and reading it here silently
      // reports every queue as empty — the exact failure this panel exists to
      // catch, reported as health.
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
      counts,
      schedulers: schedulers.map((s) => {
        const next = s.next ?? null;
        return {
          id: s.key,
          jobName: s.name ?? null,
          pattern: s.pattern ?? null,
          everyMs: s.every === undefined ? null : Number(s.every),
          timezone: s.tz ?? null,
          nextRunAt: next === null ? null : new Date(next).toISOString(),
          overdue: next !== null && next < now,
        };
      }),
      lastRun,
    };
  } catch (err) {
    // One unreadable queue must not blank the whole panel — the others are
    // still the answer to "is anything backing up".
    logger.warn({ err, queue: name }, "queue_inventory_queue_failed");
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function readQueueInventory(): Promise<QueueInventory> {
  const now = Date.now();
  const readAt = new Date(now).toISOString();

  try {
    const { names, truncated } = await discoverQueueNames();
    // One `now` for the whole read, not one per queue. Otherwise a schedule
    // due this second is overdue in one row and not in the next, and the panel
    // disagrees with itself.
    const queues = await Promise.all(names.map((n) => readQueue(n, now)));

    return {
      readAt,
      queues,
      totalWaiting: queues.reduce((a, q) => a + q.waiting, 0),
      totalFailed: queues.reduce((a, q) => a + q.failed, 0),
      overdueSchedules: queues.reduce((a, q) => a + q.schedulers.filter((s) => s.overdue).length, 0),
      truncated,
    };
  } catch (err) {
    // Redis being unreachable is the condition this endpoint exists to show, so
    // it is returned as data with a message rather than thrown as a 500 with
    // none.
    logger.warn({ err }, "queue_inventory_failed");
    return {
      readAt,
      queues: [],
      totalWaiting: 0,
      totalFailed: 0,
      overdueSchedules: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
