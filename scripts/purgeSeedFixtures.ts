/**
 * Removes the fabricated demo rows that predate the real Shopify connection.
 *
 * They are identifiable by three independent markers at once, all of which must
 * hold for every row or the script refuses to run: `connectionId` points at a
 * connection that does not exist ("seed-fixture-*"), `externalOrderId` starts
 * with "seed-", and `raw` is null (every genuinely-synced order stores its
 * payload). 68 orders worth ₹1,64,731 and 65 shipments, all in one org, were
 * counting toward order volume, AOV, gross sales and net revenue.
 *
 *   npx tsx scripts/purgeSeedFixtures.ts [--dry]
 */
import { prisma } from "../src/lib/prisma.js";
import { writeFileSync } from "node:fs";

const DRY = process.argv.includes("--dry");
const BACKUP = process.env.SEED_PURGE_BACKUP ?? "./seed-fixture-backup.json";

async function main() {
  const orders = await prisma.order.findMany({ where: { connectionId: { startsWith: "seed-fixture" } } });
  const shipments = await prisma.shipment.findMany({ where: { connectionId: { startsWith: "seed-fixture" } } });
  const lineItems = await prisma.orderLineItem.findMany({ where: { orderId: { in: orders.map((o) => o.id) } } });

  console.log(`orders: ${orders.length}  line items: ${lineItems.length}  shipments: ${shipments.length}`);
  if (orders.length === 0 && shipments.length === 0) return console.log("nothing to purge");

  const allFabricated = orders.every((o) => o.raw === null && o.externalOrderId.startsWith("seed-"));
  if (!allFabricated) {
    console.log("ABORT: some rows do not carry every fabricated-data marker — refusing to delete real orders");
    return;
  }
  const gross = orders.reduce((a, o) => a + o.grossAmount, 0n);
  console.log(`gross value ₹${(Number(gross) / 100).toFixed(2)}  orgs: ${[...new Set(orders.map((o) => o.organizationId))].join(", ")}`);

  writeFileSync(BACKUP, JSON.stringify({ orders, lineItems, shipments }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`backup: ${BACKUP}`);
  if (DRY) return console.log("DRY RUN — nothing deleted");

  await prisma.$transaction([
    prisma.orderLineItem.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } }),
    prisma.shipment.deleteMany({ where: { connectionId: { startsWith: "seed-fixture" } } }),
    prisma.order.deleteMany({ where: { connectionId: { startsWith: "seed-fixture" } } }),
  ]);
  console.log("purged.");
}
main().finally(() => prisma.$disconnect());
