/**
 * P2.3a-pre: populates the Refund table from stored Shopify order payloads.
 *
 * Every Shopify order this system has ever ingested kept its full payload in
 * Order.raw (§112 keeps the raw and normalised layers separate precisely so
 * that a new normalised field can be derived later without asking the provider
 * again). The refunds[] array has been sitting in there the whole time; only
 * its cumulative total was ever read out. This reads the rest.
 *
 * That matters beyond convenience: a full re-sync would re-pull a year of
 * orders through a rate-limited API, and Shopify's order endpoint does not
 * guarantee it will still return refund transactions for orders old enough to
 * have been archived. The stored payload is the more complete source.
 *
 * Safe to re-run: every row upserts on (connectionId, externalRefundId), and
 * it never deletes — a Refund may already be referenced by a MatchResult once
 * the §15 leg 6 reconciliation has run.
 *
 *   npx tsx scripts/backfillRefunds.ts [--dry]
 */
import { prisma } from "../src/lib/prisma.js";
import { mapRefunds } from "../src/modules/connectors/shopify/index.js";

const DRY = process.argv.includes("--dry");
const BATCH = 500;

async function main() {
  const total = await prisma.order.count({ where: { channel: "shopify" } });
  console.log(`${total} Shopify orders to scan${DRY ? " (dry run)" : ""}`);

  let processed = 0;
  let ordersWithRefunds = 0;
  let refundsWritten = 0;
  let ordersWithoutRaw = 0;
  let skippedNoId = 0;
  let valueWritten = 0n;
  let cursor: string | undefined;

  for (;;) {
    const orders = await prisma.order.findMany({
      where: { channel: "shopify" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true, organizationId: true, legalEntityId: true, connectionId: true, raw: true, refundedAmount: true },
    });
    if (orders.length === 0) break;
    cursor = orders.at(-1)!.id;

    for (const order of orders) {
      processed += 1;
      if (!order.raw || typeof order.raw !== "object") {
        ordersWithoutRaw += 1;
        continue;
      }

      const raw = order.raw as Record<string, unknown>;
      // Counted so the summary can distinguish "no refunds" from "refunds we
      // could not key" — the second is a data-quality finding, the first isn't.
      const rawTxns = ((raw.refunds as Array<{ transactions?: Array<{ kind?: string; status?: string; id?: unknown }> }> | undefined) ?? [])
        .flatMap((r) => r.transactions ?? [])
        .filter((t) => t.kind === "refund" && (!t.status || t.status === "success"));
      skippedNoId += rawTxns.filter((t) => t.id == null).length;

      // mapRefunds is the SAME function the live connector uses. A backfill
      // with its own parsing would drift from the sync path, and the two would
      // disagree about which refunds exist — with no way to tell which was
      // right.
      const refunds = mapRefunds(raw as never);
      if (refunds.length === 0) continue;
      ordersWithRefunds += 1;

      for (const r of refunds) {
        valueWritten += r.amount;
        refundsWritten += 1;
        if (DRY) continue;
        await prisma.refund.upsert({
          where: { connectionId_externalRefundId: { connectionId: order.connectionId, externalRefundId: r.externalRefundId } },
          create: {
            organizationId: order.organizationId,
            legalEntityId: order.legalEntityId,
            connectionId: order.connectionId,
            orderId: order.id,
            externalRefundId: r.externalRefundId,
            amount: r.amount,
            currency: r.currency,
            processedAt: r.processedAt,
            gateway: r.gateway,
            gatewayRef: r.gatewayRef,
            raw: r.raw as object,
          },
          update: {
            amount: r.amount,
            processedAt: r.processedAt,
            gateway: r.gateway,
            gatewayRef: r.gatewayRef,
            raw: r.raw as object,
          },
        });
      }
    }

    console.log(`  ${processed}/${total} scanned, ${refundsWritten} refunds`);
  }

  const rupees = (p: bigint) => "₹" + (Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  console.log(`\nscanned ${processed} orders`);
  console.log(`  ${ordersWithRefunds} had money-backed refunds`);
  console.log(`  ${refundsWritten} refund rows ${DRY ? "would be" : ""} written, ${rupees(valueWritten)}`);
  if (ordersWithoutRaw > 0) console.log(`  ${ordersWithoutRaw} orders had no stored payload to read`);
  if (skippedNoId > 0) {
    console.log(`  ${skippedNoId} refund transactions had no id and were skipped — they cannot be given a stable key`);
  }

  // The cross-check that says whether this backfill is trustworthy. Every
  // money-backed refund transaction should sum, per order, to that order's
  // refundedAmount — both come from the same payload under the same void rule,
  // so a discrepancy means the two readings disagree and one of them is wrong.
  if (!DRY) {
    const drift = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM (
        SELECT o.id
        FROM orders o
        LEFT JOIN refunds r ON r."orderId" = o.id
        WHERE o.channel = 'shopify'
        GROUP BY o.id, o."refundedAmount"
        HAVING COALESCE(SUM(r.amount), 0) <> o."refundedAmount"
      ) t
    `;
    const n = Number(drift[0]?.n ?? 0n);
    console.log(
      n === 0
        ? "\n  ✓ every order's refund rows sum exactly to its refundedAmount"
        : `\n  ✗ ${n} orders where the refund rows do not sum to refundedAmount — investigate before trusting the leg`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
