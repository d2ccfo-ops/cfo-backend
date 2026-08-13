import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveDateRange } from "../src/lib/dateRange.js";
import { prisma } from "../src/lib/prisma.js";
import { getCampaignProfitability } from "../src/modules/calc/campaigns.js";
import { getChannelProfitability } from "../src/modules/calc/channels.js";
import { getContributionMargin } from "../src/modules/calc/contribution.js";

// P6.6 and P6.7, checked against the real database.
//
// TWO WAYS THESE COULD BE PLAUSIBLY WRONG, BOTH SILENT:
//
//  1. Channel profitability could spread unattributable ad spend across
//     channels in proportion to revenue. It would produce a complete-looking
//     table, and it would guarantee no channel ever looks unprofitable on ads
//     — hiding the one thing the breakdown exists to reveal.
//
//  2. Campaign spend could be summed alongside account-day spend. Nothing
//     throws; contribution margin quietly halves and reads as a bad month.
//     The two live in separate tables specifically so this cannot happen, and
//     the assertion below proves the advertising layer still reads only one.
//
// Run with: npx tsx scripts/checkChannelAndCampaign.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const FRONTEND = new URL("../../cfo-frontend/", pathToFileURL(import.meta.dirname + "/"));
const BACKEND = new URL("../", pathToFileURL(import.meta.dirname + "/"));
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  const withOrders: Array<{ id: string; name: string }> = [];
  for (const o of orgs) {
    if ((await prisma.order.count({ where: { organizationId: o.id } })) > 0) withOrders.push(o);
  }

  for (const org of withOrders) {
    console.log(`\n=== ${org.name}`);
    const range = resolveDateRange({ from: "2025-08-01", to: "2026-08-12" });
    const [channel, campaign, cm] = await Promise.all([
      getChannelProfitability(org.id, range),
      getCampaignProfitability(org.id, range),
      getContributionMargin(org.id, range),
    ]);

    // -------------------------------------------------------------------------
    // CHANNEL: what allocates, allocates exactly
    // -------------------------------------------------------------------------
    const orderTotal = await prisma.$queryRaw<Array<{ orders: bigint; net: bigint }>>`
      SELECT count(*)::bigint AS orders,
             coalesce(sum(o."grossAmount" - o."taxAmount" - o."refundedAmount"), 0)::bigint AS net
      FROM orders o
      WHERE o."organizationId" = ${org.id}
        AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
        AND o."cancelledAt" IS NULL`;
    const summedOrders = channel.channels.reduce((s, c) => s + c.orders, 0);
    const summedNet = channel.channels.reduce((s, c) => s + BigInt(c.netRevenueMinor), 0n);
    // Every non-cancelled order belongs to exactly one channel. A shortfall
    // means orders are being dropped; an excess means a join fanned out.
    ok("channel order counts sum to every order in the period", summedOrders === Number(orderTotal[0]?.orders ?? 0n), `${summedOrders} vs ${orderTotal[0]?.orders}`);
    ok("channel net revenue sums to total net revenue", summedNet === (orderTotal[0]?.net ?? 0n), `${inr(Number(summedNet) / 100)} vs ${inr(Number(orderTotal[0]?.net ?? 0n) / 100)}`);

    // COGS must not be multiplied by shipment count — the classic fan-out bug
    // when orders, lines and shipments are joined in one query.
    const cogsTotal = await prisma.$queryRaw<Array<{ cogs: bigint }>>`
      SELECT coalesce(sum(li."cogsAmount"), 0)::bigint AS cogs
      FROM order_line_items li JOIN orders o ON o.id = li."orderId"
      WHERE o."organizationId" = ${org.id}
        AND o."placedAt" BETWEEN ${range.from} AND ${range.to} AND o."cancelledAt" IS NULL`;
    const summedCogs = channel.channels.reduce((s, c) => s + BigInt(c.cogsMinor), 0n);
    ok("channel COGS sums to total COGS, not a multiple of it", summedCogs === (cogsTotal[0]?.cogs ?? 0n), `${inr(Number(summedCogs) / 100)} vs ${inr(Number(cogsTotal[0]?.cogs ?? 0n) / 100)}`);

    for (const c of channel.channels) {
      const expected = BigInt(c.netRevenueMinor) - BigInt(c.cogsMinor) - BigInt(c.shippingMinor) - BigInt(c.transactionFeesMinor);
      ok(`${c.channel}: CM2 is its own arithmetic`, BigInt(c.cm2Minor) === expected);
    }

    // -------------------------------------------------------------------------
    // CHANNEL: what does NOT allocate is never spread
    // -------------------------------------------------------------------------
    const adTotal = await prisma.adSpend.aggregate({
      where: { organizationId: org.id, date: { gte: range.from, lte: range.to }, currency: "INR" },
      _sum: { spendAmount: true },
    });
    const allocated = channel.channels.reduce((s, c) => s + BigInt(c.allocatedAdSpendMinor), 0n);
    const unallocated = BigInt(channel.unallocatedAdSpendMinor);
    ok(
      "allocated + unallocated ad spend = total ad spend",
      allocated + unallocated === (adTotal._sum.spendAmount ?? 0n),
      `${inr(Number(allocated) / 100)} + ${inr(Number(unallocated) / 100)} vs ${inr(Number(adTotal._sum.spendAmount ?? 0n) / 100)}`
    );
    ok("the unallocated pool is never negative", unallocated >= 0n);

    // THE REGRESSION THIS PINS. Channel rows are built from ORDERS. A campaign
    // attributed to a channel that sold nothing had its spend counted into the
    // allocated total — shrinking the unallocated pool — while getting no row,
    // so the money left the report in both directions at once. The arithmetic
    // assertion above catches it only while the demo happens to attribute a
    // campaign to an order-less channel, which is not something to depend on.
    const campaignChannels = await prisma.adCampaignSpend.groupBy({
      by: ["channel"],
      where: { organizationId: org.id, date: { gte: range.from, lte: range.to }, channel: { not: null } },
      _sum: { spendAmount: true },
    });
    const reported = new Set(channel.channels.map((c) => c.channel));
    const orphaned = campaignChannels.filter((c) => c.channel && (c._sum.spendAmount ?? 0n) > 0n && !reported.has(c.channel));
    ok(
      "every channel with attributed ad spend gets a row, even with no orders",
      orphaned.length === 0,
      orphaned.length > 0
        ? `${orphaned.map((o) => `${o.channel} ₹${Number(o._sum.spendAmount ?? 0n) / 100}`).join(", ")} vanished`
        : `${campaignChannels.length} attributed channel(s), all reported`
    );
    if (unallocated > 0n) {
      // The single most important assertion in this file. If ad spend were
      // spread by revenue share, every channel would carry some and the pool
      // would be empty.
      ok("unallocated ad spend stays unallocated, and says why", channel.warnings.some((w) => /NOT spread/.test(w)));
    }

    // -------------------------------------------------------------------------
    // CAMPAIGN: the finer grain never doubles the coarser one
    // -------------------------------------------------------------------------
    if (campaign.hasSource) {
      ok(
        "campaign spend reconciles to the account-day total",
        campaign.reconciles,
        `${campaign.coveragePct}% coverage`
      );
      if (!campaign.reconciles) {
        ok("…and an incomplete pull is stated with both numbers", campaign.warnings.some((w) => /account for/.test(w)));
      }
      // Platform claims must never present as this product's revenue.
      const claiming = campaign.campaigns.filter((c) => c.platformAttributedRevenue !== null);
      if (claiming.length > 0) {
        ok("platform-claimed revenue is labelled as the platform's", campaign.warnings.some((w) => /platform's own claims/.test(w)));
        // A demo or a pull quoting an impossible ROAS teaches a reader to
        // ignore the field. Real D2C sits well under 10.
        const maxRoas = Math.max(...claiming.map((c) => c.platformRoas ?? 0));
        ok("quoted ROAS is within a range that exists in reality", maxRoas < 10, `max ${maxRoas}`);
      }
      ok("campaign shares sum to about 100%", Math.abs(campaign.campaigns.reduce((s, c) => s + c.spendSharePct, 0) - 100) < 1.5 || campaign.campaigns.length >= 25);
    } else {
      // An org pulling account-day grain must say so rather than showing an
      // empty table that reads as "no campaigns running".
      // "No ad spend in this period" is short and complete; the grain
      // warning is longer. Both are acceptable — what is not is silence.
      ok("no campaign data says why, rather than showing nothing", campaign.warnings.length > 0 && (campaign.warnings[0]?.length ?? 0) > 20, campaign.warnings[0]?.slice(0, 70) ?? "(silent)");
      ok("…and reports zero coverage rather than claiming to reconcile", campaign.reconciles === false);
    }

    // THE DOUBLE-COUNT GUARD. Contribution margin's advertising layer must
    // still equal the account-day total, untouched by campaign rows existing.
    const adLayer = cm.layers.find((l) => l.key === "advertising")!;
    ok(
      "the advertising cost layer still reads account-day spend only",
      BigInt(adLayer.amountMinor) === (adTotal._sum.spendAmount ?? 0n),
      `${inr(adLayer.amount)} vs ${inr(Number(adTotal._sum.spendAmount ?? 0n) / 100)}`
    );

    console.log(
      `  · ${channel.channels.length} channels, ${inr(channel.unallocatedAdSpend)} unallocated ads, ` +
        `${campaign.campaigns.length} campaigns at ${campaign.coveragePct}% coverage`
    );
  }

  // ---------------------------------------------------------------------------
  console.log("\n[source] Campaign rows live in their own table, by design");
  // ---------------------------------------------------------------------------
  const contribSrc = await readFile(new URL("src/modules/calc/contribution.ts", BACKEND), "utf8");
  // The whole reason for the separate table. If contribution.ts ever reads
  // adCampaignSpend, the doubling this design prevents becomes possible again.
  ok("contribution.ts never reads adCampaignSpend", !/adCampaignSpend/.test(contribSrc));
  const schemaSrc = await readFile(new URL("prisma/schema.prisma", BACKEND), "utf8");
  ok("the schema explains why the grains are separate", /finer grain of the same fact/i.test(schemaSrc));
  const channelSrc = await readFile(new URL("src/modules/calc/channels.ts", BACKEND), "utf8");
  // Matched across the comment line breaks the phrase actually wraps on.
  ok("channels.ts states the refusal to spread ad spend", /fabrication[\s\S]{0,20}with a formula/i.test(channelSrc));

  // ---------------------------------------------------------------------------
  console.log("\n[ui] The pages can reach both");
  // ---------------------------------------------------------------------------
  try {
    const profitSrc = await readFile(new URL("app/(dashboard)/profitability/page.js", FRONTEND), "utf8");
    const channelCard = await readFile(new URL("components/cards/ChannelProfitability.js", FRONTEND), "utf8");
    const campaignCard = await readFile(new URL("components/cards/CampaignProfitability.js", FRONTEND), "utf8");
    ok("the profitability page fetches channel profitability", /channel-profitability/.test(profitSrc));
    ok("…and campaign profitability", /campaign-profitability/.test(profitSrc));
    ok("both cards are rendered", /<ChannelProfitability/.test(profitSrc) && /<CampaignProfitability/.test(profitSrc));

    // The pool must be VISIBLE, not merely present in the payload. Hiding it
    // would make the channel table read as a complete P&L split, which it
    // deliberately is not.
    ok("the unallocated pool is rendered", /unallocatedAdSpendMinor/.test(channelCard));
    ok("…and says why it was not divided", /would make every channel/i.test(channelCard));
    // Per-channel, not one page-level caveat: a founder reading Amazon's
    // margin needs to know Amazon's costs are incomplete.
    ok("incomplete COGS is named per channel", /uncostedLines/.test(channelCard));
    // The platform's ROAS must not read with the same authority as spend.
    ok("platform ROAS is labelled as the platform's", /Platform ROAS/.test(campaignCard));
    ok("…and an account-grain-only org is told so", /hasSource/.test(campaignCard));
  } catch (e) {
    ok("the profitability page is readable", false, e instanceof Error ? e.message : "unreadable");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
