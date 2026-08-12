import { prisma } from "../../lib/prisma.js";
import { claimAndEnqueueSync } from "../queue/syncQueue.js";

// §12.4 repair sync (P5.5).
//
// THE PROBLEM THIS FIXES. An order that is edited AFTER it was last synced —
// a refund keyed in by hand, a line cancelled, an address corrected — reaches
// this system only through a webhook. A missed webhook is silent and
// permanent: the order sits in the database in its old shape forever, and
// every figure derived from it is quietly wrong. Nothing detects it, because
// there is nothing to compare against.
//
// Re-pulling the trailing window is the only correction that exists. It costs
// one extra pull per night per connection and it is the difference between
// "our numbers drift" and "our numbers are right".
//
// SEVEN DAYS, and the number is a judgement rather than a constant: Shopify
// order edits cluster in the days right after the order (refunds, returns,
// address fixes), and a wider window costs API quota to re-confirm records
// that have not moved. A month-old edit is missed — which is stated here
// rather than hidden, because someone will eventually ask why a September
// correction never appeared.
//
// The sweep lives here, not in the scheduler, for the reason syncCadence.ts
// documents at length: a module that imports the queue opens a Redis
// connection at import time and keeps any importing process alive forever.
// This one DOES import the queue — so nothing that merely wants to reason
// about repair may import this file. The scheduler is its only caller.

export const REPAIR_WINDOW_DAYS = 7;

/**
 * Providers whose records can change after we first see them.
 *
 * Deliberately not "all of them". A settlement is immutable once a provider
 * has paid it; an ad-spend row for a past day is restated by the platform on
 * its own cadence and the normal sync already re-reads the recent window. The
 * ones here are the ones where a silent post-hoc edit is both possible and
 * material.
 */
export const REPAIRABLE_PROVIDERS = new Set(["SHOPIFY", "AMAZON", "FLIPKART"]);

export interface RepairSweepResult {
  connections: number;
  enqueued: number;
  /** Skipped because a sync was already in flight — not a failure. */
  busy: number;
  skipped: Array<{ connectionId: string; provider: string; reason: string }>;
}

export async function runRepairSweep(now: Date = new Date()): Promise<RepairSweepResult> {
  const connections = await prisma.connection.findMany({
    where: { status: "ACTIVE", provider: { in: [...REPAIRABLE_PROVIDERS] as never } },
    select: { id: true, provider: true, lastSyncedAt: true, organizationId: true },
  });

  const result: RepairSweepResult = { connections: connections.length, enqueued: 0, busy: 0, skipped: [] };

  for (const c of connections) {
    // A connection that has never completed a sync has nothing to repair —
    // its first pull is a backfill and covers everything. Enqueuing a repair
    // would race it and double the work.
    if (!c.lastSyncedAt) {
      result.skipped.push({ connectionId: c.id, provider: c.provider, reason: "never synced — the backfill covers this window" });
      continue;
    }
    const claimed = await claimAndEnqueueSync(c.id, { trigger: "REPAIR", repairWindowDays: REPAIR_WINDOW_DAYS });
    if (claimed) result.enqueued += 1;
    else result.busy += 1;
  }

  return result;
}
