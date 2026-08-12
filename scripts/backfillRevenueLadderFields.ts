/**
 * Backfills Order.itemsAmount / shippingAmount / refundedAmount / cancelledAt /
 * paymentMode / customerRef from the Shopify payload already stored in
 * Order.raw.
 *
 * Every one of these fields was present in the payloads we've been saving all
 * along — the connector just wasn't reading them — so this needs no Shopify API
 * calls, no re-auth and no rate-limit budget. Re-syncing 25k orders to recover
 * data already sitting in our own database would be the slower, more fragile
 * option.
 *
 * Idempotent: re-running recomputes the same values from the same raw JSON.
 * Only Shopify rows are touched; other providers store a different payload
 * shape and are skipped rather than guessed at.
 *
 *   npx tsx scripts/backfillRevenueLadderFields.ts [--dry-run]
 */
import { prisma } from "../src/lib/prisma.js";

const BATCH_SIZE = 500;
const dryRun = process.argv.includes("--dry-run");

// Kept in sync with modules/connectors/shopify/index.ts — see the comments
// there for why PPCOD counts as COD and why only kind === "refund" counts.
const COD_GATEWAY_PATTERNS = [/cash[\s_]*on[\s_]*delivery/i, /\bcod\b/i, /ppcod/i];

function toPaise(value: unknown): bigint {
  if (value == null) return 0n;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 100));
}

function classifyPaymentMode(gateways: unknown): string {
  if (!Array.isArray(gateways) || gateways.length === 0) return "UNKNOWN";
  const isCod = gateways.some(
    (g) => typeof g === "string" && COD_GATEWAY_PATTERNS.some((p) => p.test(g))
  );
  return isCod ? "COD" : "PREPAID";
}

function refundedTotal(refunds: unknown): bigint {
  if (!Array.isArray(refunds)) return 0n;
  let total = 0n;
  for (const refund of refunds) {
    const txns = (refund as { transactions?: unknown }).transactions;
    if (!Array.isArray(txns)) continue;
    for (const txn of txns) {
      const t = txn as { kind?: string; status?: string; amount?: string };
      if (t.kind !== "refund") continue;
      if (t.status && t.status !== "success") continue;
      total += toPaise(t.amount);
    }
  }
  return total;
}

async function main() {
  const total = await prisma.order.count({ where: { channel: "shopify", raw: { not: null } } });
  console.log(`${total} Shopify orders with raw payloads${dryRun ? " (DRY RUN — no writes)" : ""}`);

  let processed = 0;
  let updated = 0;
  let skippedNoRaw = 0;
  const totals = { items: 0n, shipping: 0n, refunded: 0n };
  const modes = new Map<string, number>();
  let cancelled = 0;
  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.order.findMany({
      where: { channel: "shopify", raw: { not: null } },
      select: { id: true, raw: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    for (const order of batch) {
      processed += 1;
      const raw = order.raw as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") {
        skippedNoRaw += 1;
        continue;
      }

      const shippingSet = raw.total_shipping_price_set as
        | { shop_money?: { amount?: string } }
        | undefined;

      const data = {
        itemsAmount: toPaise(raw.total_line_items_price),
        shippingAmount: toPaise(shippingSet?.shop_money?.amount),
        refundedAmount: refundedTotal(raw.refunds),
        cancelledAt: raw.cancelled_at ? new Date(raw.cancelled_at as string) : null,
        paymentMode: classifyPaymentMode(raw.payment_gateway_names),
        customerRef:
          (raw.customer as { id?: unknown } | null)?.id != null
            ? String((raw.customer as { id: unknown }).id)
            : null,
      };

      totals.items += data.itemsAmount;
      totals.shipping += data.shippingAmount;
      totals.refunded += data.refundedAmount;
      if (data.cancelledAt) cancelled += 1;
      modes.set(data.paymentMode, (modes.get(data.paymentMode) ?? 0) + 1);

      if (!dryRun) {
        await prisma.order.update({ where: { id: order.id }, data });
        updated += 1;
      }
    }
    process.stdout.write(`\r  processed ${processed}/${total}`);
  }

  console.log(`\n\nprocessed=${processed} updated=${updated} skippedNoRaw=${skippedNoRaw}`);
  console.log(`GMV (itemsAmount)   ₹${(Number(totals.items) / 100).toLocaleString("en-IN")}`);
  console.log(`shipping revenue    ₹${(Number(totals.shipping) / 100).toLocaleString("en-IN")}`);
  console.log(`refunded (real)     ₹${(Number(totals.refunded) / 100).toLocaleString("en-IN")}`);
  console.log(`cancelled orders    ${cancelled}`);
  console.log(`payment mode        ${[...modes].map(([k, v]) => `${k}=${v}`).join(", ")}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
