import { Prisma } from "@prisma/client";
import { Router } from "express";
import { costOf, costWithoutCaching, pricedModels, ratesFor } from "../../lib/aiPricing.js";
import { prisma } from "../../lib/prisma.js";
import { daysParam, limitParam, since } from "./shared.js";

export const internalAiRouter = Router();

// What Anthropic costs us, computed from tokens at read time.
//
// Everything here is backed by data this system has recorded since the AI CFO
// shipped — AgentRun carries four token counters and a model name per question,
// AgentToolCall carries one row per tool the model reached for. Nothing on this
// router is estimated.
//
// The one exception is called out in its own field rather than blended in:
// briefs written before the token columns existed carry NULL, and are counted
// as `unmeasuredBriefs` instead of being averaged in as zero.

const DAY_MS = 24 * 60 * 60_000;

interface TokenSums {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function zeroTokens(): TokenSums {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addTokens(a: TokenSums, b: TokenSums): TokenSums {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** bigint | number | null out of a SUM(), as a plain number. */
function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  return 0;
}

interface DailyModelRow {
  day: Date;
  model: string;
  runs: bigint | number;
  input: bigint | number | null;
  output: bigint | number | null;
  cacheRead: bigint | number | null;
  cacheWrite: bigint | number | null;
}

/**
 * Cost per day, per model, per feature.
 *
 * The two features are different tables and are deliberately queried
 * separately rather than unioned: they carry different columns, the brief's
 * "day" is already a calendar-day string in the organisation's timezone while
 * a run has an instant, and merging them would require picking one of those
 * two notions of a day and silently misfiling the other.
 */
internalAiRouter.get("/usage", async (req, res) => {
  const days = daysParam(req, 30);
  const from = since(days * DAY_MS);

  const runRows = await prisma.$queryRaw<DailyModelRow[]>`
    SELECT date_trunc('day', "startedAt") AS day,
           model,
           COUNT(*) AS runs,
           SUM("inputTokens") AS "input",
           SUM("outputTokens") AS "output",
           SUM("cacheReadTokens") AS "cacheRead",
           SUM("cacheWriteTokens") AS "cacheWrite"
    FROM agent_runs
    WHERE "startedAt" >= ${from}
    GROUP BY 1, 2
    ORDER BY 1
  `;

  // Briefs group on their own day column, which is already YYYY-MM-DD in the
  // organisation's timezone. Rows with NULL counters are pre-instrumentation
  // and are counted, not summed — see the schema note on those columns.
  const briefRows = await prisma.$queryRaw<
    Array<{ day: string; model: string | null; briefs: bigint | number; measured: bigint | number; input: bigint | number | null; output: bigint | number | null; cacheRead: bigint | number | null; cacheWrite: bigint | number | null }>
  >`
    SELECT "day",
           model,
           COUNT(*) AS briefs,
           COUNT("inputTokens") AS measured,
           SUM("inputTokens") AS "input",
           SUM("outputTokens") AS "output",
           SUM("cacheReadTokens") AS "cacheRead",
           SUM("cacheWriteTokens") AS "cacheWrite"
    FROM ai_daily_briefs
    WHERE "createdAt" >= ${from}
    GROUP BY 1, 2
    ORDER BY 1
  `;

  const series: Array<{
    day: string;
    feature: "ai-cfo-chat" | "daily-brief";
    model: string;
    calls: number;
    tokens: TokenSums;
    costMicroUsd: string | null;
    costWithoutCachingMicroUsd: string | null;
  }> = [];

  let total = 0n;
  let totalWithoutCaching = 0n;
  let unpricedCalls = 0;
  let unmeasuredBriefs = 0;
  const totals = zeroTokens();
  const unpricedModels = new Set<string>();

  for (const r of runRows) {
    const tokens: TokenSums = {
      inputTokens: num(r.input),
      outputTokens: num(r.output),
      cacheReadTokens: num(r.cacheRead),
      cacheWriteTokens: num(r.cacheWrite),
    };
    const at = new Date(r.day);
    const cost = costOf(tokens, r.model, at);
    const uncached = costWithoutCaching(tokens, r.model, at);
    if (cost === null) {
      unpricedCalls += num(r.runs);
      unpricedModels.add(r.model);
    } else {
      total += cost.total;
      totalWithoutCaching += uncached ?? cost.total;
    }
    Object.assign(totals, addTokens(totals, tokens));
    series.push({
      day: at.toISOString().slice(0, 10),
      feature: "ai-cfo-chat",
      model: r.model,
      calls: num(r.runs),
      tokens,
      costMicroUsd: cost === null ? null : cost.total.toString(),
      costWithoutCachingMicroUsd: uncached === null ? null : uncached.toString(),
    });
  }

  for (const r of briefRows) {
    const briefs = num(r.briefs);
    const measured = num(r.measured);
    unmeasuredBriefs += briefs - measured;
    if (measured === 0) continue;

    const tokens: TokenSums = {
      inputTokens: num(r.input),
      outputTokens: num(r.output),
      cacheReadTokens: num(r.cacheRead),
      cacheWriteTokens: num(r.cacheWrite),
    };
    const model = r.model ?? "(unknown)";
    const at = new Date(`${r.day}T00:00:00Z`);
    const cost = costOf(tokens, model, at);
    const uncached = costWithoutCaching(tokens, model, at);
    if (cost === null) {
      unpricedCalls += measured;
      unpricedModels.add(model);
    } else {
      total += cost.total;
      totalWithoutCaching += uncached ?? cost.total;
    }
    Object.assign(totals, addTokens(totals, tokens));
    series.push({
      day: r.day,
      feature: "daily-brief",
      model,
      calls: measured,
      tokens,
      costMicroUsd: cost === null ? null : cost.total.toString(),
      costWithoutCachingMicroUsd: uncached === null ? null : uncached.toString(),
    });
  }

  res.json({
    windowDays: days,
    from: from.toISOString(),
    series,
    totals: {
      tokens: totals,
      costMicroUsd: total.toString(),
      // What the identical traffic would have cost with prompt caching off.
      // The difference is what caching is worth — stated as a counterfactual
      // rather than as "cache reads were cheap", which would credit caching for
      // tokens that would never have been sent.
      costWithoutCachingMicroUsd: totalWithoutCaching.toString(),
      savedByCachingMicroUsd: (totalWithoutCaching - total).toString(),
    },
    // Never folded into the totals. A model with no rate in lib/aiPricing.ts
    // would otherwise report as free, and free is the one wrong answer nobody
    // investigates.
    unpriced: { calls: unpricedCalls, models: [...unpricedModels].sort(), knownModels: pricedModels() },
    // Briefs written before the token columns existed. Unmeasured, not free.
    unmeasuredBriefs,
  });
});

/** The runs that cost the most, priced individually. */
internalAiRouter.get("/runs", async (req, res) => {
  const days = daysParam(req, 30);
  const limit = limitParam(req, 50);
  const from = since(days * DAY_MS);

  // Ordered by total tokens rather than by cost, because cost is not a column —
  // it is derived below. Token count is a good enough proxy to pick candidates
  // within one model, and the page re-sorts by the priced figure.
  const runs = await prisma.agentRun.findMany({
    where: { startedAt: { gte: from } },
    orderBy: [{ inputTokens: "desc" }, { outputTokens: "desc" }],
    take: limit * 3,
    select: {
      id: true,
      organizationId: true,
      userId: true,
      question: true,
      status: true,
      model: true,
      turns: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      error: true,
      verification: true,
      startedAt: true,
      finishedAt: true,
    },
  });

  const priced = runs
    .map((r) => {
      const cost = costOf(r, r.model, r.startedAt);
      return {
        id: r.id,
        organizationId: r.organizationId,
        userId: r.userId,
        question: r.question.slice(0, 300),
        status: r.status,
        model: r.model,
        turns: r.turns,
        tokens: {
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheWriteTokens: r.cacheWriteTokens,
        },
        error: r.error,
        verification: r.verification,
        startedAt: r.startedAt.toISOString(),
        durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
        costMicroUsd: cost === null ? null : cost.total.toString(),
        _sort: cost === null ? -1n : cost.total,
      };
    })
    .sort((a, b) => (b._sort > a._sort ? 1 : b._sort < a._sort ? -1 : 0))
    .slice(0, limit)
    .map(({ _sort, ...rest }) => rest);

  res.json({ windowDays: days, runs: priced });
});

/**
 * Where the turns went.
 *
 * EXHAUSTED is the status worth staring at: it means the run hit its turn cap
 * without producing an answer, so every token it spent bought nothing. It is
 * reported separately from FAILED for that reason — a failure is an error to
 * fix, an exhaustion is a budget being burned by a loop that was working
 * exactly as designed.
 */
internalAiRouter.get("/waste", async (req, res) => {
  const days = daysParam(req, 30);
  const from = since(days * DAY_MS);

  const byStatus = await prisma.agentRun.groupBy({
    by: ["status", "model"],
    where: { startedAt: { gte: from } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
  });

  const rows = byStatus.map((g) => {
    const tokens: TokenSums = {
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      cacheReadTokens: g._sum.cacheReadTokens ?? 0,
      cacheWriteTokens: g._sum.cacheWriteTokens ?? 0,
    };
    // Priced at today's rate, not at each run's own — this is a rollup over a
    // window, and the alternative is a per-run query to recover start dates
    // that would not change the conclusion.
    const cost = costOf(tokens, g.model, new Date());
    return {
      status: g.status,
      model: g.model,
      runs: g._count._all,
      tokens,
      costMicroUsd: cost === null ? null : cost.total.toString(),
      priced: cost !== null,
    };
  });

  const wastedMicro = rows
    .filter((r) => r.status === "EXHAUSTED" || r.status === "FAILED")
    .reduce((acc, r) => acc + BigInt(r.costMicroUsd ?? "0"), 0n);

  const turnHistogram = await prisma.agentRun.groupBy({
    by: ["turns"],
    where: { startedAt: { gte: from } },
    _count: { _all: true },
    orderBy: { turns: "asc" },
  });

  res.json({
    windowDays: days,
    byStatus: rows,
    wastedMicroUsd: wastedMicro.toString(),
    turns: turnHistogram.map((t) => ({ turns: t.turns, runs: t._count._all })),
  });
});

/** Per-tool call counts, durations and failure rates. */
internalAiRouter.get("/tools", async (req, res) => {
  const days = daysParam(req, 30);
  const from = since(days * DAY_MS);

  const rows = await prisma.$queryRaw<
    Array<{ toolName: string; calls: bigint | number; failures: bigint | number; totalMs: bigint | number | null; maxMs: number | null; medianMs: number | null }>
  >`
    SELECT "toolName",
           COUNT(*) AS calls,
           COUNT(*) FILTER (WHERE NOT ok) AS failures,
           SUM("durationMs") AS "totalMs",
           MAX("durationMs") AS "maxMs",
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "durationMs") AS "medianMs"
    FROM agent_tool_calls
    WHERE "createdAt" >= ${from}
    GROUP BY 1
    ORDER BY calls DESC
  `;

  res.json({
    windowDays: days,
    tools: rows.map((r) => {
      const calls = num(r.calls);
      const failures = num(r.failures);
      return {
        toolName: r.toolName,
        calls,
        failures,
        failureRate: calls === 0 ? null : failures / calls,
        medianMs: r.medianMs === null ? null : Math.round(r.medianMs),
        maxMs: r.maxMs,
        totalMs: num(r.totalMs),
      };
    }),
  });
});

/**
 * Did the answers check out.
 *
 * Every AI answer is verified against the tool results that produced it, and
 * the verdict is stored on the run. `pii` is reported on its own and must stay
 * that way: it is the one count where a single occurrence is an incident, so it
 * must never be able to round to zero inside a percentage.
 */
internalAiRouter.get("/quality", async (req, res) => {
  const days = daysParam(req, 30);
  const from = since(days * DAY_MS);

  const runs = await prisma.agentRun.findMany({
    // Prisma.DbNull, not null: on a Json column `null` is an ambiguous filter
    // — it could mean the SQL NULL or a stored JSON `null` literal — and Prisma
    // refuses it rather than guess. DbNull is the SQL one, which is what an
    // unverified run has.
    where: { startedAt: { gte: from }, verification: { not: Prisma.DbNull } },
    select: { id: true, organizationId: true, verification: true, startedAt: true },
  });

  let clean = 0;
  const unsupportedFigures: Array<{ runId: string; organizationId: string; figures: string[] }> = [];
  const badSources: Array<{ runId: string; organizationId: string; sources: string[] }> = [];
  const piiLeaks: Array<{ runId: string; organizationId: string; at: string }> = [];

  for (const r of runs) {
    const v = r.verification as { figures?: unknown; sources?: unknown; pii?: unknown } | null;
    if (!v) continue;
    const figures = Array.isArray(v.figures) ? (v.figures as string[]) : [];
    const sources = Array.isArray(v.sources) ? (v.sources as string[]) : [];
    const pii = v.pii === true;

    if (figures.length > 0) unsupportedFigures.push({ runId: r.id, organizationId: r.organizationId, figures });
    if (sources.length > 0) badSources.push({ runId: r.id, organizationId: r.organizationId, sources });
    if (pii) piiLeaks.push({ runId: r.id, organizationId: r.organizationId, at: r.startedAt.toISOString() });
    if (figures.length === 0 && sources.length === 0 && !pii) clean += 1;
  }

  res.json({
    windowDays: days,
    verifiedRuns: runs.length,
    clean,
    cleanRate: runs.length === 0 ? null : clean / runs.length,
    unsupportedFigures: unsupportedFigures.slice(0, 100),
    unsupportedFigureCount: unsupportedFigures.length,
    badSources: badSources.slice(0, 100),
    badSourceCount: badSources.length,
    // Deliberately the full list, never truncated and never expressed as a
    // rate. One is an incident.
    piiLeaks,
  });
});

/** The rate table itself, so a cost figure on screen can be checked. */
internalAiRouter.get("/pricing", (_req, res) => {
  const now = new Date();
  res.json({
    asOf: now.toISOString(),
    unit: "microUsd",
    note: "Costs are computed from token counts at read time against effective-dated rates; they are never stored. Verify against Anthropic's published price list.",
    models: pricedModels().map((model) => {
      const r = ratesFor(model, now);
      return {
        model,
        inputPerMillion: r?.inputPerMillion.toString() ?? null,
        outputPerMillion: r?.outputPerMillion.toString() ?? null,
        cacheReadPerMillion: r?.cacheReadPerMillion.toString() ?? null,
        cacheWritePerMillion: r?.cacheWritePerMillion.toString() ?? null,
      };
    }),
  });
});
