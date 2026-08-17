import { statfs } from "node:fs/promises";
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

// HOW MUCH OF THIS MACHINE ARE WE PAYING FOR AND NOT USING.
//
// Nothing could answer that. The deployment is one GCP VM running seven
// containers, billed on provisioned capacity — 4 vCPU, 8GB, a 50GB disk — and
// the gap between provisioned and used is money. Reporting it needs a
// measurement, and the alternative to measuring it is a dashboard of invented
// gauges, which is worse than an empty page.
//
// WHY NOT THE GCP OPS AGENT. It is the better long-term answer and this does
// not rule it out. But it is a separate agent to install and keep running on a
// box otherwise deployed entirely through compose, it bills per metric, and it
// still would not see inside the containers without extra configuration. This
// reads the host's own /proc through Node's os module, ships inside the image
// we already deploy, and is enough for the question that prompted it.
//
// WHAT THESE NUMBERS ARE, PRECISELY — because the temptation to read more into
// them than they hold is the failure mode of any metric:
//
//   * loadavg and memory come from the HOST's /proc, not the container's
//     cgroup. They therefore describe the whole VM — Postgres, Redis, Caddy,
//     both Node processes and anything else — added together. That is the
//     right denominator for "is the box full" and the WRONG one for "which
//     container is at fault". Per-container attribution needs the Docker
//     socket, which this process deliberately does not have.
//   * load is a run-queue length, not a percentage. Divided by the core count
//     it becomes a saturation ratio where 1.0 means fully committed; it can
//     legitimately exceed 1.0 and that is a queue forming, not an error.
//   * disk is the filesystem this process can see, which on this deployment is
//     the VM's single persistent disk.
//
// Runs in the worker, not the API. The API is four clustered processes and
// would take four identical samples a minute of the same host; the worker is
// deliberately single-process (see src/worker.ts) and so samples exactly once.

// 15s, not 60s. A minute is coarse enough to miss the thing this is for: the
// dashboard fires ~15 metric endpoints at once and the resulting spike is over
// in a couple of seconds, so at 60s it lands between samples and the chart says
// the box was idle through it.
//
// The cost is four rows a minute instead of one — roughly 173k rows over the
// 30-day retention, a few tens of MB, which is noise next to the orders table.
// History responses cap their point count rather than growing with this (see
// MAX_SERIES_POINTS in routes/internal/infra.ts), so lowering it further is a
// storage decision, not a payload one.
//
// This is NOT what backs the live gauges. Those read /proc directly on request
// via GET /internal/infra/live, because any stored cadence is a floor on how
// fresh a polled number can be.
const SAMPLE_INTERVAL_MS = 15_000;

export interface SystemSnapshot {
  load1: number;
  load5: number;
  load15: number;
  cpuCount: number;
  memTotal: bigint;
  memFree: bigint;
  diskTotal: bigint;
  diskFree: bigint;
  procRssBytes: bigint;
  procHeapBytes: bigint;
}

/**
 * One reading of the machine.
 *
 * Disk is the only part that can fail — statfs on a path that has gone away —
 * and it fails to zeros rather than taking the whole sample down, because
 * losing the disk figure is not a reason to lose CPU and memory too. Zero
 * total is how a reader recognises the disk half as absent; a real filesystem
 * never reports zero blocks.
 */
export async function sampleSystem(path = "/"): Promise<SystemSnapshot> {
  const load = loadavg();
  const mem = process.memoryUsage();

  let diskTotal = 0n;
  let diskFree = 0n;
  try {
    const fs = await statfs(path);
    const blockSize = BigInt(fs.bsize);
    diskTotal = BigInt(fs.blocks) * blockSize;
    // bavail, not bfree: bfree includes blocks reserved for root, which this
    // process cannot use and must not report as available.
    diskFree = BigInt(fs.bavail) * blockSize;
  } catch (err) {
    logger.warn({ err, path }, "system_sample_statfs_failed");
  }

  return {
    // loadavg() always returns three entries on every platform Node supports,
    // but the array type does not say so — and on Windows it returns zeros
    // rather than failing, which is the honest value for "this platform has no
    // load average" anyway.
    load1: load[0] ?? 0,
    load5: load[1] ?? 0,
    load15: load[2] ?? 0,
    cpuCount: availableParallelism(),
    memTotal: BigInt(totalmem()),
    memFree: BigInt(freemem()),
    diskTotal,
    diskFree,
    procRssBytes: BigInt(mem.rss),
    procHeapBytes: BigInt(mem.heapUsed),
  };
}

/**
 * Actual CPU utilisation over a short window, as a 0-1 ratio.
 *
 * WHY THIS EXISTS ALONGSIDE loadavg. load1 is a one-minute exponentially
 * decaying average of the run queue. Poll it every two seconds and you get a
 * number that changes and does not move — the burst that this console is
 * supposed to make visible is smeared across the following minute and never
 * appears as a peak. It is the right metric for "is this box overcommitted"
 * and the wrong one for "what is it doing right now".
 *
 * This measures instead: cumulative per-core jiffies from os.cpus(), twice,
 * and the busy fraction of the difference. That is the same arithmetic `top`
 * does.
 *
 * The wait is real time held inside the request. It is a timer, not work, so it
 * occupies no CPU and blocks no other request in an async server — but it does
 * put a floor under the endpoint's latency, which is why it is short and why
 * the sampled window is stated in the response rather than assumed by the
 * caller.
 *
 * Host-wide, like everything else here: every container together, which is the
 * right denominator for "is the machine full".
 */
export async function measureCpuBusy(windowMs = 250): Promise<{ busyRatio: number; windowMs: number }> {
  const totals = () => {
    let idle = 0;
    let total = 0;
    for (const c of cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  };

  const a = totals();
  await new Promise((r) => setTimeout(r, windowMs));
  const b = totals();

  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  // A zero denominator means the clock did not advance far enough to register a
  // tick — report 0 busy rather than dividing by zero and emitting NaN into a
  // chart, which renders as a gap that looks like an outage.
  if (dTotal <= 0) return { busyRatio: 0, windowMs };
  return { busyRatio: Math.max(0, Math.min(1, 1 - dIdle / dTotal)), windowMs };
}

export async function recordSample(): Promise<void> {
  try {
    const snapshot = await sampleSystem();
    await prisma.systemSample.create({ data: snapshot });
  } catch (err) {
    // Observability must never be able to take the worker down. A missed
    // sample leaves a gap in a chart; a thrown error here would stop syncs.
    logger.error({ err }, "system_sample_failed");
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSystemSampler(intervalMs = SAMPLE_INTERVAL_MS): void {
  if (timer) return;
  // One immediately, so a restart does not leave a blank minute at the point
  // somebody is most likely to be looking at the chart.
  void recordSample();
  timer = setInterval(() => {
    void recordSample();
  }, intervalMs);
  timer.unref();
}

export function stopSystemSampler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
