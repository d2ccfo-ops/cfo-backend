import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { withDateRange, type ResolvedRange } from "../lib/dateRange.js";
import { requireAuth } from "../middleware/auth.js";
import { getRevenueLadder } from "../modules/calc/revenueLadder.js";
import { getContributionMargin } from "../modules/calc/contribution.js";
import { getProductProfitability } from "../modules/calc/productProfitability.js";
import { getCashReceivedSummary } from "../modules/calc/cash.js";
import { getCashForecast } from "../modules/calc/cashForecast.js";
import { getDataStatusMap, type MaterialMetricKey } from "../modules/calc/dataStatus.js";
import { paiseToRupees } from "../modules/calc/money.js";
import { buildLongTailEvidence, isLongTailMetric, LONG_TAIL_METRIC_KEYS } from "../modules/calc/evidenceLongTail.js";

// §21 evidence. One envelope for the 5 material metrics — every figure a
// founder might be challenged on can answer "show me the workings" with its
// definition, formula, sources, verification status and the underlying rows.
//
// Scope guard (per IMPLEMENTATION_PLAN P0.3): these five only. A bespoke
// drill-down for each of the 18 metric endpoints would blow the P0 budget;
// the long tail is P6.8.
//
// The numbers here are NOT recomputed independently — each handler calls the
// same calc module the metric endpoint serves, so the evidence can never
// disagree with the card it explains. §106 still holds: deterministic code
// calculates; this route only presents.

export const evidenceRouter = Router();

const SAMPLE_LIMIT = 20;
const CSV_ROW_LIMIT = 50_000;

interface EvidenceEnvelope {
  metric: MaterialMetricKey;
  definition: string;
  formula: string;
  formulaVersion: string;
  period: { from: string; to: string; periodFiltered: boolean };
  sources: Array<{ label: string; detail: string }>;
  sampleTransactions: Array<Record<string, string | number | null>>;
  transactionCount: number;
  completeness: string;
  reconciliationStatus: { status: string; reasons: string[] };
  warnings: string[];
}

// Definitions and formulas are stated here in spec terms because this is the
// backend's own account of what it computed — not a UI caption. The formula
// VERSION comes off the calc output, never retyped.
const METRIC_TEXT: Record<MaterialMetricKey, { definition: string; formula: string }> = {
  revenue: {
    definition:
      "Net revenue (§11): tax-exclusive order value across sales channels, excluding cancelled orders, less discounts and the ex-GST portion of refunds.",
    formula: "GMV (ex GST) + shipping − discounts − cancellations − refunds (ex GST) — the §5–§11 ladder",
  },
  contribution_margin: {
    definition:
      "Layered contribution margin (§36): net revenue minus cost layers in order — CM0 after COGS, CM1 after fulfilment, CM2 after fees, CM3 after ads. Uncovered layers mark the levels below them unreliable rather than counting as zero.",
    formula: "CM0 = net revenue − COGS; CM1 = CM0 − fulfilment; CM2 = CM1 − fees; CM3 = CM2 − ad spend",
  },
  product_profitability: {
    definition:
      "Per-SKU profitability (§40): each SKU's net revenue against the cost snapshotted onto its order lines at ingestion (§19 date-effective costs). Stops at CM0 — per-SKU shipping/RTO/ads would need allocation inputs that don't exist.",
    formula: "per-SKU CM0 = Σ line net revenue − Σ line cogsAmount, only when every line of the SKU is costed",
  },
  cash_received: {
    definition:
      "Cash received (§55): the sum of CREDIT transactions on connected bank accounts in the window — money that actually arrived, not gateway promises.",
    formula: "Σ bank CREDIT amounts with valueDate inside the window",
  },
  cash_forecast: {
    definition:
      "Cash-flow forecast (§85): day-by-day projected balance for the next 30 days from today's measured opening balance, expected settlement/COD inflows and known outflows. A projection — never an accounting figure.",
    formula: "closing(day) = closing(day−1) + expected inflows(day) − expected outflows(day)",
  },
};

