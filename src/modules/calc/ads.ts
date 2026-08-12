import { resolveDateRange, shouldPersistSnapshot, type ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { paiseToRupees, sumPaise } from "./money.js";
import { getNetRevenueSummary } from "./revenue.js";
import type { Provider } from "@prisma/client";

// Ad spend and the two ratios founders actually steer on: ROAS (revenue per
// rupee of ad spend) and blended CAC (ad spend per order). Both are built on
// AdSpend, which Meta Ads and Google Ads both write into — the `provider`
// column is what separates them, so one query covers both platforms and
// "blended" is the natural default rather than a special case.
//
// Same rule as every other module here: the arithmetic lives in the calc
// engine, never in a route handler and never in the AI layer.

const FORMULA_VERSION = "v1";

const AD_PROVIDERS: Provider[] = ["META_ADS", "GOOGLE_ADS"];

interface SpendRow {
  provider: Provider;
  spendAmount: bigint;
  currency: string;
  impressions: number | null;
  clicks: number | null;
}

// Ad platforms report spend in each ad account's own billing currency (see
// modules/connectors/metaAds and googleAds — an Indian advertiser can run a
// USD-billed account). Adding a USD row to an INR row would produce a
// confident, meaningless number, so totals are only ever computed within a
// single currency. Mixed currencies return a per-currency breakdown and a
// null total instead of a wrong one — converting would need an FX rate for
// the correct historical date, which nothing in this system has.
function totalise(rows: SpendRow[]) {
  const byCurrency = new Map<string, bigint>();
  for (const row of rows) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0n) + row.spendAmount);
  }
  const currencies = [...byCurrency.keys()].sort();
  const mixedCurrency = currencies.length > 1;
  return {
    mixedCurrency,
    currency: mixedCurrency ? null : (currencies[0] ?? "INR"),
    total: mixedCurrency ? null : sumPaise(rows.map((r) => r.spendAmount)),
    byCurrency: Object.fromEntries([...byCurrency].map(([c, v]) => [c, v.toString()])),
  };
}

async function fetchSpend(organizationId: string, gte: Date, lte: Date): Promise<SpendRow[]> {
  return prisma.adSpend.findMany({
    where: { organizationId, provider: { in: AD_PROVIDERS }, date: { gte, lte } },
    select: { provider: true, spendAmount: true, currency: true, impressions: true, clicks: true },
  });
}

export async function getAdSpendSummary(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({})
) {
  const periodStart = range.from;
  const periodEnd = range.to;

  const [currentRows, priorRows] = await Promise.all([
    fetchSpend(organizationId, periodStart, periodEnd),
    fetchSpend(organizationId, range.priorFrom, range.priorTo),
  ]);

  const current = totalise(currentRows);
  const prior = totalise(priorRows);

  // Only comparable when both periods resolved to a single, identical
  // currency — otherwise the pair isn't measuring the same thing.
  const comparable =
    current.total != null && prior.total != null && prior.total !== 0n && current.currency === prior.currency;
  const changePct = comparable
    ? Math.round((Number(current.total! - prior.total!) / Number(prior.total!)) * 1000) / 10
    : null;

  // Per-platform split, so "ad spend is up" can be attributed rather than
  // just observed. Kept per-currency-safe the same way the total is.
  const byProvider = AD_PROVIDERS.map((provider) => {
    const rows = currentRows.filter((r) => r.provider === provider);
    const t = totalise(rows);
    return {
      provider,
      valueMinor: t.total?.toString() ?? null,
      value: t.total == null ? null : paiseToRupees(t.total),
      currency: t.currency,
      mixedCurrency: t.mixedCurrency,
      impressions: rows.reduce((sum, r) => sum + (r.impressions ?? 0), 0),
      clicks: rows.reduce((sum, r) => sum + (r.clicks ?? 0), 0),
      // One AdSpend row is one account-day, so this is the number of days
      // with data for this platform — not an account count.
      dayCount: rows.length,
    };
  }).filter((p) => p.dayCount > 0);

  // Default period only (see shouldPersistSnapshot in lib/dateRange.ts).
  if (current.total != null && shouldPersistSnapshot(range)) {
    await persistSnapshot(organizationId, "ad_spend_mtd", periodStart, periodEnd, current.total);
  }

  return {
    metricKey: "ad_spend_mtd",
    currency: current.currency,
    mixedCurrency: current.mixedCurrency,
    byCurrency: current.byCurrency,
    valueMinor: current.total?.toString() ?? null,
    value: current.total == null ? null : paiseToRupees(current.total),
    priorValueMinor: prior.total?.toString() ?? null,
    priorValue: prior.total == null ? null : paiseToRupees(prior.total),
    changePct,
    byProvider,
    impressions: currentRows.reduce((sum, r) => sum + (r.impressions ?? 0), 0),
    clicks: currentRows.reduce((sum, r) => sum + (r.clicks ?? 0), 0),
    dayCount: currentRows.length,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    periodFiltered: true,
    comparison: range.comparison,
    formulaVersion: FORMULA_VERSION,
  };
}

