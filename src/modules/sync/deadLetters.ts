import { prisma } from "../../lib/prisma.js";

// The dead-letter view (P5.5).
//
// BullMQ already keeps failed jobs — removeOnFail retains them for 30 days —
// but reading them means talking to Redis, and Redis is not the place a
// founder's dashboard should be querying. More importantly, a BullMQ job id
// means nothing to anyone: it does not say which connection, which
// organisation, or what a person should do about it.
//
// So the dead letter surface is built from SyncRun instead. Every failed
// attempt already writes one, with the connection, the provider, the cursor it
// started from and the error — everything a person needs to decide whether to
// re-connect or to wait. Reading Postgres for this also means the check
// scripts can exercise it without a Redis connection, which is the same
// discipline syncCadence.ts documents for the queue modules.

/** How long a failure stays interesting. Older than this and it is history. */
const WINDOW_DAYS = 14;

export interface DeadLetter {
  connectionId: string;
  provider: string;
  failures: number;
  firstFailureAt: string;
  lastFailureAt: string;
  /** The most recent error, verbatim. Truncated at write time, not here. */
  error: string | null;
  /** Whether anything has succeeded since. A cleared failure is not a problem. */
  recoveredSince: boolean;
  recommendation: string;
}

export async function readDeadLetters(organizationId: string, now: Date = new Date()): Promise<DeadLetter[]> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const runs = await prisma.syncRun.findMany({
    where: { organizationId, startedAt: { gte: since } },
    orderBy: { startedAt: "desc" },
    select: { connectionId: true, provider: true, status: true, error: true, startedAt: true },
  });

  const byConnection = new Map<string, typeof runs>();
  for (const r of runs) byConnection.set(r.connectionId, [...(byConnection.get(r.connectionId) ?? []), r]);

  const out: DeadLetter[] = [];
  for (const [connectionId, list] of byConnection) {
    const failures = list.filter((r) => r.status === "FAILED");
    if (failures.length === 0) continue;

    // Ordered newest-first, so index 0 of the whole list is the latest attempt
    // of any kind. If that succeeded, the failure is history.
    const recovered = list[0]!.status !== "FAILED";
    const latest = failures[0]!;
    const oldest = failures[failures.length - 1]!;

    out.push({
      connectionId,
      provider: latest.provider,
      failures: failures.length,
      firstFailureAt: oldest.startedAt.toISOString(),
      lastFailureAt: latest.startedAt.toISOString(),
      error: latest.error,
      recoveredSince: recovered,
      recommendation: recovered
        ? "This connection has synced successfully since. Nothing to do."
        : failures.length >= 3
          ? "Three or more failures with no success since. A retry will not fix a revoked token — re-connect this source."
          : "Retry it, or wait for the next scheduled sweep. Transient provider errors clear on their own.",
    });
  }

  // Unrecovered first, then by failure count: the ones needing a decision
  // should not be below the ones that already fixed themselves.
  return out.sort((a, b) => Number(a.recoveredSince) - Number(b.recoveredSince) || b.failures - a.failures);
}
