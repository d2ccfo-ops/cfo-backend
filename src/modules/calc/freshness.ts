import { prisma } from "../../lib/prisma.js";

// "Data freshness" — how recently each connected source actually delivered
// data. Not a money metric, so no MetricSnapshot and no formula version: it
// describes the state of the pipeline right now, and a historical record of
// past staleness isn't something any card asks for.
//
// IMPORTANT CAVEAT, and the reason this returns raw ages rather than a
// reassuring green tick: `lastSyncedAt` only advances when a sync JOB
// completes. Webhook deliveries write rows (orders, shipments, payments)
// WITHOUT touching it, so a webhook-fed connector like ClickPost can be
// perfectly up to date and still report as stale here. Read "stale" as "no
// full sync recently", not "data is missing".
//
// A scheduler now exists (modules/queue/syncScheduler.ts sweeps due
// connections every 5 minutes), so this is far less alarming than it was when
// syncs only ran on a button press — but the distinction above still holds,
// and one provider is deliberately never swept: BANK is CSV-fed, so its age
// here is the age of the last uploaded statement, which is exactly right.

const STALE_AFTER_MINUTES = 24 * 60;

export type SourceFreshness = {
  connectionId: string;
  provider: string;
  status: string;
  syncStatus: string;
  lastSyncedAt: string | null;
  ageMinutes: number | null;
  fresh: boolean;
  lastSyncError: string | null;
};

export async function getDataFreshness(organizationId: string) {
  const connections = await prisma.connection.findMany({
    where: { organizationId },
    select: {
      id: true,
      provider: true,
      status: true,
      syncStatus: true,
      lastSyncedAt: true,
      lastSyncError: true,
    },
    orderBy: { provider: "asc" },
  });

  const now = Date.now();
  const sources: SourceFreshness[] = connections.map((c) => {
    const ageMinutes =
      c.lastSyncedAt === null ? null : Math.max(0, Math.round((now - c.lastSyncedAt.getTime()) / 60_000));
    return {
      connectionId: c.id,
      provider: c.provider,
      status: c.status,
      syncStatus: c.syncStatus,
      lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      ageMinutes,
      // Never-synced counts as not fresh. A connection that has never
      // completed a sync is the least fresh state there is, not an unknown.
      fresh: ageMinutes !== null && ageMinutes <= STALE_AFTER_MINUTES,
      lastSyncError: c.lastSyncError,
    };
  });

  // Only ACTIVE connections belong in the headline ratio. A PENDING or
  // REVOKED connection isn't a stale source — it isn't a source at all, and
  // counting it would make the card read "3/5 sources" forever after someone
  // abandons a half-finished connect flow.
  const active = sources.filter((s) => s.status === "ACTIVE");
  const freshCount = active.filter((s) => s.fresh).length;
  const newest = active
    .map((s) => s.ageMinutes)
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b)[0];

  return {
    metricKey: "data_freshness",
    totalSources: active.length,
    freshSources: freshCount,
    staleSources: active.length - freshCount,
    erroredSources: active.filter((s) => s.lastSyncError !== null).length,
    newestAgeMinutes: newest ?? null,
    staleAfterMinutes: STALE_AFTER_MINUTES,
    sources,
    // Describes the pipeline right now, so a date filter has nothing to act
    // on — "how fresh was my data on 3 July" isn't a question this can answer
    // and isn't one anyone asks.
    periodFiltered: false,
    pointInTime: true,
    checkedAt: new Date().toISOString(),
  };
}
