import { prisma } from "../../lib/prisma.js";

// IS EACH CUSTOMER ACTUALLY GETTING WHAT THEY PAY FOR?
//
// Every other panel in this console aggregates: total requests, total syncs,
// total errors. Aggregates hide the shape that matters most here — one tenant
// completely broken for a week is invisible inside a 99.5% success rate, and it
// is the only tenant who will churn.
//
// TWO RULES, both learned from scores that lie:
//
//   A SCORE MUST SHOW ITS WORKING. A single 62/100 is unactionable and, worse,
//   unarguable: nobody can tell whether it means "the connector broke" or "they
//   have not logged in". Every signal below is returned alongside the score,
//   and the score is only ever a sort key for the list.
//
//   ABSENCE IS NOT ILL HEALTH. A tenant who signed up yesterday and connected
//   nothing has no stale data, no failing syncs and no exceptions — a naive
//   score gives them 100, and a naive inversion gives them 0. Neither is true;
//   they are NOT YET ONBOARDED, which is a state, not a number. Dormant is a
//   third state again. The `state` field carries that and the score is null
//   where a score would be a fiction.

const DAY_MS = 86_400_000;

/** How stale ingested data may get before the figures on screen are wrong. */
const FRESH_HOURS = 26;
const STALE_HOURS = 72;
/** No human from this org in this long and the account is drifting. */
const DORMANT_DAYS = 30;

export type TenantState = "not_onboarded" | "healthy" | "degraded" | "at_risk" | "dormant";

export interface TenantSignal {
  key: string;
  /** What this signal actually observed, in words, always. */
  detail: string;
  ok: boolean;
  /** Points removed from 100. Zero when ok. */
  penalty: number;
}

export interface TenantHealth {
  organizationId: string;
  name: string;
  createdAt: string;
  state: TenantState;
  /** Null when the tenant is not onboarded — there is nothing to score. */
  score: number | null;
  signals: TenantSignal[];
  connections: number;
  failingConnections: number;
  lastSyncAt: string | null;
  lastSeenAt: string | null;
  ordersLast7: number;
  openCriticalAnomalies: number;
  syncFailureRate7d: number | null;
}

function hoursSince(d: Date | null, now: number): number | null {
  return d === null ? null : (now - d.getTime()) / 3_600_000;
}

/**
 * Score every organisation.
 *
 * Six queries total, each grouped across all tenants, rather than six per
 * tenant. With a hundred organisations the per-tenant shape is six hundred
 * round trips and a page that times out — and the console is the last place
 * that should be the reason the database is busy.
 */
