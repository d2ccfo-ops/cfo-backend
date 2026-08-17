import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { computeCloudCost } from "../../modules/observability/cloudCost.js";
import { readBillingExport } from "../../modules/observability/billingExport.js";
import { costOf } from "../../lib/aiPricing.js";

export const internalEconomicsRouter = Router();

const DAY_MS = 86_400_000;

/**
 * What GCP charges, priced from the inventory that actually exists.
 *
 * NOT AN INVOICE, and the response says so in a field rather than only in a
 * comment: `isInvoice: false` plus an explicit `excludes` list travel with the
 * number, so a caller cannot render the total without also having the
 * caveats. The billed truth needs the Cloud Billing export to BigQuery — see
 * /billing below, which reads it when one exists and says precisely what is
 * missing when one does not.
 */
internalEconomicsRouter.get("/cloud", async (_req, res) => {
  res.json(await computeCloudCost());
});

/**
 * THE INVOICE, IF IT IS AVAILABLE.
 *
 * Deliberately a separate endpoint from /cloud rather than a field on it. They
 * are different KINDS of number — one is a model, the other is what Google
 * billed — and merging them into a single "cost" would make the most important
 * distinction on this page invisible the first time someone enables the export.
 */
internalEconomicsRouter.get("/billing", async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  res.json(await readBillingExport(months));
});

/**
 * COST OVER TIME, AND THE TWO RATIOS ANYBODY CAN ACT ON.
 *
 * Read straight off cost_snapshots, which is written hourly. It is deliberately
 * NOT recomputed here: the denominators were captured with the numerator, and
 * recomputing today's order count against last month's spend would silently
 * restate history every time a backfill lands.
 */
internalEconomicsRouter.get("/cost-history", async (_req, res) => {
  const snaps = await prisma.costSnapshot.findMany({ orderBy: { month: "asc" } });

  const months = snaps.map((s) => {
    const total = s.gcpUsdMicro + s.aiUsdMicro;
    return {
      month: s.month,
      gcpUsdMicro: s.gcpUsdMicro.toString(),
      aiUsdMicro: s.aiUsdMicro.toString(),
      totalUsdMicro: total.toString(),
      orders: s.orders,
      activeOrgs: s.activeOrgs,
      machineType: s.machineType,
      // Null rather than zero when there is no denominator. "₹0 per order"
      // for a month with no orders is a division by zero wearing a currency
      // symbol.
      perOrderUsdMicro: s.orders === 0 ? null : (total / BigInt(s.orders)).toString(),
      perActiveOrgUsdMicro: s.activeOrgs === 0 ? null : (total / BigInt(s.activeOrgs)).toString(),
      capturedAt: s.capturedAt.toISOString(),
    };
  });

  res.json({
    /**
     * Collection began here. There is no history before it and none will be
     * invented: pricing a machine nobody can prove existed, at rates nobody
     * recorded, is fabrication with a chart around it.
     */
    collectingSince: snaps[0]?.month ?? null,
    /** The current month is partial — prorated to the hour, not a full month. */
    currentMonthIsPartial: true,
    months,
  });
});

// There is deliberately NO "capture a snapshot now" endpoint. It was written
// and removed: captureCostSnapshot upserts, so exposing it would put a WRITE
// behind a GET on the one router whose stated rule is that it only reads.
// Nothing is lost — the hourly writer runs on worker start, so the current
// month always has a row within seconds of a deploy.

/**
 * COST PER TENANT.
 *
 * ONE HALF OF THIS IS MEASURED AND THE OTHER IS ALLOCATED, and they are
 * returned as separate fields because they are not the same kind of fact.
 *
 *   AI is measured. agent_runs and ai_daily_briefs carry an organizationId and
 *   four token counters per call, so this is what that tenant actually cost in
 *   model spend, to the microdollar.
 *
 *   Infrastructure is allocated. One VM runs every tenant; there is no
 *   per-tenant CPU-second anywhere in this system and there is no honest way to
 *   derive one. So the shared cost is split by request share — the fraction of
 *   API calls each organisation made — and it is labelled as an allocation with
 *   its basis stated. A different basis would give a different answer, which is
 *   what "allocated" means and why it must never be added to the measured half
 *   and presented as one figure.
 */
