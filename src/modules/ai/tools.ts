import { z } from "zod";
import { resolveDateRange, type ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { getAdEfficiencySummary, getAdSpendSummary } from "../calc/ads.js";
import { runAnomalyRules } from "../calc/anomalies.js";
import { getBurnAndRunway } from "../calc/burn.js";
import { getAvailableCashSummary, getCashReceivedSummary } from "../calc/cash.js";
import { DEFAULT_HORIZON, getCashForecast, isForecastHorizon } from "../calc/cashForecast.js";
import { runCashScenario, type ScenarioParams } from "../calc/cashScenario.js";
import { getContributionMargin } from "../calc/contribution.js";
import { getDataStatusMap } from "../calc/dataStatus.js";
import { getDataFreshness } from "../calc/freshness.js";
import { getPayablesSummary } from "../calc/payables.js";
import { getProductProfitability } from "../calc/productProfitability.js";
import { getCodExposure, readReconciliationLegs } from "../calc/reconciliation.js";
import { getNetRevenueSummary } from "../calc/revenue.js";
import { getSalesSummary } from "../calc/sales.js";
import { getRtoRateSummary } from "../calc/shipments.js";
import { getBankMovement, getPendingSettlements, getRefundAnalysis, getSettlementSummary } from "../calc/moneyMovement.js";
import { buildEvidence } from "../../routes/evidence.js";
import { maskPii } from "./pii.js";

// §18 tool registry (P4.1).
//
// THE RULE THIS FILE ENFORCES STRUCTURALLY: the LLM never computes money.
//
// Every tool here is a thin wrapper over a calc function that already exists
// and is already verified against real data. Not one of them adds, divides or
// compares a figure. That is not a stylistic preference — it is the only
// reason an AI answer on this product can be audited at all. A model that
// derives "margin fell 4 points" by subtracting two numbers it was shown has
// produced a figure that appears in no tool result, cannot be traced to a row,
// and cannot be checked by scripts/checkAiRestrictions.ts's string-match
// harness. The model's job is to CHOOSE which question to ask and to explain
// what came back.
//
// Three things every tool returns, per §19:
//   data        — whatever the calc function produced, PII-masked
//   dataStatus  — the §28 honesty label for that metric, so an answer can say
//                 "estimated" instead of implying reconciliation
//   evidenceRef — where a human goes to check it themselves
//
// Org scoping is not a parameter. It is closed over from the authenticated
// context and cannot be named by the model, which is what makes a
// cross-tenant request unrepresentable rather than merely rejected.

export interface ToolContext {
  organizationId: string;
  timeZone: string;
  userId: string;
}

// WHERE A HUMAN GOES TO CHECK A FIGURE.
//
// The first version of this file invented an evidenceRef per tool by naming
// the metric — "/evidence/net_revenue", "/evidence/rto_rate". Eleven of the
// seventeen pointed at nothing: the §21 evidence route serves exactly five
// material metrics (routes/evidence.ts's METRIC_TEXT) and 404s on anything
// else. An answer citing a dead link is worse than one citing none, because
// the citation is what a founder trusts instead of re-checking.
//
// So the set is closed and asserted. Two namespaces live here deliberately:
// ENVELOPE refs resolve to the §21 API envelope with formula, sources and
// sample rows; PAGE refs resolve to the screen that shows the working. A tool
// with neither returns no evidenceRef at all rather than a plausible one.
export const EVIDENCE_ENVELOPE_METRICS = [
  "revenue",
  "contribution_margin",
  "product_profitability",
  "cash_received",
  "cash_forecast",
] as const;

export const EVIDENCE_PAGES = [
  "/reconciliation",
  "/exceptions",
  "/connections",
  "/settlements",
  "/cash-flow",
  "/revenue",
  "/profitability",
  "/inventory",
  "/expenses",
] as const;

const ENVELOPE_REFS = new Set(EVIDENCE_ENVELOPE_METRICS.map((m) => `/evidence/${m}`));
const PAGE_REFS = new Set<string>(EVIDENCE_PAGES);

/** True when the ref resolves to the §21 evidence API rather than a screen. */
export function isEvidenceEnvelopeRef(ref: string): boolean {
  return ENVELOPE_REFS.has(ref);
}

export function isKnownEvidenceRef(ref: string): boolean {
  return ENVELOPE_REFS.has(ref) || PAGE_REFS.has(ref);
}

export interface ToolResult {
  data: unknown;
  dataStatus?: unknown;
  evidenceRef?: string;
  /** How many fields the PII pass redacted. Reported, never silent. */
  piiMasked?: number;
  /** Set when the tool ran fine but has nothing to say, and why. */
  unavailable?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  /** JSON Schema for the model. Hand-written rather than generated: the
   *  descriptions here are prompt surface, and a generator would drop them. */
  inputSchema: Record<string, unknown>;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

// Every date-scoped tool takes the same optional window, so two tools in one
// answer cannot silently describe different periods.
const rangeArgs = z.object({ from: z.string().optional(), to: z.string().optional() }).strict();
const RANGE_JSON = {
  type: "object",
  properties: {
    from: { type: "string", description: "Start date, YYYY-MM-DD. Omit for month-to-date." },
    to: { type: "string", description: "End date, YYYY-MM-DD. Omit for month-to-date." },
  },
  additionalProperties: false,
};

function rangeOf(ctx: ToolContext, args: { from?: string; to?: string }): ResolvedRange {
  return resolveDateRange(args.from && args.to ? { from: args.from, to: args.to } : {}, new Date(), ctx.timeZone);
}

/** Wrap a calc result into the §19 envelope, masking on the way out. */
function envelope(data: unknown, opts: { dataStatus?: unknown; evidenceRef?: string; unavailable?: string } = {}): ToolResult {
  const { value, masked } = maskPii(data);
  return { data: value, ...opts, ...(masked > 0 ? { piiMasked: masked } : {}) };
}

const tool = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  schema: z.ZodType,
  run: ToolDefinition["run"]
): ToolDefinition => ({ name, description, inputSchema, schema, run });

export const TOOLS: ToolDefinition[] = [
  tool(
    "get_revenue_summary",
    "Net revenue (§11) for a period, with the prior-period comparison and order count. Use for 'how much did we make'.",
    RANGE_JSON,
    rangeArgs,
    async (ctx, args) => {
      const range = rangeOf(ctx, args as never);
      const [data, statuses] = await Promise.all([
        getNetRevenueSummary(ctx.organizationId, range),
        getDataStatusMap(ctx.organizationId),
      ]);
      return envelope(data, { dataStatus: statuses.revenue, evidenceRef: "/evidence/revenue" });
    }
  ),

  tool(
    "get_sales_summary",
    "Gross sales, order count, AOV, discount rate and refund rate (§5, §12, §64, §66) for a period.",
    RANGE_JSON,
    rangeArgs,
    async (ctx, args) => envelope(await getSalesSummary(ctx.organizationId, rangeOf(ctx, args as never)), { evidenceRef: "/revenue" })
  ),

  tool(
    "get_cash_received",
    "Cash actually credited to the bank in a period (§44). Different from revenue: this is money that arrived.",
    RANGE_JSON,
    rangeArgs,
    async (ctx, args) => envelope(await getCashReceivedSummary(ctx.organizationId, rangeOf(ctx, args as never)), { evidenceRef: "/evidence/cash_received" })
  ),

  tool(
    "get_available_cash",
    "Current bank balance across connected accounts (§54). Point-in-time — it ignores any date range.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}).strict(),
    async (ctx) => {
      // No dataStatus. The §28 map has no available_cash entry, and borrowing
      // cash_received's would attach a confident label to a different metric —
      // available cash depends on a founder-entered opening balance that
      // cash_received's status says nothing about. The summary carries its own
      // missingOpeningBalance list, which is the honest signal here.
      return envelope(await getAvailableCashSummary(ctx.organizationId), { evidenceRef: "/cash-flow" });
    }
  ),

  tool(
    "get_contribution_margin",
    "The CM0–CM3 contribution ladder (§37) with per-layer coverage. Use for any margin or profitability question.",
    RANGE_JSON,
    rangeArgs,
    async (ctx, args) => {
      const [data, statuses] = await Promise.all([
        getContributionMargin(ctx.organizationId, rangeOf(ctx, args as never)),
        getDataStatusMap(ctx.organizationId),
      ]);
      return envelope(data, { dataStatus: statuses.contribution_margin, evidenceRef: "/evidence/contribution_margin" });
    }
  ),

  tool(
    "get_product_profitability",
    "Per-SKU revenue and margin (§40). Use for 'which products make money' and 'what is losing money'.",
    {
      type: "object",
      properties: { ...RANGE_JSON.properties, limit: { type: "number", description: "How many SKUs to return, 1–50. Default 20." } },
      additionalProperties: false,
    },
    rangeArgs.extend({ limit: z.number().optional() }),
    async (ctx, args) => {
      const a = args as { from?: string; to?: string; limit?: number };
      const all = await getProductProfitability(ctx.organizationId, rangeOf(ctx, a));
      const limit = Math.min(Math.max(Math.floor(a.limit ?? 20), 1), 50);
      // The calc already returns ranked slices rather than the whole
      // catalogue. Re-slicing here to the model's requested limit, and saying
      // how many SKUs exist in total — an answer built on the top 20 of 741
      // that claims to describe the catalogue is wrong, and the model can only
      // know to say so if it is told.
      return envelope(
        {
          ...all,
          topByMargin: all.topByMargin.slice(0, limit),
          bottomByMargin: all.bottomByMargin.slice(0, limit),
          topByRevenue: all.topByRevenue.slice(0, limit),
          truncatedTo: limit,
          totalSkuCount: all.skuCount,
        },
        { dataStatus: (await getDataStatusMap(ctx.organizationId)).product_profitability, evidenceRef: "/evidence/product_profitability" }
      );
    }
  ),

  tool(
    "get_cash_forecast",
    "Projected daily cash balance over 7, 30 or 90 days (§16), with the lowest point and any cash-shortage date.",
    {
      type: "object",
      properties: { horizon: { type: "number", enum: [7, 30, 90], description: "Days to project. Default 30." } },
      additionalProperties: false,
    },
    z.object({ horizon: z.number().optional() }).strict(),
    async (ctx, args) => {
      const requested = (args as { horizon?: number }).horizon;
      const horizon = isForecastHorizon(requested) ? requested : DEFAULT_HORIZON;
      const [data, statuses] = await Promise.all([
        getCashForecast(ctx.organizationId, ctx.timeZone, new Date(), horizon),
        getDataStatusMap(ctx.organizationId),
      ]);
      return envelope(data, { dataStatus: statuses.cash_forecast, evidenceRef: "/evidence/cash_forecast" });
    }
  ),

  tool(
    "run_forecast_scenario",
    "Re-run the cash forecast under changed assumptions (§16). Deterministic — it changes nothing and saves nothing.",
    {
      type: "object",
      properties: {
        horizon: { type: "number", enum: [7, 30, 90] },
        growthDeltaPct: { type: "number", description: "Order growth up/down, %. Applies only to orders not yet placed." },
        adSpendDeltaPct: { type: "number" },
        rtoDeltaPct: { type: "number", description: "Percentage POINTS of RTO change." },
        collectionAccelDays: { type: "number", description: "Collect receivables this many days sooner." },
        vendorPaymentDelayDays: { type: "number" },
        inventoryPurchase: {
          type: "object",
          properties: { amountPaise: { type: "string" }, date: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    z
      .object({
        horizon: z.number().optional(),
        growthDeltaPct: z.number().optional(),
        adSpendDeltaPct: z.number().optional(),
        rtoDeltaPct: z.number().optional(),
        collectionAccelDays: z.number().optional(),
        vendorPaymentDelayDays: z.number().optional(),
        inventoryPurchase: z.object({ amountPaise: z.string(), date: z.string() }).optional(),
      })
      .strict(),
    async (ctx, args) => {
      const { horizon: requested, ...params } = args as { horizon?: number } & ScenarioParams;
      const horizon = isForecastHorizon(requested) ? requested : DEFAULT_HORIZON;
      const { base, scenario } = await runCashScenario(ctx.organizationId, params as ScenarioParams, ctx.timeZone, horizon);
      // Both lines, because a scenario without its base is a number with
      // nothing to compare against — and the comparison is the answer.
      return envelope({ base, scenario }, { evidenceRef: "/evidence/cash_forecast" });
    }
  ),

  tool(
    "get_burn_and_runway",
    "Monthly net burn and months of runway (§85). Runway is null when the business is not burning — that is a real answer, not a missing one.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}).strict(),
    async (ctx) => envelope(await getBurnAndRunway(ctx.organizationId), { evidenceRef: "/cash-flow" })
  ),

  tool(
    "get_payables",
    "Outstanding vendor bills with ageing buckets and what falls due in the next 7 days.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}).strict(),
    async (ctx) => envelope(await getPayablesSummary(ctx.organizationId), { evidenceRef: "/expenses" })
  ),

  tool(
    "get_ad_spend_analysis",
    "Ad spend by platform plus ROAS and blended CAC (§31). INR only — a USD-billed account is excluded and reported.",
    RANGE_JSON,
    rangeArgs,
    async (ctx, args) => {
      const range = rangeOf(ctx, args as never);
      const [spend, efficiency] = await Promise.all([
        getAdSpendSummary(ctx.organizationId, range),
        getAdEfficiencySummary(ctx.organizationId, range),
      ]);
      return envelope({ spend, efficiency }, { evidenceRef: "/expenses" });
    }
  ),

  tool(
    "get_rto_analysis",
    "RTO rate over a period (§18) — how much COD is coming back undelivered.",
    RANGE_JSON,
    rangeArgs,
    async (ctx, args) => envelope(await getRtoRateSummary(ctx.organizationId, rangeOf(ctx, args as never)), { evidenceRef: "/reconciliation" })
  ),

  tool(
    "get_cod_exposure",
    "COD money in flight, delivered but unremitted, gone dark, and returned (§51). Use for 'where is my COD cash'.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}).strict(),
    async (ctx) => {
      const e = await getCodExposure(ctx.organizationId);
      // BigInt cannot cross a JSON boundary and money never crosses one as a
      // number, so every figure is stringified here rather than at the edge.
      return envelope(
        {
          ...e,
          inFlightValue: e.inFlightValue.toString(),
          unknownValue: e.unknownValue.toString(),
          onlineDepositsValue: e.onlineDepositsValue.toString(),
          deliveredValue: e.deliveredValue.toString(),
          rtoValue: e.rtoValue.toString(),
        },
        { evidenceRef: "/settlements" }
      );
    }
  ),

  tool(
    "get_reconciliation_exceptions",
    "The six reconciliation legs (§15): how much of each is matched, how much needs review, and which legs cannot run and why.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}).strict(),
    async (ctx) => {
      const legs = await readReconciliationLegs(ctx.organizationId);
      return envelope(
        legs.map((l) => ({ ...l, matchedValue: l.matchedValue.toString(), unmatchedValue: l.unmatchedValue.toString() })),
        { evidenceRef: "/reconciliation" }
      );
    }
  ),

  tool(
    "get_anomalies",
    "Open anomalies found by the §17 rule engine, with what was observed against what was expected.",
    {
      type: "object",
      properties: { rerun: { type: "boolean", description: "Re-run detection now instead of reading stored findings." } },
      additionalProperties: false,
    },
    z.object({ rerun: z.boolean().optional() }).strict(),
    async (ctx, args) => {
      if ((args as { rerun?: boolean }).rerun) await runAnomalyRules(ctx.organizationId);
      const rows = await prisma.anomaly.findMany({
        where: { organizationId: ctx.organizationId, status: "OPEN" },
        orderBy: [{ severity: "desc" }, { periodEnd: "desc" }],
        take: 25,
        select: {
          id: true, type: true, severity: true, observedValue: true, expectedValue: true,
          difference: true, recommendedInvestigation: true, periodStart: true, periodEnd: true,
        },
      });
      return envelope(rows, { evidenceRef: "/exceptions" });
    }
  ),

  tool(
    "get_settlement_summary",
    "Provider payouts that landed in a period (§15): net settled, fees, GST on fees, split by provider and payout kind. Use for 'what did Razorpay actually pay me'.",
    RANGE_JSON,
    rangeArgs,
    async (ctx, args) =>
      envelope(await getSettlementSummary(ctx.organizationId, rangeOf(ctx, args as never)), { evidenceRef: "/settlements" })
  ),

  tool(
    "get_pending_settlements",
    "Captured payments the gateway has not yet paid out — the float it is holding, and how old the oldest is. Point-in-time.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}).strict(),
    async (ctx) => {
      const data = await getPendingSettlements(ctx.organizationId);
      return envelope(data, {
        evidenceRef: "/settlements",
        ...(data.unavailableReason ? { unavailable: data.unavailableReason } : {}),
      });
    }
  ),

  tool(
    "get_bank_movement",
    "Money in and out of the connected bank accounts over a period (§12.9): credits, debits and the net. This is the statement, not derived cash.",
    RANGE_JSON,
    rangeArgs,
    async (ctx, args) => {
      const data = await getBankMovement(ctx.organizationId, rangeOf(ctx, args as never));
      return envelope(data, {
        evidenceRef: "/cash-flow",
        ...(data.unavailableReason ? { unavailable: data.unavailableReason } : {}),
      });
    }
  ),

  tool(
    "get_refund_analysis",
    "Dated refund transactions in a period (§66), split by gateway, plus how many orders claim a refunded amount with no transaction behind it.",
    RANGE_JSON,
    rangeArgs,
    async (ctx, args) =>
      envelope(await getRefundAnalysis(ctx.organizationId, rangeOf(ctx, args as never)), { evidenceRef: "/reconciliation" })
  ),

  tool(
    "get_evidence",
    "The §21 evidence envelope for one material metric: its definition, the exact formula and version, the sources, the reconciliation status and up to 20 underlying rows. Use when asked to show the workings.",
    {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: [...EVIDENCE_ENVELOPE_METRICS],
          description: "Which material metric to open the workings for.",
        },
        from: { type: "string", description: "Start date, YYYY-MM-DD. Omit for month-to-date." },
        to: { type: "string", description: "End date, YYYY-MM-DD. Omit for month-to-date." },
      },
      required: ["metric"],
      additionalProperties: false,
    },
    z.object({ metric: z.enum(EVIDENCE_ENVELOPE_METRICS), from: z.string().optional(), to: z.string().optional() }).strict(),
    async (ctx, args) => {
      const a = args as { metric: (typeof EVIDENCE_ENVELOPE_METRICS)[number]; from?: string; to?: string };
      const { envelope: built } = await buildEvidence(ctx.organizationId, ctx.timeZone, a.metric, rangeOf(ctx, a), false);
      // sampleTransactions carry customer-shaped columns on some metrics, so
      // this is exactly the payload §27's masking exists for. envelope() runs
      // it; nothing here bypasses that.
      return envelope(built, { evidenceRef: `/evidence/${a.metric}` });
    }
  ),

  tool(
    "get_data_freshness",
    "When each connected source last synced, and which are stale or erroring. Use this before trusting any other figure.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}).strict(),
    async (ctx) => envelope(await getDataFreshness(ctx.organizationId), { evidenceRef: "/connections" })
  ),

  tool(
    "get_data_status",
    "The §28 honesty label (estimated / provisional / reconciled) for every material metric, with the reason.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}).strict(),
    async (ctx) => envelope(await getDataStatusMap(ctx.organizationId))
  ),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Run one tool call.
 *
 * Validation failures are RESULTS, not exceptions. A model that passes a bad
 * argument should be told what was wrong and get another turn — throwing would
 * abort a run over a fixable mistake. An unknown tool name is the same: it is
 * reported back rather than crashing, because it is also the signature of a
 * model trying to reach outside its permitted surface, and that belongs in the
 * audit trail rather than in a stack trace.
 */
export async function executeTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown
): Promise<{ ok: boolean; result: ToolResult | { error: string }; durationMs: number }> {
  const started = Date.now();
  const def = TOOLS_BY_NAME.get(name);
  if (!def) {
    return {
      ok: false,
      result: { error: `No tool named "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}.` },
      durationMs: Date.now() - started,
    };
  }

  const parsed = def.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      result: { error: `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` },
      durationMs: Date.now() - started,
    };
  }

  try {
    const result = await def.run(ctx, parsed.data as Record<string, unknown>);
    return { ok: true, result, durationMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      result: { error: err instanceof Error ? err.message : String(err) },
      durationMs: Date.now() - started,
    };
  }
}