// Which ACTIVE connections feed each metric, so `sources` names real
// connections rather than a hardcoded provider list going stale.
const SOURCE_PROVIDERS: Record<MaterialMetricKey, string[]> = {
  revenue: ["SHOPIFY", "AMAZON", "FLIPKART"],
  contribution_margin: ["SHOPIFY", "AMAZON", "FLIPKART", "META_ADS", "GOOGLE_ADS"],
  product_profitability: ["SHOPIFY", "AMAZON", "FLIPKART"],
  cash_received: ["BANK", "SETU"],
  cash_forecast: ["BANK", "SETU", "RAZORPAY", "GOKWIK"],
};

async function connectionSources(organizationId: string, metric: MaterialMetricKey) {
  const connections = await prisma.connection.findMany({
    where: { organizationId, status: "ACTIVE" },
    select: { provider: true, lastSyncedAt: true },
  });
  const relevant = connections.filter((c) => SOURCE_PROVIDERS[metric].includes(c.provider));
  return relevant.map((c) => ({
    label: c.provider,
    detail: c.lastSyncedAt ? `last synced ${c.lastSyncedAt.toISOString()}` : "never synced",
  }));
}

const paiseCols = (minor: bigint) => ({ amountMinor: minor.toString(), amountRupees: paiseToRupees(minor) });

// ---------------------------------------------------------------------------
// Per-metric row readers — sample and CSV share ONE query shape each, so the
// drawer's sample rows and the export can't describe different populations.
// ---------------------------------------------------------------------------

async function revenueRows(organizationId: string, range: ResolvedRange, limit: number) {
  const where = { organizationId, placedAt: { gte: range.from, lte: range.to } };
  const [rows, count] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { placedAt: "desc" },
      take: limit,
      select: { orderNumber: true, placedAt: true, channel: true, status: true, grossAmount: true },
    }),
    prisma.order.count({ where }),
  ]);
  return {
    count,
    rows: rows.map((o) => ({
      orderNumber: o.orderNumber,
      placedAt: o.placedAt.toISOString(),
      channel: o.channel,
      status: o.status,
      ...paiseCols(o.grossAmount),
    })),
  };
}

async function marginRows(organizationId: string, range: ResolvedRange, limit: number) {
  const where = { order: { organizationId, placedAt: { gte: range.from, lte: range.to } } };
  const [rows, count] = await Promise.all([
    prisma.orderLineItem.findMany({
      where,
      orderBy: { order: { placedAt: "desc" } },
      take: limit,
      select: {
        sku: true,
        productName: true,
        quantity: true,
        totalAmount: true,
        cogsAmount: true,
        order: { select: { orderNumber: true, placedAt: true } },
      },
    }),
    prisma.orderLineItem.count({ where }),
  ]);
  return {
    count,
    rows: rows.map((l) => ({
      orderNumber: l.order.orderNumber,
      placedAt: l.order.placedAt.toISOString(),
      sku: l.sku,
      productName: l.productName,
      quantity: l.quantity,
      ...paiseCols(l.totalAmount),
      cogsMinor: l.cogsAmount?.toString() ?? null,
      cogsRupees: l.cogsAmount === null ? null : paiseToRupees(l.cogsAmount),
    })),
  };
}

async function cashReceivedRows(organizationId: string, range: ResolvedRange, limit: number) {
  const where = { organizationId, direction: "CREDIT" as const, valueDate: { gte: range.from, lte: range.to } };
  const [rows, count] = await Promise.all([
    prisma.bankTransaction.findMany({
      where,
      orderBy: { valueDate: "desc" },
      take: limit,
      select: { valueDate: true, amount: true, description: true, utr: true },
    }),
    prisma.bankTransaction.count({ where }),
  ]);
  return {
    count,
    rows: rows.map((t) => ({
      valueDate: t.valueDate.toISOString(),
      description: t.description,
      utr: t.utr,
      ...paiseCols(t.amount),
    })),
  };
}

