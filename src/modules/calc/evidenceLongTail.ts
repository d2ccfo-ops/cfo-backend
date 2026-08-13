import type { ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { getCampaignProfitability } from "./campaigns.js";
import { getCashConversionCycle } from "./cashCycle.js";
import { getChannelProfitability } from "./channels.js";
import { getStateProfitability } from "./geography.js";
import { getInventoryValueSummary } from "./inventory.js";
import { paiseToRupees } from "./money.js";

// P6.8 — the long tail of §21 evidence.
//
// P0.3 built the envelope for the five material metrics and deliberately
// stopped there: a bespoke drill-down for every endpoint would have blown that
// budget. Everything else has since been shipping figures with no "show me the
// workings" behind them.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT THE SAME ENVELOPE
// ---------------------------------------------------------------------------
// The material five carry a reconciliationStatus — an independent third party
// (a bank statement, a gateway payout) agrees or does not. None of these do.
// State profitability cannot be reconciled against anything; there is no
// external record of "Maharashtra's margin" to check it against.
//
// Reporting `reconciliationStatus: "verified"` on a metric with nothing to
// verify against would be the most damaging kind of lie this product could
// tell, because it is the field a reader trusts INSTEAD of checking. So these
// envelopes state `NOT_RECONCILABLE` with the reason, which is a different
// claim from "reconciled" and from "failed reconciliation".
//
// What they DO carry is the rest of it: the definition, the formula and its
// version, the sources, the underlying rows, and the warnings the calc module
// itself raised. That is enough to answer "where did this come from" — which
// is the question, and the reason 11 of 17 AI citations used to 404.

export const LONG_TAIL_METRIC_KEYS = [
  "state_profitability",
  "channel_profitability",
  "campaign_profitability",
  "cash_conversion_cycle",
  "inventory_value",
] as const;

export type LongTailMetricKey = (typeof LONG_TAIL_METRIC_KEYS)[number];

export function isLongTailMetric(key: string): key is LongTailMetricKey {
  return (LONG_TAIL_METRIC_KEYS as readonly string[]).includes(key);
}

export interface LongTailEvidence {
  metric: LongTailMetricKey;
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
  csvRows: Array<Record<string, string | number | null>>;
}

const TEXT: Record<LongTailMetricKey, { definition: string; formula: string; providers: string[] }> = {
  state_profitability: {
    definition:
      "Per-state order volume, net revenue and RTO rate (§14). The shipping state is derived at read time from the raw order payload — it is not a stored column, because promoting a customer address to an indexed field would spread it across every backup and replica for the sake of a chart (§27).",
    formula: "per state: Σ (gross − tax − refunds) on non-cancelled orders; RTO rate = RTO shipments ÷ orders, suppressed below 20 orders",
    providers: ["SHOPIFY", "AMAZON", "FLIPKART", "SHIPROCKET", "BLUEDART", "DELHIVERY"],
  },
  channel_profitability: {
    definition:
      "Contribution after product cost, shipping and transaction fees, per sales channel (§14, §20.3). Stops at CM2 because advertising cannot be attributed to a channel — that spend is reported as an unallocated pool rather than spread by revenue share.",
    formula: "per channel: CM2 = net revenue − COGS − freight − payment fees. Ad spend is NOT allocated unless a campaign states its channel.",
    providers: ["SHOPIFY", "AMAZON", "FLIPKART", "META_ADS", "GOOGLE_ADS"],
  },
  campaign_profitability: {
    definition:
      "Ad spend by campaign (§14). Spend is the platform's billing record and is treated as measured. Conversions and attributed revenue are the platform's own attribution claims — Meta and Google both count the same purchase — and are never summed into revenue.",
    formula: "per campaign: Σ spend; CPC = spend ÷ clicks; platform ROAS = platform-attributed revenue ÷ spend (the platform's number, quoted)",
    providers: ["META_ADS", "GOOGLE_ADS"],
  },
  cash_conversion_cycle: {
    definition:
      "Days between paying for stock and collecting the cash from selling it (§14). Reported as null when any of its three terms cannot be measured — a partial cycle is not a shorter cycle.",
    formula: "CCC = DIO + DSO − DPO",
    providers: ["SHOPIFY", "BANK", "ZOHO_BOOKS"],
  },
  inventory_value: {
    definition:
      "Stock on hand valued at its SELLING price (§14) — what the inventory would fetch, not what it cost. A landed-cost total is reported alongside it and is what any ratio against COGS uses; see calc/cashCycle.ts. This text previously claimed landed cost, describing behaviour the code did not have, so a reader checking the definition was told the DIO unit mismatch was not there. Variants carrying implausible placeholder quantities are excluded from the headline and counted separately, because one Shopify variant at 1,000,000 units once valued this brand's stock at ₹2,274 crore.",
    formula: "Σ (variant inventoryQuantity × variant price), excluding variants above the implausibility bound",
    providers: ["SHOPIFY"],
  },
};

async function sources(organizationId: string, metric: LongTailMetricKey) {
  const connections = await prisma.connection.findMany({
    where: { organizationId, status: "ACTIVE" },
    select: { provider: true, lastSyncedAt: true },
  });
  return connections
    .filter((c) => TEXT[metric].providers.includes(c.provider))
    .map((c) => ({
      label: c.provider,
      detail: c.lastSyncedAt ? `last synced ${c.lastSyncedAt.toISOString()}` : "never synced",
    }));
}

/**
 * Why this metric has no reconciliation status, stated per metric.
 *
 * A single generic "not applicable" would be true and useless. Each of these
 * names the specific third party that does not exist.
 */
const NOT_RECONCILABLE: Record<LongTailMetricKey, string> = {
  state_profitability:
    "No external record states a state's revenue, so there is nothing to reconcile against. The orders behind it reconcile individually through the §15 chain.",
  channel_profitability:
    "No third party reports a channel's contribution margin. The revenue and fee components reconcile individually; the aggregate does not.",
  campaign_profitability:
    "Ad spend reconciles against the platform invoice, which is not ingested. Platform-attributed revenue is unreconcilable by construction — it is a model output, not a transaction.",
  cash_conversion_cycle:
    "A derived ratio of three measured quantities. Reconciling it would mean reconciling DIO, DSO and DPO separately, which the inventory, receivables and payables evidence already do.",
  inventory_value:
    "No stock count has been ingested. This is Shopify's stated quantity at our stated cost, and only a physical count could verify it.",
};

export async function buildLongTailEvidence(
  organizationId: string,
  metric: LongTailMetricKey,
  range: ResolvedRange,
  rowLimit: number
): Promise<LongTailEvidence> {
  const text = TEXT[metric];
  const base = {
    metric,
    definition: text.definition,
    formula: text.formula,
    sources: await sources(organizationId, metric),
    reconciliationStatus: { status: "NOT_RECONCILABLE", reasons: [NOT_RECONCILABLE[metric]] },
    period: { from: range.from.toISOString(), to: range.to.toISOString(), periodFiltered: true },
  };

  switch (metric) {
    case "state_profitability": {
      const data = await getStateProfitability(organizationId, range, null, rowLimit);
      const rows = data.states.map((s) => ({
        state: s.state,
        orders: s.orders,
        netRevenueRupees: s.netRevenue,
        aovRupees: s.aov,
        rtoOrders: s.rtoOrders,
        rtoRatePct: s.rtoRatePct,
        codSharePct: s.codSharePct,
      }));
      return {
        ...base,
        formulaVersion: data.formulaVersion,
        sampleTransactions: rows.slice(0, 20),
        transactionCount: data.states.length,
        completeness: `${data.coveragePct}% of orders carry a shipping state; ${data.unattributedOrders} excluded entirely`,
        warnings: data.warnings,
        csvRows: rows,
      };
    }

    case "channel_profitability": {
      const data = await getChannelProfitability(organizationId, range);
      const rows = data.channels.map((c) => ({
        channel: c.channel,
        orders: c.orders,
        netRevenueRupees: c.netRevenue,
        cogsRupees: c.cogs,
        shippingRupees: c.shipping,
        transactionFeesRupees: c.transactionFees,
        cm2Rupees: c.cm2,
        cm2Pct: c.cm2Pct,
        allocatedAdSpendRupees: c.allocatedAdSpend,
        uncostedLines: c.uncostedLines,
      }));
      return {
        ...base,
        formulaVersion: data.formulaVersion,
        sampleTransactions: rows.slice(0, 20),
        transactionCount: data.channels.length,
        // The unallocated pool belongs in completeness, not a footnote: it is
        // the single biggest reason this table is not a full P&L split.
        completeness: `${data.channels.length} channels; ₹${data.unallocatedAdSpend.toLocaleString("en-IN")} of ad spend deliberately unallocated`,
        warnings: data.warnings,
        csvRows: rows,
      };
    }

    case "campaign_profitability": {
      const data = await getCampaignProfitability(organizationId, range, rowLimit);
      const rows = data.campaigns.map((c) => ({
        campaignId: c.campaignId,
        campaignName: c.campaignName,
        provider: c.provider,
        channel: c.channel,
        spendRupees: c.spend,
        spendSharePct: c.spendSharePct,
        clicks: c.clicks,
        cpcRupees: c.cpc,
        // Prefixed so a column read out of context cannot be mistaken for
        // this product's own revenue figure.
        platformClaimedConversions: c.platformConversions,
        platformClaimedRevenueRupees: c.platformAttributedRevenue,
        platformClaimedRoas: c.platformRoas,
      }));
      return {
        ...base,
        formulaVersion: data.formulaVersion,
        sampleTransactions: rows.slice(0, 20),
        transactionCount: data.campaigns.length,
        completeness: data.hasSource
          ? `campaign rows account for ${data.coveragePct}% of recorded ad spend`
          : "no campaign-grain data — ad spend is pulled at account-day grain only",
        warnings: data.warnings,
        csvRows: rows,
      };
    }

    case "cash_conversion_cycle": {
      const data = await getCashConversionCycle(organizationId, range);
      // One row per TERM rather than one flattened row. A reader challenging
      // "your cash cycle is 84 days" is really challenging one of DIO, DSO or
      // DPO, and each term already carries its own numerator, denominator and
      // — when it could not be measured — the reason. Flattening would throw
      // away exactly the part being questioned.
      const rows = data.terms.map((t) => ({
        term: t.key.toUpperCase(),
        label: t.label,
        days: t.days,
        numerator: t.numerator,
        denominator: t.denominator,
        notMeasurableReason: t.reason,
      })) as Array<Record<string, string | number | null>>;
      return {
        ...base,
        formulaVersion: data.formulaVersion,
        sampleTransactions: rows,
        transactionCount: rows.length,
        completeness:
          data.cycleDays === null
            ? `not measurable — ${data.terms.filter((t) => t.days === null).map((t) => t.key.toUpperCase()).join(", ")} could not be computed`
            : `all three terms measured; ${data.coverage.cogsLinePct}% COGS line coverage, ${data.coverage.receiptPct}% receipt coverage`,
        warnings: data.warnings,
        csvRows: rows,
      };
    }

    case "inventory_value": {
      const data = await getInventoryValueSummary(organizationId);
      const rows = [
        {
          valuedAtLandedCostRupees: paiseToRupees(BigInt(data.valueMinor)),
          allVariantsValueRupees: paiseToRupees(BigInt(data.allVariantsValueMinor)),
          excludedVariantCount: data.excludedVariantCount,
          excludedUnits: data.excludedUnits,
        } as Record<string, string | number | null>,
      ];
      return {
        ...base,
        formulaVersion: data.formulaVersion,
        // Inventory is a CURRENT-STATE reading, not a period aggregate —
        // Shopify only ever states today's stock level. Saying the period was
        // filtered would be false.
        period: { ...base.period, periodFiltered: false },
        sampleTransactions: rows,
        transactionCount: 1,
        completeness: `${data.excludedVariantCount} variants excluded as implausible (${data.excludedUnits.toLocaleString("en-IN")} units)`,
        warnings: data.warnings,
        csvRows: rows,
      };
    }
  }
}
