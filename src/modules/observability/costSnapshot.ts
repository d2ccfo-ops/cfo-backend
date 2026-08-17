import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { costOf } from "../../lib/aiPricing.js";
import { computeCloudCost } from "./cloudCost.js";

// WHAT THIS MONTH COSTS, WRITTEN DOWN WHILE IT IS STILL KNOWABLE.
//
// Both halves of the figure are computed from things that only exist in the
// present tense. The GCP half is priced from the machine that is running right
// now against today's published rates; the AI half is measured from token
// counts. Ask either question about last March and there is no answer — the
// machine type nobody recorded, at rates nobody kept.
//
// So the number is captured as it happens. cost_snapshots is one row per month,
// upserted as the month progresses, and it is deliberately NOT back-filled.
// A back-fill here would be pricing a machine that may not have existed at
// rates that certainly were not in effect, which is fabrication with a chart
// around it. The panel says "collecting since" and shows one point until there
// are two.
//
// THE DENOMINATORS TRAVEL WITH THE NUMERATOR. Cost per order and cost per
// active organisation are the only forms of this number anybody can act on, and
// recomputing them later against today's order count would silently restate
// history every time a backfill lands. Orders and active organisations for the
// month are stored on the same row.

const MONTH_KEY = (d: Date) => d.toISOString().slice(0, 7);

export interface SnapshotResult {
  month: string;
  gcpUsdMicro: bigint;
  aiUsdMicro: bigint;
  orders: number;
  activeOrgs: number;
  machineType: string | null;
  /** Set when the GCP half could not be priced; the AI half is still recorded. */
  gcpError?: string;
}

/**
 * Compute and store the current month.
 *
 * Idempotent by month, so running it hourly, or twice, or after a restart,
 * converges on the same row rather than accumulating.
 */
export async function captureCostSnapshot(now = new Date()): Promise<SnapshotResult> {
  const month = MONTH_KEY(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  // ---- AI, measured ----
  // Per (model), because pricing is per model and a sum across models priced at
  // one rate is wrong by whatever the mix is.
  const [runRows, briefRows] = await Promise.all([
    prisma.agentRun.groupBy({
      by: ["model"],
      where: { startedAt: { gte: monthStart, lt: monthEnd } },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
    }),
    prisma.aiDailyBrief.groupBy({
      by: ["model"],
      where: { createdAt: { gte: monthStart, lt: monthEnd } },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
    }),
  ]);

  let aiUsdMicro = 0n;
  for (const r of [...runRows, ...briefRows]) {
    if (!r.model) continue;
    const c = costOf(
      {
        inputTokens: r._sum.inputTokens ?? 0,
        outputTokens: r._sum.outputTokens ?? 0,
        cacheReadTokens: r._sum.cacheReadTokens ?? 0,
        cacheWriteTokens: r._sum.cacheWriteTokens ?? 0,
      },
      r.model,
      now,
    );
    // A model with no rate card contributes nothing rather than a guess. It
    // shows up as unpriced on /ai, which is where that belongs.
    if (c) aiUsdMicro += c.total;
  }

  // ---- GCP, priced from live inventory ----
  //
  // computeCloudCost returns a PER-MONTH rate for the resources that exist right
  // now. Charging the whole month's rate on the 2nd would overstate the
  // month-to-date, so it is prorated by elapsed days — which is also how a
  // steady-state VM actually bills.
  let gcpUsdMicro = 0n;
  let machineType: string | null = null;
  let gcpError: string | undefined;
  try {
    const cloud = await computeCloudCost();
    machineType = cloud.machineType;
    if (cloud.error) gcpError = cloud.error;
    if (cloud.totalUsdPerMonth !== null) {
      const daysInMonth = (monthEnd.getTime() - monthStart.getTime()) / 86_400_000;
      const elapsed = Math.min(daysInMonth, Math.max(0, (now.getTime() - monthStart.getTime()) / 86_400_000));
      const prorated = cloud.totalUsdPerMonth * (elapsed / daysInMonth);
      gcpUsdMicro = BigInt(Math.round(prorated * 1_000_000));
    }
  } catch (err) {
    gcpError = err instanceof Error ? err.message : String(err);
  }

  // ---- denominators ----
  const [orders, activeOrgs] = await Promise.all([
    // placedAt, not createdAt. The denominator is the month's BUSINESS volume;
    // createdAt is when the row was ingested, so a backfill would credit six
    // months of orders to whichever month the connector was plugged in.
    prisma.order.count({ where: { placedAt: { gte: monthStart, lt: monthEnd } } }),
    prisma.membership
      .findMany({ where: { lastSeenAt: { gte: monthStart, lt: monthEnd } }, select: { organizationId: true }, distinct: ["organizationId"] })
      .then((r) => r.length),
  ]);

  const row = { gcpUsdMicro, aiUsdMicro, orders, activeOrgs, machineType };
  await prisma.costSnapshot.upsert({ where: { month }, create: { month, ...row }, update: { ...row, capturedAt: now } });

  const result: SnapshotResult = { month, ...row };
  if (gcpError !== undefined) result.gcpError = gcpError;
  return result;
}

/**
 * Run on a timer.
 *
 * HOURLY, not nightly, and the reason is the proration above: a snapshot taken
 * once a day is a step function, and the last one before a month rolls over
 * would leave the month permanently short by up to a day of compute. Hourly
 * costs one upsert and two aggregates.
 */
const INTERVAL_MS = 3_600_000;
let timer: NodeJS.Timeout | null = null;

export function startCostSnapshotWriter(intervalMs = INTERVAL_MS): void {
  if (timer) return;
  const tick = () => {
    captureCostSnapshot()
      .then((r) => logger.info({ month: r.month, gcpUsdMicro: r.gcpUsdMicro.toString(), aiUsdMicro: r.aiUsdMicro.toString() }, "cost_snapshot_captured"))
      .catch((err: unknown) => logger.error({ err }, "cost_snapshot_failed"));
  };
  // On start, so a fresh deployment has a row rather than an empty panel for an
  // hour — and so the very first month has a point at all.
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

export function stopCostSnapshotWriter(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
