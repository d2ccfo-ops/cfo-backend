import { Router } from "express";
import { costOf } from "../../lib/aiPricing.js";
import { prisma } from "../../lib/prisma.js";
import { scoreTenants } from "../../modules/observability/tenantHealth.js";
import { daysParam, since } from "./shared.js";

export const internalTenantsRouter = Router();

const DAY_MS = 24 * 60 * 60_000;

/**
 * Every organisation, with what it costs and whether its data is flowing.
 *
 * Assembled from several grouped queries and merged in memory rather than one
 * join: the organisation count is small (tens, not millions), and a single
 * query joining orders, syncs, members and AI runs would fan out into a
 * multiplied row count that then has to be de-duplicated — the classic way this
 * kind of rollup silently multiplies every figure by the number of rows in the
 * largest joined table.
 */
internalTenantsRouter.get("/", async (req, res) => {
  const days = daysParam(req, 30);
  const from = since(days * DAY_MS);

  const [orgs, members, connections, syncRuns, orders, aiRuns, anomalies, activeUsers] = await Promise.all([
    prisma.organization.findMany({ select: { id: true, name: true, timezone: true, createdAt: true } }),
    prisma.membership.groupBy({ by: ["organizationId"], _count: { _all: true } }),
    prisma.connection.groupBy({ by: ["organizationId", "status"], _count: { _all: true } }),
    prisma.syncRun.groupBy({
      by: ["organizationId", "status"],
      where: { startedAt: { gte: from } },
      _count: { _all: true },
    }),
    prisma.order.groupBy({ by: ["organizationId"], where: { createdAt: { gte: from } }, _count: { _all: true } }),
    prisma.agentRun.groupBy({
      by: ["organizationId", "model"],
      where: { startedAt: { gte: from } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
    }),
    prisma.anomaly.groupBy({
      by: ["organizationId", "severity"],
      where: { status: "OPEN" },
      _count: { _all: true },
    }),
    prisma.membership.groupBy({
      by: ["organizationId"],
      where: { lastSeenAt: { gte: since(7 * DAY_MS) } },
      _count: { _all: true },
    }),
  ]);

  const index = <T extends { organizationId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.organizationId) ?? [];
      list.push(r);
      m.set(r.organizationId, list);
    }
    return m;
  };

  const memberBy = new Map(members.map((m) => [m.organizationId, m._count._all]));
  const orderBy = new Map(orders.map((o) => [o.organizationId, o._count._all]));
  const activeBy = new Map(activeUsers.map((a) => [a.organizationId, a._count._all]));
  const connBy = index(connections);
  const syncBy = index(syncRuns);
  const aiBy = index(aiRuns);
  const anomalyBy = index(anomalies);

  const now = new Date();
  const rows = orgs.map((org) => {
    const conns = connBy.get(org.id) ?? [];
    const syncs = syncBy.get(org.id) ?? [];
    const ai = aiBy.get(org.id) ?? [];
    const anom = anomalyBy.get(org.id) ?? [];

    const syncTotal = syncs.reduce((a, s) => a + s._count._all, 0);
    const syncOk = syncs
      .filter((s) => s.status === "SUCCEEDED" || s.status === "EMPTY")
      .reduce((a, s) => a + s._count._all, 0);

    let aiCost = 0n;
    let aiRunCount = 0;
    let unpricedRuns = 0;
    for (const g of ai) {
      aiRunCount += g._count._all;
      const cost = costOf(
        {
          inputTokens: g._sum.inputTokens ?? 0,
          outputTokens: g._sum.outputTokens ?? 0,
          cacheReadTokens: g._sum.cacheReadTokens ?? 0,
          cacheWriteTokens: g._sum.cacheWriteTokens ?? 0,
        },
        g.model,
        now,
      );
      if (cost === null) unpricedRuns += g._count._all;
      else aiCost += cost.total;
    }

    return {
      id: org.id,
      name: org.name,
      timezone: org.timezone,
      createdAt: org.createdAt.toISOString(),
      members: memberBy.get(org.id) ?? 0,
      activeUsers7d: activeBy.get(org.id) ?? 0,
      connections: {
        total: conns.reduce((a, c) => a + c._count._all, 0),
        // Both axes are reported. A connection's own status says whether its
        // credential still works; the sync outcome below says whether data
        // actually moved. They disagree often, and collapsing them into one
        // health figure is how a broken pipeline reads as green.
        byStatus: conns.map((c) => ({ status: c.status, count: c._count._all })),
      },
      syncs: {
        total: syncTotal,
        succeeded: syncOk,
        failed: syncs.filter((s) => s.status === "FAILED").reduce((a, s) => a + s._count._all, 0),
        successRate: syncTotal === 0 ? null : syncOk / syncTotal,
      },
      ordersInWindow: orderBy.get(org.id) ?? 0,
      ai: { runs: aiRunCount, costMicroUsd: aiCost.toString(), unpricedRuns },
      openAnomalies: anom.map((a) => ({ severity: a.severity, count: a._count._all })),
    };
  });

  res.json({ windowDays: days, organizations: rows });
});

