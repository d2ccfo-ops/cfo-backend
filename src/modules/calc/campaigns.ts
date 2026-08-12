import type { ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { paiseToRupees } from "./money.js";

// §14 campaign profitability (P6.6).
//
// ---------------------------------------------------------------------------
// WHAT THIS DELIBERATELY DOES NOT CLAIM
// ---------------------------------------------------------------------------
// Every ad platform reports "conversions" and "conversion value" against its
// own attribution model — Meta's default counts a purchase within 7 days of a
// click or 1 day of a view, and counts it even if the customer arrived through
// Google an hour later. Google counts the same purchase. Add the two and a
// brand doing ₹1 Cr sees ₹1.6 Cr of "attributed revenue".
//
// So platform-claimed revenue is reported as PLATFORM-CLAIMED, kept in its own
// fields, and never summed into anything this product calls revenue. ROAS
// computed from it is labelled the platform's ROAS.
//
// The number this module treats as real is spend, because spend is a bank
// transaction and not a model. Everything derived from spend alone — cost per
// click, share of total spend, spend concentration — is measured. Everything
// derived from the platform's conversion claim is quoted, not asserted.
//
// ---------------------------------------------------------------------------
// THE RECONCILIATION THAT MAKES THIS TRUSTWORTHY
// ---------------------------------------------------------------------------
// AdSpend holds the authoritative account-day total; AdCampaignSpend holds the
// finer grain. They are separate tables precisely so they can disagree, and a
// disagreement is reported rather than smoothed: campaign rows summing to less
// than the account total means the campaign pull is incomplete, and a
// "top campaigns" list built on an incomplete pull ranks the wrong things.

export const CAMPAIGN_VERSION = "v1";

/**
 * How far campaign totals may sit from the account-day total before the
 * breakdown stops being trustworthy. One percent covers rounding across
 * hundreds of rows; beyond that a pull is missing campaigns.
 */
const COVERAGE_TOLERANCE_PCT = 1;

export interface CampaignRow {
  campaignId: string;
  campaignName: string | null;
  provider: string;
  channel: string | null;
  spend: number;
  spendMinor: string;
  impressions: number | null;
  clicks: number | null;
  /** Cost per click. Measured — both terms are the platform's billing record. */
  cpc: number | null;
  /** Share of total campaign spend in the period. */
  spendSharePct: number;
  /** The PLATFORM'S conversion claim, not ours. Never summed into revenue. */
  platformConversions: number | null;
  platformAttributedRevenue: number | null;
  /** The platform's own ROAS, from its own numbers. Quoted, not asserted. */
  platformRoas: number | null;
}

export interface CampaignProfitability {
  metricKey: "campaign_profitability";
  formulaVersion: string;
  period: { from: string; to: string };
  campaigns: CampaignRow[];
  totalSpend: number;
  totalSpendMinor: string;
  /** The authoritative account-day total for the same window. */
  accountTotalSpend: number;
  accountTotalSpendMinor: string;
  /** What share of account spend the campaign rows account for. */
  coveragePct: number;
  /** False when the two totals disagree beyond tolerance — the list is then partial. */
  reconciles: boolean;
  hasSource: boolean;
  warnings: string[];
}

export async function getCampaignProfitability(
  organizationId: string,
  range: ResolvedRange,
  limit = 25
): Promise<CampaignProfitability> {
  const [rows, accountTotal] = await Promise.all([
    prisma.adCampaignSpend.groupBy({
      by: ["campaignId", "campaignName", "provider", "channel"],
      where: { organizationId, date: { gte: range.from, lte: range.to }, currency: "INR" },
      _sum: { spendAmount: true, impressions: true, clicks: true, conversions: true, attributedRevenue: true },
    }),
    prisma.adSpend.aggregate({
      where: { organizationId, date: { gte: range.from, lte: range.to }, currency: "INR" },
      _sum: { spendAmount: true },
    }),
  ]);

  const totalMinor = rows.reduce((s, r) => s + (r._sum.spendAmount ?? 0n), 0n);
  const accountMinor = accountTotal._sum.spendAmount ?? 0n;
  const warnings: string[] = [];

  if (rows.length === 0) {
    return {
      metricKey: "campaign_profitability",
      formulaVersion: CAMPAIGN_VERSION,
      period: { from: range.from.toISOString(), to: range.to.toISOString() },
      campaigns: [],
      totalSpend: 0,
      totalSpendMinor: "0",
      accountTotalSpend: paiseToRupees(accountMinor),
      accountTotalSpendMinor: accountMinor.toString(),
      coveragePct: 0,
      reconciles: false,
      hasSource: false,
      warnings: [
        accountMinor > 0n
          ? "Ad spend is being pulled at account-day grain only, so it cannot be split by campaign. The connector needs a campaign-level pull before this breakdown means anything."
          : "No ad spend in this period.",
      ],
    };
  }

  const coveragePct =
    accountMinor === 0n ? 0 : Math.round((Number(totalMinor) / Number(accountMinor)) * 1000) / 10;
  const reconciles = accountMinor > 0n && Math.abs(coveragePct - 100) <= COVERAGE_TOLERANCE_PCT;

  if (!reconciles && accountMinor > 0n) {
    // Stated with both numbers. "Data may be incomplete" tells nobody whether
    // to trust the ranking; "campaigns account for 62% of spend" does.
    warnings.push(
      `Campaign rows account for ${coveragePct}% of the ${paiseToRupees(accountMinor).toLocaleString("en-IN")} rupees of ad spend recorded for this period. The ranking below covers only what was pulled — campaigns outside it could be larger than anything shown.`
    );
  }

  const campaigns: CampaignRow[] = rows
    .map((r) => {
      const spendMinor = r._sum.spendAmount ?? 0n;
      const clicks = r._sum.clicks ?? null;
      const attributed = r._sum.attributedRevenue ?? null;
      return {
        campaignId: r.campaignId,
        campaignName: r.campaignName,
        provider: r.provider,
        channel: r.channel,
        spend: paiseToRupees(spendMinor),
        spendMinor: spendMinor.toString(),
        impressions: r._sum.impressions ?? null,
        clicks,
        // Integer division on paise, then converted — never a float divided by
        // a float, for the same reason every other money path here avoids it.
        cpc: clicks && clicks > 0 ? paiseToRupees(spendMinor / BigInt(clicks)) : null,
        spendSharePct: totalMinor === 0n ? 0 : Math.round((Number(spendMinor) / Number(totalMinor)) * 1000) / 10,
        platformConversions: r._sum.conversions ?? null,
        platformAttributedRevenue: attributed === null ? null : paiseToRupees(attributed),
        platformRoas:
          attributed === null || spendMinor === 0n
            ? null
            : Math.round((Number(attributed) / Number(spendMinor)) * 100) / 100,
      };
    })
    .sort((a, b) => (BigInt(b.spendMinor) > BigInt(a.spendMinor) ? 1 : -1))
    .slice(0, limit);

  if (campaigns.some((c) => c.platformAttributedRevenue !== null)) {
    warnings.push(
      "Attributed revenue and ROAS are the ad platform's own claims, on its own attribution window. Meta and Google both count the same purchase, so these do not add up to real revenue and must not be summed."
    );
  }
  if (campaigns.every((c) => c.channel === null)) {
    warnings.push(
      "No campaign states which sales channel it drove, so this spend cannot be allocated to a channel in the profitability breakdown."
    );
  }

  return {
    metricKey: "campaign_profitability",
    formulaVersion: CAMPAIGN_VERSION,
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    campaigns,
    totalSpend: paiseToRupees(totalMinor),
    totalSpendMinor: totalMinor.toString(),
    accountTotalSpend: paiseToRupees(accountMinor),
    accountTotalSpendMinor: accountMinor.toString(),
    coveragePct,
    reconciles,
    hasSource: true,
    warnings,
  };
}