internalEconomicsRouter.get("/cost-per-tenant", async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  const from = new Date(Date.now() - days * DAY_MS);
  const now = new Date();

  const [orgs, runs, briefs, requests, cloud] = await Promise.all([
    prisma.organization.findMany({ select: { id: true, name: true } }),
    prisma.agentRun.groupBy({
      by: ["organizationId", "model"],
      where: { startedAt: { gte: from } },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
      _count: { _all: true },
    }),
    prisma.aiDailyBrief.groupBy({
      by: ["organizationId", "model"],
      where: { createdAt: { gte: from } },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
      _count: { _all: true },
    }),
    // The allocation basis. audit_logs is the only cross-tenant table that
    // records one row per organisation action; request_metrics has no
    // organizationId at all (deliberately — see its schema note on cardinality).
    prisma.auditLog.groupBy({ by: ["organizationId"], where: { createdAt: { gte: from } }, _count: { _all: true } }),
    computeCloudCost().catch(() => null),
  ]);

  const aiByOrg = new Map<string, { micro: bigint; calls: number; unpriced: number }>();
  for (const r of [...runs, ...briefs]) {
    const cur = aiByOrg.get(r.organizationId) ?? { micro: 0n, calls: 0, unpriced: 0 };
    cur.calls += r._count._all;
    const c = r.model
      ? costOf(
          {
            inputTokens: r._sum.inputTokens ?? 0,
            outputTokens: r._sum.outputTokens ?? 0,
            cacheReadTokens: r._sum.cacheReadTokens ?? 0,
            cacheWriteTokens: r._sum.cacheWriteTokens ?? 0,
          },
          r.model,
          now,
        )
      : null;
    if (c) cur.micro += c.total;
    else cur.unpriced += r._count._all;
    aiByOrg.set(r.organizationId, cur);
  }

  const actionsByOrg = new Map(requests.map((r) => [r.organizationId, r._count._all]));
  const totalActions = [...actionsByOrg.values()].reduce((a, b) => a + b, 0);

  // The window's share of the monthly rate, so a 7-day view is not charged a
  // month of compute.
  const infraForWindowUsd = cloud?.totalUsdPerMonth === null || cloud === null ? null : (cloud.totalUsdPerMonth * days) / 30.44;
  const infraMicro = infraForWindowUsd === null ? null : BigInt(Math.round(infraForWindowUsd * 1_000_000));

  const tenants = orgs
    .map((o) => {
      const ai = aiByOrg.get(o.id) ?? { micro: 0n, calls: 0, unpriced: 0 };
      const actions = actionsByOrg.get(o.id) ?? 0;
      const share = totalActions === 0 ? null : actions / totalActions;
      const allocated = infraMicro === null || share === null ? null : BigInt(Math.round(Number(infraMicro) * share));
      return {
        organizationId: o.id,
        name: o.name,
        aiUsdMicro: ai.micro.toString(),
        aiCalls: ai.calls,
        /** Calls on a model with no rate card. Counted, never priced at zero. */
        aiUnpricedCalls: ai.unpriced,
        actions,
        allocationShare: share,
        allocatedInfraUsdMicro: allocated === null ? null : allocated.toString(),
      };
    })
    .sort((a, b) => Number(BigInt(b.aiUsdMicro) - BigInt(a.aiUsdMicro)));

  res.json({
    windowDays: days,
    tenants,
    allocation: {
      basis: "share of audited actions in the window",
      /**
       * Said plainly, next to the number, because the difference between these
       * two words is the difference between a fact and an accounting choice.
       */
      note: "AI cost is measured per organisation from token counts. Infrastructure cost is ALLOCATED — one VM serves every tenant and no per-tenant CPU measurement exists. A different basis would give a different split.",
      infraUsdMicroForWindow: infraMicro === null ? null : infraMicro.toString(),
      totalActions,
      /** True when no action was audited at all, so nothing could be allocated. */
      unallocatable: totalActions === 0,
    },
  });
});