// ---------------------------------------------------------------------------

type BuiltEvidence = { envelope: EvidenceEnvelope; csvRows: Array<Record<string, string | number | null>> };

export async function buildEvidence(
  organizationId: string,
  timezone: string,
  metric: MaterialMetricKey,
  range: ResolvedRange,
  wantCsv: boolean
): Promise<BuiltEvidence> {
  const statuses = await getDataStatusMap(organizationId);
  const text = METRIC_TEXT[metric];
  const base = {
    metric,
    definition: text.definition,
    formula: text.formula,
    reconciliationStatus: statuses[metric],
    sources: await connectionSources(organizationId, metric),
  };
  const period = (filtered: boolean) => ({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    periodFiltered: filtered,
  });
  const csvLimit = wantCsv ? CSV_ROW_LIMIT : SAMPLE_LIMIT;

  switch (metric) {
    case "revenue": {
      const [ladder, data] = await Promise.all([
        getRevenueLadder(organizationId, range),
        revenueRows(organizationId, range, csvLimit),
      ]);
      return {
        envelope: {
          ...base,
          formulaVersion: ladder.formulaVersion,
          period: period(true),
          sampleTransactions: data.rows.slice(0, SAMPLE_LIMIT),
          transactionCount: data.count,
          completeness: `${ladder.dataCompleteness}% of inputs present`,
          warnings: ladder.warnings ?? [],
        },
        csvRows: data.rows,
      };
    }
    case "contribution_margin": {
      const [margin, data] = await Promise.all([
        getContributionMargin(organizationId, range),
        marginRows(organizationId, range, csvLimit),
      ]);
      return {
        envelope: {
          ...base,
          formulaVersion: margin.formulaVersion,
          period: period(true),
          sampleTransactions: data.rows.slice(0, SAMPLE_LIMIT),
          transactionCount: data.count,
          completeness: `${margin.dataCompleteness}% of cost layers covered · ${margin.cogsCoverage.valueCoveragePct}% of line value costed`,
          warnings: margin.warnings ?? [],
        },
        csvRows: data.rows,
      };
    }
    case "product_profitability": {
      // limit=CSV_ROW_LIMIT makes topByRevenue the FULL per-SKU population in
      // revenue order — the calc's default 10 is a UI trim, not a data bound.
      const products = await getProductProfitability(organizationId, range, csvLimit);
      // The evidence rows ARE the per-SKU aggregation — that is the number on
      // screen. The line-level workings behind any one SKU are the margin CSV.
      const rows = products.topByRevenue.map((p: { sku: string; productName: string; units: number; netRevenue: number; cogs: number | null; cm0: number | null; cm0Pct: number | null; refundRatePct: number | null; costed: boolean }) => ({
        sku: p.sku,
        productName: p.productName,
        units: p.units,
        netRevenueRupees: p.netRevenue,
        cogsRupees: p.cogs,
        cm0Rupees: p.cm0,
        cm0Pct: p.cm0Pct,
        refundRatePct: p.refundRatePct,
        costed: p.costed ? "yes" : "no",
      }));
      return {
        envelope: {
          ...base,
          formulaVersion: products.formulaVersion,
          period: period(true),
          sampleTransactions: rows.slice(0, SAMPLE_LIMIT),
          // skuCount, not rows.length — on the JSON path the row list is
          // sample-trimmed and its length would understate the population.
          transactionCount: products.skuCount,
          completeness: `${products.costedSkuCount} of ${products.skuCount} SKUs fully costed`,
          warnings: products.warnings ?? [],
        },
        csvRows: rows,
      };
    }
    case "cash_received": {
      const [summary, data] = await Promise.all([
        getCashReceivedSummary(organizationId, range),
        cashReceivedRows(organizationId, range, csvLimit),
      ]);
      return {
        envelope: {
          ...base,
          formulaVersion: summary.formulaVersion,
          period: period(true),
          sampleTransactions: data.rows.slice(0, SAMPLE_LIMIT),
          transactionCount: data.count,
          completeness: `${data.count} credit transaction(s) on file in this window`,
          warnings: [],
        },
        csvRows: data.rows,
      };
    }
    case "cash_forecast": {
      const forecast = await getCashForecast(organizationId, timezone);
      const rows = forecast.days.map((d: { date: string; inflowMinor: string; outflowMinor: string; closingMinor: string }) => ({
        date: d.date,
        inflowMinor: d.inflowMinor,
        inflowRupees: paiseToRupees(BigInt(d.inflowMinor)),
        outflowMinor: d.outflowMinor,
        outflowRupees: paiseToRupees(BigInt(d.outflowMinor)),
        closingMinor: d.closingMinor,
        closingRupees: paiseToRupees(BigInt(d.closingMinor)),
      }));
      return {
        envelope: {
          ...base,
          formulaVersion: forecast.version,
          // Forward-looking: the date filter is deliberately ignored, same as
          // the /metrics/cash-forecast endpoint.
          period: { from: forecast.generatedAt, to: forecast.days.at(-1)?.date ?? forecast.generatedAt, periodFiltered: false },
          sampleTransactions: rows.slice(0, SAMPLE_LIMIT),
          transactionCount: rows.length,
          completeness: `reliability: ${forecast.reliability} — ${forecast.reliabilityNote}`,
          warnings: forecast.openingBalance.basis === "measured" ? [] : ["Opening balance is not measured — no bank connection has one set."],
        },
        csvRows: rows,
      };
    }
  }
}

