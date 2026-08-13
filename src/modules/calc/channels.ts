import { Prisma } from "@prisma/client";
import type { ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { MARKETPLACE_PROVIDERS } from "./fulfilmentCosts.js";
import { paiseToRupees } from "./money.js";

// §14 / §20.3 channel profitability (P6.7).
//
// ---------------------------------------------------------------------------
// THE HARD PART IS NOT THE ARITHMETIC, IT IS WHAT CANNOT BE ALLOCATED
// ---------------------------------------------------------------------------
// Revenue, COGS, shipping and transaction fees all carry a channel: they hang
// off an order, and an order knows where it was sold. Those allocate exactly.
//
// Advertising does not. A Meta campaign drives the D2C store, and also the
// Amazon listing, and the brand search that converts on Flipkart three days
// later. Nothing in the data says which. The tempting move is to spread ad
// spend across channels in proportion to revenue — and it is a fabrication
// with a formula attached: it would make every channel's margin move together,
// guarantee that no channel ever looks unprofitable on ads alone, and hide the
// exact thing the breakdown is for.
//
// So this reports CM2 per channel — everything genuinely attributable — and
// reports advertising as an UNALLOCATED pool with the amount stated. A founder
// can see marketplace fees eating Amazon's margin, which is the real finding,
// without being told a made-up number about which channel the ads served.
//
// Where a campaign DOES state its channel (AdCampaignSpend.channel), that
// portion is allocated and the remainder stays in the pool. Partial truth,
// labelled as partial.

export const CHANNEL_VERSION = "v1";

export interface ChannelRow {
  channel: string;
  orders: number;
  netRevenue: number;
  netRevenueMinor: string;
  cogs: number;
  cogsMinor: string;
  shipping: number;
  shippingMinor: string;
  transactionFees: number;
  transactionFeesMinor: string;
  /** Net revenue − COGS − shipping − fees. Everything that allocates exactly. */
  cm2: number;
  cm2Minor: string;
  cm2Pct: number | null;
  /** Ad spend attributable to this channel, where a campaign said so. */
  allocatedAdSpend: number;
  allocatedAdSpendMinor: string;
  /** True when every order line in this channel carries a cost. */
  cogsComplete: boolean;
  uncostedLines: number;
}

export interface ChannelProfitability {
  metricKey: "channel_profitability";
  formulaVersion: string;
  period: { from: string; to: string };
  channels: ChannelRow[];
  /** Ad spend no campaign attributed to a channel. Stated, never spread. */
  unallocatedAdSpend: number;
  unallocatedAdSpendMinor: string;
  warnings: string[];
}

interface ChannelAgg {
  channel: string;
  orders: bigint;
  net: bigint;
  cogs: bigint;
  uncosted: bigint;
  shipping: bigint;
  fees: bigint;
}

export async function getChannelProfitability(
  organizationId: string,
  range: ResolvedRange
): Promise<ChannelProfitability> {
  // One pass per fact rather than one giant join: an order joined to its lines
  // AND its shipments AND its payments fans out multiplicatively, and summing
  // over that silently multiplies COGS by the shipment count. Aggregated
  // separately and stitched by channel, which cannot fan out.
  const marketplaceConnections = await prisma.connection.findMany({
    where: { organizationId, provider: { in: [...MARKETPLACE_PROVIDERS] } },
    select: { id: true },
  });

  const [revenueRows, cogsRows, shippingRows, feeRows, campaignRows, adTotal] = await Promise.all([
    prisma.$queryRaw<Array<{ channel: string; orders: bigint; net: bigint }>>(Prisma.sql`
      SELECT o.channel, count(*)::bigint AS orders,
             coalesce(sum(o."grossAmount" - o."taxAmount" - o."refundedAmount"), 0)::bigint AS net
      FROM orders o
      WHERE o."organizationId" = ${organizationId}
        AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
        AND o."cancelledAt" IS NULL
      GROUP BY o.channel`),

    prisma.$queryRaw<Array<{ channel: string; cogs: bigint; uncosted: bigint }>>(Prisma.sql`
      SELECT o.channel,
             coalesce(sum(li."cogsAmount"), 0)::bigint AS cogs,
             count(*) FILTER (WHERE li."cogsAmount" IS NULL)::bigint AS uncosted
      FROM order_line_items li
      JOIN orders o ON o.id = li."orderId"
      WHERE o."organizationId" = ${organizationId}
        AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
        AND o."cancelledAt" IS NULL
      GROUP BY o.channel`),

    prisma.$queryRaw<Array<{ channel: string; shipping: bigint }>>(Prisma.sql`
      SELECT o.channel, coalesce(sum(s."freightAmount"), 0)::bigint AS shipping
      FROM shipments s
      JOIN orders o ON o.id = s."orderId"
      WHERE s."organizationId" = ${organizationId}
        AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY o.channel`),

    prisma.$queryRaw<Array<{ channel: string; fees: bigint }>>(Prisma.sql`
      SELECT o.channel, coalesce(sum(p."feeAmount"), 0)::bigint AS fees
      FROM payments p
      JOIN orders o ON o.id = p."orderId"
      WHERE p."organizationId" = ${organizationId}
        AND p."capturedAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY o.channel`),

    // Only campaigns that state a channel. The rest stay in the pool.
    prisma.adCampaignSpend.groupBy({
      by: ["channel"],
      where: {
        organizationId,
        date: { gte: range.from, lte: range.to },
        currency: "INR",
        channel: { not: null },
      },
      _sum: { spendAmount: true },
    }),

    prisma.adSpend.aggregate({
      where: { organizationId, date: { gte: range.from, lte: range.to }, currency: "INR" },
      _sum: { spendAmount: true },
    }),
  ]);

  const acc = new Map<string, ChannelAgg>();
  const bucket = (channel: string): ChannelAgg => {
    const found = acc.get(channel);
    if (found) return found;
    const fresh: ChannelAgg = { channel, orders: 0n, net: 0n, cogs: 0n, uncosted: 0n, shipping: 0n, fees: 0n };
    acc.set(channel, fresh);
    return fresh;
  };

  for (const r of revenueRows) {
    const b = bucket(r.channel);
    b.orders = r.orders;
    b.net = r.net;
  }
  for (const r of cogsRows) {
    const b = bucket(r.channel);
    b.cogs = r.cogs;
    b.uncosted = r.uncosted;
  }
  for (const r of shippingRows) bucket(r.channel).shipping = r.shipping;
  for (const r of feeRows) bucket(r.channel).fees = r.fees;

  const allocatedByChannel = new Map<string, bigint>();
  for (const r of campaignRows) {
    if (!r.channel) continue;
    allocatedByChannel.set(r.channel, r._sum.spendAmount ?? 0n);
    // A CHANNEL CAN HAVE SPEND AND NO ORDERS, and it must still get a row.
    //
    // Buckets are otherwise built from orders alone, so a campaign attributed
    // to a channel that sold nothing in this period had its spend counted into
    // allocatedTotal — shrinking the unallocated pool — while appearing in no
    // channel row at all. The money left the business and then left the report:
    // allocated + unallocated no longer equalled total ad spend, and nothing
    // said so.
    //
    // This is not a contrived case. It is a brand running Amazon-directed ads
    // in a month its listing was suspended, or before the marketplace connector
    // was ever connected. The resulting row reads "0 orders, ₹0 revenue, ₹X of
    // ads" — which is exactly the finding, not a blank to be hidden.
    bucket(r.channel);
  }
  const allocatedTotal = [...allocatedByChannel.values()].reduce((s, v) => s + v, 0n);
  const adTotalMinor = adTotal._sum.spendAmount ?? 0n;
  // Never negative: a campaign pull that somehow exceeds the account total is a
  // data problem, and reporting a negative unallocated pool would present it as
  // a surplus.
  const unallocated = adTotalMinor > allocatedTotal ? adTotalMinor - allocatedTotal : 0n;

  const channels: ChannelRow[] = [...acc.values()]
    .map((b) => {
      const cm2 = b.net - b.cogs - b.shipping - b.fees;
      const allocated = allocatedByChannel.get(b.channel) ?? 0n;
      return {
        channel: b.channel,
        orders: Number(b.orders),
        netRevenue: paiseToRupees(b.net),
        netRevenueMinor: b.net.toString(),
        cogs: paiseToRupees(b.cogs),
        cogsMinor: b.cogs.toString(),
        shipping: paiseToRupees(b.shipping),
        shippingMinor: b.shipping.toString(),
        transactionFees: paiseToRupees(b.fees),
        transactionFeesMinor: b.fees.toString(),
        cm2: paiseToRupees(cm2),
        cm2Minor: cm2.toString(),
        cm2Pct: b.net === 0n ? null : Math.round((Number(cm2) / Number(b.net)) * 1000) / 10,
        allocatedAdSpend: paiseToRupees(allocated),
        allocatedAdSpendMinor: allocated.toString(),
        cogsComplete: b.uncosted === 0n,
        uncostedLines: Number(b.uncosted),
      };
    })
    .sort((a, b) => (BigInt(b.netRevenueMinor) > BigInt(a.netRevenueMinor) ? 1 : -1));

  const warnings: string[] = [];
  if (unallocated > 0n) {
    warnings.push(
      `${paiseToRupees(unallocated).toLocaleString("en-IN")} rupees of ad spend is not attributed to any channel and is deliberately NOT spread across them. Splitting it in proportion to revenue would make every channel's margin move together and guarantee none ever looks unprofitable on ads — which is the one thing this breakdown exists to reveal.`
    );
  }
  const incomplete = channels.filter((c) => !c.cogsComplete);
  if (incomplete.length > 0) {
    warnings.push(
      `${incomplete.map((c) => `${c.channel} (${c.uncostedLines} lines)`).join(", ")} have order lines with no product cost, so their margin is overstated.`
    );
  }
  if (channels.length <= 1) {
    warnings.push("All orders in this period came through one channel, so there is nothing to compare.");
  }

  return {
    metricKey: "channel_profitability",
    formulaVersion: CHANNEL_VERSION,
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    channels,
    unallocatedAdSpend: paiseToRupees(unallocated),
    unallocatedAdSpendMinor: unallocated.toString(),
    warnings,
  };
}
