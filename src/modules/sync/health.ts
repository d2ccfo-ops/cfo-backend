import { prisma } from "../../lib/prisma.js";

// The pattern a connection's CURRENT status cannot express (P5.5).
//
// Deliberately in its own module rather than beside runRepairSweep, and the
// reason is the trap syncCadence.ts documents at length: repair.ts imports the
// sync queue, so importing it constructs a BullMQ Queue at module scope, opens
// a Redis connection, and keeps any importing process alive forever. This is a
// pure read. A check script must be able to ask "is any feed silently dead"
// and then terminate.

export interface DriftReport {
  connectionId: string;
  provider: string;
  /** Runs that completed but fetched nothing, most recent first. */
  consecutiveEmptyRuns: number;
  consecutiveFailures: number;
  lastRunAt: string | null;
  concern: string | null;
}

/**
 * What the run history says about a connection, as opposed to what its current
 * status says.
 *
 * Connection.syncStatus can only ever describe the last attempt. This is the
 * pattern: four empty nights in a row on a store that takes orders daily is a
 * dead feed reporting success, and it is invisible from the status field.
 */
export async function readSyncHealth(organizationId: string): Promise<DriftReport[]> {
  const connections = await prisma.connection.findMany({
    where: { organizationId, status: "ACTIVE" },
    select: { id: true, provider: true },
  });

  const reports: DriftReport[] = [];
  for (const c of connections) {
    const runs = await prisma.syncRun.findMany({
      where: { connectionId: c.id },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: { status: true, startedAt: true, recordsFetched: true },
    });

    let emptyStreak = 0;
    let failStreak = 0;
    for (const r of runs) {
      if (r.status === "EMPTY") emptyStreak += 1;
      else break;
    }
    for (const r of runs) {
      if (r.status === "FAILED") failStreak += 1;
      else break;
    }

    let concern: string | null = null;
    if (failStreak >= 3) {
      concern = `${failStreak} consecutive failures. A retry will not fix a revoked token — this needs re-connecting.`;
    } else if (emptyStreak >= 4) {
      // The failure mode nothing else notices: a provider that answers 200
      // with an empty list because the credential no longer has scope.
      concern = `${emptyStreak} consecutive runs fetched nothing. The connector is reporting success and returning no data, which is what an expired or de-scoped credential looks like.`;
    }

    reports.push({
      connectionId: c.id,
      provider: c.provider,
      consecutiveEmptyRuns: emptyStreak,
      consecutiveFailures: failStreak,
      lastRunAt: runs[0]?.startedAt.toISOString() ?? null,
      concern,
    });
  }
  return reports;
}