export function toCsv(rows: Array<Record<string, string | number | null>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escape = (v: string | number | null) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h] ?? null)).join(","))].join("\n");
}

evidenceRouter.get("/:metricKey", ...requireAuth, withDateRange, async (req, res) => {
  const requested = req.params.metricKey ?? "";
  const wantCsv = req.query.format === "csv";

  // P6.8. The long tail is served from its own builder because these metrics
  // have no reconciliationStatus to report — nothing external states a state's
  // margin or a campaign's ROAS, so the envelope says NOT_RECONCILABLE with the
  // reason rather than borrowing a status that would be read as verification.
  if (isLongTailMetric(requested)) {
    const built = await buildLongTailEvidence(
      req.auth!.organizationId,
      requested,
      req.dateRange!,
      wantCsv ? CSV_ROW_LIMIT : SAMPLE_LIMIT
    );
    if (wantCsv) {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="evidence-${requested}.csv"`);
      res.send(toCsv(built.csvRows));
      return;
    }
    const { csvRows: _csvRows, ...envelope } = built;
    res.json(envelope);
    return;
  }

  const metric = requested as MaterialMetricKey;
  if (!(metric in METRIC_TEXT)) {
    res.status(404).json({
      // Both sets listed. A caller that guessed "inventory_value" and got back
      // only the material five would conclude the long tail does not exist.
      error: `No evidence endpoint for "${metric}". Available: ${[...Object.keys(METRIC_TEXT), ...LONG_TAIL_METRIC_KEYS].join(", ")}.`,
    });
    return;
  }
  const { envelope, csvRows } = await buildEvidence(
    req.auth!.organizationId,
    req.auth!.timezone,
    metric,
    req.dateRange!,
    wantCsv
  );

  if (wantCsv) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="evidence-${metric}.csv"`);
    if (csvRows.length >= CSV_ROW_LIMIT) {
      // Named, not silent — a truncated export that doesn't say so reads as
      // the whole population.
      res.setHeader("X-Truncated-At", String(CSV_ROW_LIMIT));
    }
    res.send(toCsv(csvRows));
    return;
  }
  res.json(envelope);
});