export async function scoreTenants(now = Date.now()): Promise<TenantHealth[]> {
  const weekAgo = new Date(now - 7 * DAY_MS);

  const [orgs, connections, lastSeen, orders, anomalies, syncRuns] = await Promise.all([
    prisma.organization.findMany({ select: { id: true, name: true, createdAt: true } }),
    prisma.connection.findMany({
      select: { organizationId: true, provider: true, status: true, syncStatus: true, lastSyncedAt: true, lastSyncError: true },
    }),
    prisma.membership.groupBy({ by: ["organizationId"], _max: { lastSeenAt: true } }),
    prisma.order.groupBy({ by: ["organizationId"], where: { placedAt: { gte: weekAgo } }, _count: { _all: true } }),
    // OPEN and ACKNOWLEDGED both count as unresolved. ACKNOWLEDGED means a
    // person has seen it, which is not the same as it having gone away — the
    // customer's figures are still wrong.
    prisma.anomaly.groupBy({
      by: ["organizationId"],
      where: { status: { in: ["OPEN", "ACKNOWLEDGED"] }, severity: "CRITICAL" },
      _count: true,
    }),
    prisma.syncRun.groupBy({
      by: ["organizationId", "status"],
      where: { startedAt: { gte: weekAgo } },
      _count: { _all: true },
    }),
  ]);

  const connByOrg = new Map<string, typeof connections>();
  for (const c of connections) {
    const list = connByOrg.get(c.organizationId) ?? [];
    list.push(c);
    connByOrg.set(c.organizationId, list);
  }
  const seenByOrg = new Map(lastSeen.map((m) => [m.organizationId, m._max.lastSeenAt]));
  const ordersByOrg = new Map(orders.map((o) => [o.organizationId, o._count._all]));
  const anomByOrg = new Map(anomalies.map((a) => [a.organizationId, a._count]));
  const syncByOrg = new Map<string, { total: number; failed: number }>();
  for (const s of syncRuns) {
    const r = syncByOrg.get(s.organizationId) ?? { total: 0, failed: 0 };
    r.total += s._count._all;
    if (s.status === "FAILED") r.failed += s._count._all;
    syncByOrg.set(s.organizationId, r);
  }

  return orgs
    .map((org) => {
      const conns = connByOrg.get(org.id) ?? [];
      const active = conns.filter((c) => c.status === "ACTIVE");
      const failing = conns.filter((c) => c.status === "ERROR" || c.syncStatus === "FAILED" || c.lastSyncError !== null);
      const lastSyncedAt = conns.reduce<Date | null>(
        (acc, c) => (c.lastSyncedAt && (acc === null || c.lastSyncedAt > acc) ? c.lastSyncedAt : acc),
        null,
      );
      const seen = seenByOrg.get(org.id) ?? null;
      const ordersLast7 = ordersByOrg.get(org.id) ?? 0;
      const openCritical = anomByOrg.get(org.id) ?? 0;
      const sync = syncByOrg.get(org.id) ?? null;
      const failRate = sync && sync.total > 0 ? sync.failed / sync.total : null;
      const staleHours = hoursSince(lastSyncedAt, now);
      const seenDays = seen ? (now - seen.getTime()) / DAY_MS : null;

      const base = {
        organizationId: org.id,
        name: org.name,
        createdAt: org.createdAt.toISOString(),
        connections: conns.length,
        failingConnections: failing.length,
        lastSyncAt: lastSyncedAt?.toISOString() ?? null,
        lastSeenAt: seen?.toISOString() ?? null,
        ordersLast7,
        openCriticalAnomalies: openCritical,
        syncFailureRate7d: failRate,
      };

      // NOT ONBOARDED short-circuits everything below. Scoring a tenant with no
      // connections against freshness and sync-failure rules produces a perfect
      // score for an empty account, which would put the customers most at risk
      // of never activating at the top of the healthy list.
      if (active.length === 0) {
        return {
          ...base,
          state: "not_onboarded" as TenantState,
          score: null,
          signals: [
            {
              key: "onboarding",
              ok: false,
              penalty: 0,
              detail:
                conns.length === 0
                  ? "No connection has ever been created. Nothing can be computed for this tenant."
                  : `${conns.length} connection${conns.length === 1 ? "" : "s"} exist but none is ACTIVE — authorisation was started and not finished.`,
            },
          ],
        };
      }

      const signals: TenantSignal[] = [];
      const add = (key: string, ok: boolean, penalty: number, detail: string) =>
        signals.push({ key, ok, penalty: ok ? 0 : penalty, detail });

      add(
        "freshness",
        staleHours !== null && staleHours <= FRESH_HOURS,
        staleHours !== null && staleHours > STALE_HOURS ? 40 : 20,
        staleHours === null
          ? "No connection has ever completed a sync, so every figure on their dashboard is empty rather than wrong."
          : `Newest data is ${staleHours.toFixed(1)}h old (fresh under ${FRESH_HOURS}h).`,
      );

      add(
        "connectors",
        failing.length === 0,
        Math.min(30, failing.length * 15),
        failing.length === 0
          ? `All ${active.length} active connections are clean.`
          : `${failing.length} of ${conns.length} connections are in error: ${failing.map((f) => f.provider).join(", ")}.`,
      );

      add(
        "sync-reliability",
        failRate === null || failRate < 0.2,
        failRate !== null && failRate > 0.5 ? 25 : 10,
        failRate === null
          ? "No sync has run in 7 days — nothing is being retried on their behalf."
          : `${(failRate * 100).toFixed(0)}% of ${sync?.total ?? 0} sync runs failed this week.`,
      );

      add(
        "exceptions",
        openCritical === 0,
        Math.min(20, openCritical * 5),
        openCritical === 0 ? "No critical exception is open." : `${openCritical} critical exceptions open and unresolved.`,
      );

      add(
        "engagement",
        seenDays !== null && seenDays <= DORMANT_DAYS,
        15,
        seen === null
          ? "Nobody from this organisation has ever been seen in the app."
          : `Last seen ${seenDays === null ? "—" : `${seenDays.toFixed(0)} days ago`}.`,
      );

      const score = Math.max(0, 100 - signals.reduce((a, s) => a + s.penalty, 0));

      // Dormancy is judged before health, because a perfectly-syncing account
      // nobody has opened in a month is not healthy — it is about to churn, and
      // reporting it green is the single most expensive thing this page could do.
      const state: TenantState =
        seenDays !== null && seenDays > DORMANT_DAYS
          ? "dormant"
          : score >= 85
            ? "healthy"
            : score >= 60
              ? "degraded"
              : "at_risk";

      return { ...base, state, score, signals };
    })
    .sort((a, b) => {
      // Worst first, and unscoreable tenants after the scored ones — they need
      // a sales conversation, not an on-call response.
      if (a.score === null && b.score === null) return a.name.localeCompare(b.name);
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return a.score - b.score;
    });
}
