import { MatchType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { readReconciliationLegs } from "./reconciliation.js";
import { getDataFreshness } from "./freshness.js";

// §28/§19 — the honesty layer. Every material figure the app shows carries one
// of three labels, computed here and nowhere else:
//
//   estimated   — the figure rests on a placeholder somewhere in its inputs
//                 (seeded costs, a projection). It is a shape, not a number.
//   provisional — every input is real data from a source system, but it has
//                 not been verified against an independent record.
//   reconciled  — verified against an independent record (gateway statement,
//                 bank credit) to at least RECONCILED_MIN_PCT by value.
//
// §42.8 is the governing rule: estimated data must NEVER be marked reconciled.
// The ladder only moves up as verification actually happens, and every label
// carries reasons[] saying exactly why it is where it is — the label without
// the why would just be a second number to distrust.

export const FORMULA_VERSION = "v1";

export type DataStatusLevel = "estimated" | "provisional" | "reconciled";

export interface MetricDataStatus {
  status: DataStatusLevel;
  reasons: string[];
}

export const MATERIAL_METRIC_KEYS = [
  "revenue",
  "contribution_margin",
  "product_profitability",
  "cash_received",
  "cash_forecast",
] as const;

export type MaterialMetricKey = (typeof MATERIAL_METRIC_KEYS)[number];

// "Reconciled" is claimed only when at least this share of VALUE is verified.
// 98 rather than 95: the label is a promise, and a promise with a 5% hole in
// it is the kind of rounding-up §42.8 exists to forbid.
export const RECONCILED_MIN_PCT = 98;

/**
 * Everything the ladder needs, as plain numbers — the DB wrapper below fills
 * this in; tests construct it directly.
 */
export interface DataStatusInputs {
  /** SKUs with any cost row (latest row per SKU). */
  costedSkuCount: number;
  /** Of those, SKUs whose LATEST cost row is a seeded ESTIMATED placeholder. */
  estimatedSkuCount: number;
  /** % of order line VALUE with a cost snapshot attached. */
  costedValuePct: number;
  /** % of order value matched to a gateway payment, null = leg unavailable. */
  orderPaymentMatchedPct: number | null;
  /** The leg's own stated blocker when it could not run — used verbatim. */
  orderPaymentBlockedReason: string | null;
  /** % of settlement value matched to a bank credit, null = leg unavailable. */
  settlementBankMatchedPct: number | null;
  settlementBankBlockedReason: string | null;
  /** Bank CREDIT transactions on file — the substrate of cash_received. */
  bankCreditCount: number;
  staleSourceCount: number;
  totalSourceCount: number;
}

const pctLabel = (v: number) => `${Math.round(v * 10) / 10}%`;

/**
 * Pure assembly — deterministic on its inputs, no clock, no DB. Exported so
 * the unit tests can drive it without a database.
 */
export function buildDataStatusMap(i: DataStatusInputs): Record<MaterialMetricKey, MetricDataStatus> {
  // A stale pipeline caps everything at provisional: a figure verified against
  // last week's statements says nothing about this week's money.
  const staleReason =
    i.staleSourceCount > 0
      ? `${i.staleSourceCount} of ${i.totalSourceCount} connected sources have not synced recently — recent activity may be missing.`
      : null;
  const capForStaleness = (s: MetricDataStatus): MetricDataStatus => {
    if (!staleReason) return s;
    return {
      status: s.status === "reconciled" ? "provisional" : s.status,
      reasons: [...s.reasons, staleReason],
    };
  };

  // --- revenue -------------------------------------------------------------
  // Synced order values are real data, so the floor is provisional, never
  // estimated. Reconciled means traced to gateway payments by value.
  let revenue: MetricDataStatus;
  if (i.orderPaymentMatchedPct === null) {
    revenue = {
      status: "provisional",
      reasons: [
        // The reconciliation leg states its own blocker more precisely than a
        // generic line here could — pass it through verbatim when it has one.
        i.orderPaymentBlockedReason ??
          "No gateway payment records to verify order values against — figures come from the sales channel alone.",
      ],
    };
  } else if (i.orderPaymentMatchedPct >= RECONCILED_MIN_PCT) {
    revenue = {
      status: "reconciled",
      reasons: [`${pctLabel(i.orderPaymentMatchedPct)} of order value is verified against gateway payment records.`],
    };
  } else {
    revenue = {
      status: "provisional",
      reasons: [
        `Only ${pctLabel(i.orderPaymentMatchedPct)} of order value is verified against a gateway payment — the rest rests on the sales channel's own records.`,
      ],
    };
  }
  revenue = capForStaleness(revenue);

  // --- margins (contribution_margin, product_profitability) ----------------
  // One rule decides everything: while ANY seeded placeholder cost
  // contributes, the margin is estimated, full stop. Real costs promote it to
  // the revenue side's status at best — a margin cannot be more verified than
  // the revenue it is computed from.
  let margin: MetricDataStatus;
  if (i.costedSkuCount === 0) {
    margin = {
      status: "estimated",
      reasons: ["No product costs are on file — no margin figure can rest on anything yet."],
    };
  } else if (i.estimatedSkuCount > 0) {
    margin = {
      status: "estimated",
      reasons: [
        `${i.estimatedSkuCount} of ${i.costedSkuCount} costed SKUs carry seeded placeholder costs — every margin figure is a fiction until real costs replace them.`,
      ],
    };
  } else if (i.costedValuePct < RECONCILED_MIN_PCT) {
    margin = {
      status: "provisional",
      reasons: [
        `Costs are real, but only ${pctLabel(i.costedValuePct)} of order line value has a cost attached — the uncosted share is excluded, not assumed zero.`,
      ],
    };
  } else {
    // Fully costed with real costs: inherit the revenue side's verdict.
    margin = { status: revenue.status, reasons: [...revenue.reasons, "Product costs are real and cover the order book."] };
  }
  margin = capForStaleness(margin);

  // --- cash_received -------------------------------------------------------
  // Built on bank CREDIT rows — real by construction, so again the floor is
  // provisional. Reconciled means the settlement↔bank leg ties the credits
  // back to gateway payouts.
  let cashReceived: MetricDataStatus;
  if (i.bankCreditCount === 0) {
    cashReceived = {
      status: "provisional",
      reasons: ["No bank statement is imported — there are no bank credits to show or verify."],
    };
  } else if (i.settlementBankMatchedPct === null) {
    cashReceived = {
      status: "provisional",
      reasons: [
        i.settlementBankBlockedReason ??
          "Bank credits are on file, but there are no gateway settlements to trace them back to.",
      ],
    };
  } else if (i.settlementBankMatchedPct >= RECONCILED_MIN_PCT) {
    cashReceived = {
      status: "reconciled",
      reasons: [`${pctLabel(i.settlementBankMatchedPct)} of settlement value is traced to a bank credit.`],
    };
  } else {
    cashReceived = {
      status: "provisional",
      reasons: [
        `Only ${pctLabel(i.settlementBankMatchedPct)} of settlement value is traced to a bank credit — the rest is reported by the gateway but unverified in the bank.`,
      ],
    };
  }
  cashReceived = capForStaleness(cashReceived);

  // --- cash_forecast -------------------------------------------------------
  // A projection is an estimate by definition. It never climbs the ladder —
  // §42.8 read forward: the future cannot be reconciled.
  const cashForecast: MetricDataStatus = {
    status: "estimated",
    reasons: ["A forward-looking projection from trailing patterns — not an accounting figure, and never marked reconciled."],
  };

  return {
    revenue,
    contribution_margin: margin,
    // Same substrate, same verdict — per-SKU CM0 is the margin cut by SKU.
    product_profitability: margin,
    cash_received: cashReceived,
    cash_forecast: cashForecast,
  };
}

// ---------------------------------------------------------------------------
// Leg-derived statuses for the reconciliation summary
// ---------------------------------------------------------------------------

type LegLike = {
  state: string;
  blockedReason?: string;
  matchedValue: bigint;
  unmatchedValue: bigint;
};

// COD figures are courier-reported until a remittance ties them to money in
// the bank; settlement figures are gateway-reported until a bank credit does
// the same. Both climb the same ladder, so one classifier serves both — only
// the words differ.
function legStatus(
  leg: LegLike | undefined,
  wording: { subject: string; verifier: string; fallback: string }
): MetricDataStatus {
  const pct = legMatchedPct(leg);
  if (pct === null) {
    return { status: "provisional", reasons: [leg?.blockedReason ?? wording.fallback] };
  }
  if (pct >= RECONCILED_MIN_PCT) {
    return { status: "reconciled", reasons: [`${pctLabel(pct)} of ${wording.subject} is traced to ${wording.verifier}.`] };
  }
  return {
    status: "provisional",
    reasons: [`Only ${pctLabel(pct)} of ${wording.subject} is traced to ${wording.verifier} — the rest is reported, not verified.`],
  };
}

export function buildCodDataStatus(leg: LegLike | undefined): MetricDataStatus {
  return legStatus(leg, {
    subject: "delivered COD value",
    verifier: "a courier remittance",
    fallback: "COD figures are courier-reported — no remittance statement verifies the money actually arrived.",
  });
}

export function buildSettlementDataStatus(leg: LegLike | undefined): MetricDataStatus {
  return legStatus(leg, {
    subject: "settlement value",
    verifier: "a bank credit",
    fallback: "Settlement figures are gateway-reported — no bank statement verifies the payouts landed.",
  });
}

// ---------------------------------------------------------------------------
// DB wrapper
// ---------------------------------------------------------------------------

const legMatchedPct = (leg: { state: string; matchedValue: bigint; unmatchedValue: bigint } | undefined): number | null => {
  if (!leg || leg.state !== "ran") return null;
  const eligible = leg.matchedValue + leg.unmatchedValue;
  if (eligible === 0n) return null;
  return Math.round((Number(leg.matchedValue) / Number(eligible)) * 1000) / 10;
};

/**
 * The statuses for all material metrics, from live data. Deliberately built on
 * cheap aggregates (not getCostCoverage's full line scan) so embedding it in
 * every material endpoint doesn't double their cost.
 */
export async function getDataStatusMap(organizationId: string): Promise<Record<MaterialMetricKey, MetricDataStatus>> {
  const [sourceRows, totalAgg, costedAgg, bankCreditCount, legs, freshness] = await Promise.all([
    // Latest cost row per SKU, grouped by source — the same DISTINCT ON the
    // Costs page's source split uses, so the two can't disagree.
    prisma.$queryRaw<Array<{ source: string; count: number }>>`
      SELECT source, count(*)::int AS count FROM (
        SELECT DISTINCT ON (sku) sku, source
        FROM product_costs
        WHERE "organizationId" = ${organizationId}
        ORDER BY sku, "effectiveFrom" DESC
      ) latest
      GROUP BY source`,
    prisma.orderLineItem.aggregate({
      where: { order: { organizationId } },
      _sum: { totalAmount: true },
    }),
    prisma.orderLineItem.aggregate({
      where: { order: { organizationId }, cogsAmount: { not: null } },
      _sum: { totalAmount: true },
    }),
    prisma.bankTransaction.count({ where: { organizationId, direction: "CREDIT" } }),
    readReconciliationLegs(organizationId),
    getDataFreshness(organizationId),
  ]);

  const totalValue = totalAgg._sum.totalAmount ?? 0n;
  const costedValue = costedAgg._sum.totalAmount ?? 0n;
  const orderPaymentLeg = legs.find((l) => l.matchType === MatchType.ORDER_PAYMENT);
  const settlementBankLeg = legs.find((l) => l.matchType === MatchType.SETTLEMENT_BANK);

  return buildDataStatusMap({
    costedSkuCount: sourceRows.reduce((n, r) => n + r.count, 0),
    estimatedSkuCount: sourceRows.find((r) => r.source === "ESTIMATED")?.count ?? 0,
    costedValuePct: totalValue === 0n ? 0 : Math.round((Number(costedValue) / Number(totalValue)) * 1000) / 10,
    orderPaymentMatchedPct: legMatchedPct(orderPaymentLeg),
    orderPaymentBlockedReason: orderPaymentLeg?.blockedReason ?? null,
    settlementBankMatchedPct: legMatchedPct(settlementBankLeg),
    settlementBankBlockedReason: settlementBankLeg?.blockedReason ?? null,
    bankCreditCount,
    staleSourceCount: freshness.staleSources,
    totalSourceCount: freshness.totalSources,
  });
}