/**
 * EVERY TENANT, SCORED.
 *
 * REGISTERED BEFORE /:id ON PURPOSE. Express matches in declaration order, so
 * putting this after the parameterised route would send every request here to
 * the detail handler looking for an organisation whose id is the literal string
 * "health" — a 404 that looks like a missing tenant rather than a routing bug.
 *
 * The scoring, and why absence is a state rather than a low number, is in
 * modules/observability/tenantHealth.ts.
 */
internalTenantsRouter.get("/health", async (_req, res) => {
  const tenants = await scoreTenants();
  const counted = (s: string) => tenants.filter((t) => t.state === s).length;
  res.json({
    tenants,
    counts: {
      total: tenants.length,
      healthy: counted("healthy"),
      degraded: counted("degraded"),
      atRisk: counted("at_risk"),
      dormant: counted("dormant"),
      notOnboarded: counted("not_onboarded"),
    },
  });
});

/**
 * THE VIEW FOR WHEN A CUSTOMER EMAILS.
 *
 * Everything needed to answer "why does my dashboard look wrong" without
 * logging in as them: how healthy they are and why, how fresh each kind of
 * their data is, which connectors are failing and with what message, and what
 * exceptions are open.
 *
 * WHAT IS DELIBERATELY ABSENT: their numbers. No revenue, no margins, no
 * anomaly narratives, no AI conversation text. This console is cross-tenant and
 * the rule at the top of index.ts is that it does not touch tenant data — the
 * exception carved here is METADATA about their data (how much, how fresh, what
 * broke), which is what a support question actually needs. Whoever needs the
 * figures themselves opens the customer's own view, where the access is scoped
 * and audited like any other read.
 */