// ROAS = net revenue ÷ ad spend, and blended CAC = ad spend ÷ orders, both
// MTD. "Blended" is accurate rather than a shortcut: this is total spend over
// total orders, with no attribution model claiming which order came from
// which ad — building that would need click/conversion tracking this system
// doesn't have, and a made-up attribution split is worse than an honest
// blended figure.
export async function getAdEfficiencySummary(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({})
) {
  const periodStart = range.from;
  const periodEnd = range.to;

  const [spend, revenue, orderCount] = await Promise.all([
    getAdSpendSummary(organizationId, range),
    getNetRevenueSummary(organizationId, range),
    prisma.order.count({ where: { organizationId, placedAt: { gte: periodStart, lte: periodEnd } } }),
  ]);

  // Revenue is INR by construction (Order amounts are paise). Comparing it
  // against spend only means something if spend is INR too — a USD-billed ad
  // account yields a null ROAS here rather than a number off by ~85x.
  const spendMinor = spend.valueMinor == null ? null : BigInt(spend.valueMinor);
  const comparableCurrency = spend.currency === "INR";
  const usable = spendMinor != null && spendMinor > 0n && comparableCurrency;

  const revenueMinor = BigInt(revenue.valueMinor);
  const roas = usable ? Math.round((Number(revenueMinor) / Number(spendMinor!)) * 100) / 100 : null;
  const cacMinor = usable && orderCount > 0 ? spendMinor! / BigInt(orderCount) : null;

  return {
    metricKey: "ad_efficiency_mtd",
    roas,
    blendedCacMinor: cacMinor?.toString() ?? null,
    blendedCac: cacMinor == null ? null : paiseToRupees(cacMinor),
    adSpendMinor: spend.valueMinor,
    adSpend: spend.value,
    netRevenueMinor: revenue.valueMinor,
    netRevenue: revenue.value,
    orderCount,
    currency: spend.currency,
    // Set when spend exists but isn't in INR, so the UI can explain a blank
    // ROAS instead of rendering it as "no data".
    incomparableCurrency: spendMinor != null && spendMinor > 0n && !comparableCurrency,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    periodFiltered: true,
    comparison: range.comparison,
    formulaVersion: FORMULA_VERSION,
  };
}

// Same manual findFirst+create/update as revenue.ts/shipments.ts — Prisma
// can't .upsert() against this compound key with legalEntityId: null.
async function persistSnapshot(
  organizationId: string,
  metricKey: string,
  periodStart: Date,
  periodEnd: Date,
  valueMinor: bigint
) {
  const existing = await prisma.metricSnapshot.findFirst({
    where: {
      organizationId,
      legalEntityId: null,
      metricKey,
      granularity: "MONTHLY",
      periodStart,
      formulaVersion: FORMULA_VERSION,
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.metricSnapshot.update({
      where: { id: existing.id },
      data: { periodEnd, valueMinor, computedAt: new Date() },
    });
  } else {
    await prisma.metricSnapshot.create({
      data: {
        organizationId,
        metricKey,
        granularity: "MONTHLY",
        periodStart,
        periodEnd,
        valueMinor,
        formulaVersion: FORMULA_VERSION,
        confidence: "ESTIMATED",
      },
    });
  }
}
