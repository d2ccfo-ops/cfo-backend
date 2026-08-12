/**
 * Backfills OrderLineItem.discountAmount / taxAmount / refundedAmount /
 * refundedTaxAmount / refundedQuantity from the stored Shopify payload.
 *
 * Before this, §40 SKU revenue allocated the order's discount and tax across
 * lines pro-rata by line value, and ignored refunds entirely — so a product's
 * "net revenue" was neither net of returns nor using the per-line figures
 * Shopify already states. See modules/calc/productProfitability.ts.
 *
 * Safe to re-run: it only ever rewrites these five columns, matching lines to
 * the payload by Shopify's line_item id where available and falling back to
 * position. Rows it cannot match confidently are left null, which the calc
 * reads as "not supplied" and handles by allocation rather than assuming zero.
 *
 *   npx tsx scripts/backfillLineItemFinancials.ts [--dry]
 */
import { prisma } from "../src/lib/prisma.js";
import { mapOrderFinancialsForBackfill } from "../src/modules/connectors/shopify/index.js";

const DRY = process.argv.includes("--dry");
const BATCH = 500;

async function main() {
  const total = await prisma.order.count({ where: { channel: "shopify" } });
  console.log(`${total} Shopify orders to scan${DRY ? " (dry run)" : ""}`);

  let processed = 0;
  let linesUpdated = 0;
  let linesUnmatched = 0;
  let ordersWithoutRaw = 0;
  let cursor: string | undefined;

  for (;;) {
    const orders = await prisma.order.findMany({
      where: { channel: "shopify" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        raw: true,
        lineItems: { select: { id: true, sku: true, quantity: true, totalAmount: true } },
      },
    });
    if (orders.length === 0) break;
    cursor = orders[orders.length - 1]!.id;

    const updates: { id: string; data: Record<string, bigint | number> }[] = [];

    for (const order of orders) {
      processed += 1;
      const raw = order.raw as Record<string, unknown> | null;
      if (!raw || !Array.isArray(raw.line_items)) {
        ordersWithoutRaw += 1;
        continue;
      }

      const mapped = mapOrderFinancialsForBackfill(raw);
      // Stored rows carry no Shopify line id, so they have to be paired with
      // the payload by value. NOT by position: Postgres returns rows in heap
      // order, which for real orders here is often not payload order (#5182
      // stores its three lines in a different sequence than Shopify sent them),
      // and pairing by position would attach one product's refund to another.
      //
      // Keying on sku+quantity+gross is unambiguous, and when two lines do share
      // a key they are the same product at the same price, so either pairing
      // aggregates identically.
      const pool = new Map<string, typeof mapped>();
      for (const m of mapped) {
        const key = `${m.sku ?? ""}|${m.quantity}|${m.totalAmount}`;
        const bucket = pool.get(key);
        if (bucket) bucket.push(m);
        else pool.set(key, [m]);
      }

      for (const dbLine of order.lineItems) {
        const key = `${dbLine.sku ?? ""}|${dbLine.quantity}|${dbLine.totalAmount}`;
        const m = pool.get(key)?.shift();
        if (!m) {
          // The payload no longer contains this line — an order edited after
          // ingestion. Leaving it null keeps it out of the "measured" bucket
          // rather than silently claiming a zero discount.
          linesUnmatched += 1;
          continue;
        }
        updates.push({
          id: dbLine.id,
          data: {
            discountAmount: m.discountAmount,
            taxAmount: m.taxAmount,
            refundedAmount: m.refundedAmount,
            refundedTaxAmount: m.refundedTaxAmount,
            refundedQuantity: m.refundedQuantity,
          },
        });
      }
    }

    if (!DRY && updates.length > 0) {
      await prisma.$transaction(
        updates.map((u) => prisma.orderLineItem.update({ where: { id: u.id }, data: u.data }))
      );
    }
    linesUpdated += updates.length;
    console.log(`  ${processed}/${total} orders · ${linesUpdated} lines`);
  }

  console.log(
    `\ndone: ${linesUpdated} line items ${DRY ? "would be " : ""}updated, ` +
      `${linesUnmatched} left null (unmatched), ${ordersWithoutRaw} orders without a usable payload`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