internalTenantsRouter.get("/:id/support", async (req, res) => {
  const organizationId = req.params.id;
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, timezone: true, createdAt: true },
  });
  if (!org) {
    res.status(404).json({ error: "No organisation with that id." });
    return;
  }

  const [health, connections, failures, anomalies, freshness, members] = await Promise.all([
    scoreTenants().then((all) => all.find((t) => t.organizationId === organizationId) ?? null),
    prisma.connection.findMany({
      where: { organizationId },
      select: { id: true, provider: true, status: true, syncStatus: true, lastSyncedAt: true, lastSyncError: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    // Verbatim, most recent first. The message is the whole point — "sync
    // failed" is not actionable and "Invalid authentication tag length: 0" is.
    prisma.syncRun.findMany({
      where: { organizationId, status: "FAILED" },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: { provider: true, error: true, startedAt: true, trigger: true },
    }),
    // ACKNOWLEDGED is included: somebody having seen an exception does not make
    // the customer's numbers right again.
    prisma.anomaly.findMany({
      where: { organizationId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
      take: 50,
      // Type, severity and timing only. The narrative and the amounts are the
      // customer's figures, not ours to page through.
      select: { id: true, type: true, severity: true, status: true, createdAt: true, periodStart: true, periodEnd: true },
    }),
    // The single most common support question is "why is my dashboard behind",
    // and the answer is always the newest row of some particular kind.
    Promise.all([
      prisma.order.aggregate({ where: { organizationId }, _max: { placedAt: true }, _count: { _all: true } }),
      prisma.payment.aggregate({ where: { organizationId }, _max: { createdAt: true }, _count: { _all: true } }),
      prisma.settlement.aggregate({ where: { organizationId }, _max: { createdAt: true }, _count: { _all: true } }),
      prisma.shipment.aggregate({ where: { organizationId }, _max: { createdAt: true }, _count: { _all: true } }),
      prisma.bankTransaction.aggregate({ where: { organizationId }, _max: { createdAt: true }, _count: { _all: true } }),
      prisma.adSpend.aggregate({ where: { organizationId }, _max: { createdAt: true }, _count: { _all: true } }),
    ]),
    prisma.membership.findMany({
      where: { organizationId },
      select: { email: true, role: true, lastSeenAt: true, createdAt: true },
      orderBy: { lastSeenAt: "desc" },
    }),
  ]);

  const [orders, payments, settlements, shipments, bank, ads] = freshness;
  const fresh = (label: string, newest: Date | null, count: number) => ({
    kind: label,
    rows: count,
    // Null newest with rows > 0 means the column is null across the board, not
    // that the data is old. Kept apart so a page can say which.
    newestAt: newest?.toISOString() ?? null,
    ageHours: newest === null ? null : Math.round(((Date.now() - newest.getTime()) / 3_600_000) * 10) / 10,
  });

  res.json({
    organization: { ...org, createdAt: org.createdAt.toISOString() },
    health,
    connections: connections.map((c) => ({
      ...c,
      lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
    recentFailures: failures.map((f) => ({ ...f, startedAt: f.startedAt.toISOString() })),
    openAnomalies: anomalies.map((a) => ({ ...a, createdAt: a.createdAt.toISOString(), periodStart: a.periodStart.toISOString(), periodEnd: a.periodEnd.toISOString() })),
    freshness: [
      fresh("Orders", orders._max.placedAt, orders._count._all),
      fresh("Payments", payments._max.createdAt, payments._count._all),
      fresh("Settlements", settlements._max.createdAt, settlements._count._all),
      fresh("Shipments", shipments._max.createdAt, shipments._count._all),
      fresh("Bank transactions", bank._max.createdAt, bank._count._all),
      fresh("Ad spend", ads._max.createdAt, ads._count._all),
    ],
    members: members.map((m) => ({ ...m, lastSeenAt: m.lastSeenAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString() })),
    withheld: "Revenue, margins, anomaly narratives and AI conversations are deliberately not returned here. Open the customer's own view for those.",
  });
});

/** One organisation, in depth. */
internalTenantsRouter.get("/:id", async (req, res) => {
  const days = daysParam(req, 30);
  const from = since(days * DAY_MS);
  const organizationId = req.params.id;

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, timezone: true, createdAt: true, settings: true },
  });
  if (!org) {
    res.status(404).json({ error: "organization_not_found" });
    return;
  }

  const [members, connections, recentSyncs, aiRuns, anomalies, audit, counts] = await Promise.all([
    prisma.membership.findMany({
      where: { organizationId },
      select: { clerkUserId: true, email: true, role: true, createdAt: true, lastSeenAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.connection.findMany({
      where: { organizationId },
      select: { id: true, provider: true, status: true, syncStatus: true, lastSyncedAt: true, lastSyncError: true, createdAt: true },
    }),
    prisma.syncRun.findMany({
      where: { organizationId, startedAt: { gte: from } },
      orderBy: { startedAt: "desc" },
      take: 50,
      select: { id: true, provider: true, trigger: true, status: true, recordsFetched: true, recordsWritten: true, cursor: true, error: true, startedAt: true, durationMs: true },
    }),
    prisma.agentRun.groupBy({
      by: ["model"],
      where: { organizationId, startedAt: { gte: from } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
    }),
    prisma.anomaly.groupBy({
      by: ["type", "severity", "status"],
      where: { organizationId },
      _count: { _all: true },
    }),
    prisma.auditLog.findMany({
      where: { organizationId, createdAt: { gte: from } },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { actorType: true, actorId: true, action: true, entityType: true, entityId: true, createdAt: true },
    }),
    Promise.all([
      prisma.order.count({ where: { organizationId } }),
      // OrderLineItem is the one table here without its own
      // organizationId — it is scoped through its order. Counting it via the
      // relation rather than adding a denormalised column for a metrics page.
      prisma.orderLineItem.count({ where: { order: { organizationId } } }),
      prisma.payment.count({ where: { organizationId } }),
      prisma.settlement.count({ where: { organizationId } }),
      prisma.shipment.count({ where: { organizationId } }),
      prisma.bankTransaction.count({ where: { organizationId } }),
      prisma.adSpend.count({ where: { organizationId } }),
      prisma.product.count({ where: { organizationId } }),
    ]),
  ]);

  const now = new Date();
  let aiCost = 0n;
  let unpricedRuns = 0;
  const aiByModel = aiRuns.map((g) => {
    const tokens = {
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      cacheReadTokens: g._sum.cacheReadTokens ?? 0,
      cacheWriteTokens: g._sum.cacheWriteTokens ?? 0,
    };
    const cost = costOf(tokens, g.model, now);
    if (cost === null) unpricedRuns += g._count._all;
    else aiCost += cost.total;
    return { model: g.model, runs: g._count._all, tokens, costMicroUsd: cost === null ? null : cost.total.toString() };
  });

  const [orders, lineItems, payments, settlements, shipments, bankTransactions, adSpend, products] = counts;

  res.json({
    organization: { ...org, createdAt: org.createdAt.toISOString() },
    windowDays: days,
    members: members.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
    })),
    connections: connections.map((c) => ({
      ...c,
      lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
    recentSyncs: recentSyncs.map((s) => ({ ...s, startedAt: s.startedAt.toISOString() })),
    ai: { byModel: aiByModel, costMicroUsd: aiCost.toString(), unpricedRuns },
    anomalies: anomalies.map((a) => ({ type: a.type, severity: a.severity, status: a.status, count: a._count._all })),
    audit: audit.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    dataVolume: { orders, lineItems, payments, settlements, shipments, bankTransactions, adSpend, products },
  });
});
