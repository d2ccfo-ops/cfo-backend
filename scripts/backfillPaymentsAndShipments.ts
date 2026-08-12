import { prisma } from "../src/lib/prisma.js";
import { toConnectorContext } from "../src/modules/connectors/types.js";
import { syncShipmentsFromStoredOrders } from "../src/modules/connectors/shopify/shipments.js";
import { pullOrderTransactions } from "../src/modules/connectors/shopify/transactions.js";

// One-time backfill for the two reconciliation sources that were sitting
// unused: order transactions (→ Payment rows, via a GraphQL bulk export) and
// the fulfillments already stored in Order.raw (→ Shipment rows, no API call).
//
// Order matters: transactions FIRST, so the shipments pass can compute a
// PPCOD order's door collectible as gross − captured-online. If the API side
// fails, shipments still run — codAmount degrades to the full gross for PPCOD
// orders until a later run refines it, which is stated in the output rather
// than hidden.
//
// Idempotent end to end (both writers upsert on their natural keys), so
// re-running after a partial failure converges.
//
// Run with: npx tsx scripts/backfillPaymentsAndShipments.ts

const rupees = (paise: bigint | number) =>
  "₹" + (Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const connections = await prisma.connection.findMany({
    where: { provider: "SHOPIFY", status: "ACTIVE" },
    select: {
      id: true,
      organizationId: true,
      legalEntityId: true,
      credentialsRef: true,
      externalAccountId: true,
    },
  });
  // Connection has no relation field to Organization in the schema — names
  // are looked up separately, purely for readable output.
  const orgs = await prisma.organization.findMany({
    where: { id: { in: connections.map((c) => c.organizationId) } },
    select: { id: true, name: true },
  });
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  if (connections.length === 0) {
    console.log("No active Shopify connections.");
    return;
  }

  // Sequential on purpose: Shopify allows one bulk operation per app+shop at
  // a time, and both connections here point at the same store.
  for (const connection of connections) {
    const ctx = toConnectorContext(connection);
    console.log(`\n=== ${orgName.get(connection.organizationId) ?? connection.organizationId} (${connection.externalAccountId}) ===`);

    // --- Payments (live API) --------------------------------------------
    try {
      const t0 = Date.now();
      const tx = await pullOrderTransactions(ctx, null, { timeoutMs: 20 * 60 * 1000 });
      if (tx.skipped) {
        console.log("payments: SKIPPED — another bulk operation held the shop's slot. Re-run for this org.");
      } else {
        console.log(
          `payments: ${tx.paymentsUpserted.toLocaleString("en-IN")} upserted from ${tx.ordersSeen.toLocaleString("en-IN")} orders in ${Math.round((Date.now() - t0) / 1000)}s`
        );
      }
    } catch (err) {
      console.error(`payments: FAILED — ${err instanceof Error ? err.message : err}`);
      console.error("continuing to shipments; PPCOD collectibles will use the full gross until payments land.");
    }

    // --- Shipments (our DB only) ----------------------------------------
    const t1 = Date.now();
    const ship = await syncShipmentsFromStoredOrders(connection.id, null);
    console.log(
      `shipments: ${ship.shipmentsUpserted.toLocaleString("en-IN")} upserted from ${ship.ordersScanned.toLocaleString("en-IN")} orders in ${Math.round((Date.now() - t1) / 1000)}s`
    );

    // --- Report what this org can now see -------------------------------
    const [byStatus, payments, codDelivered, codRto] = await Promise.all([
      prisma.shipment.groupBy({
        by: ["status"],
        where: { organizationId: connection.organizationId },
        _count: { _all: true },
      }),
      prisma.payment.aggregate({
        where: { organizationId: connection.organizationId, status: "captured" },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.shipment.aggregate({
        where: { organizationId: connection.organizationId, status: "DELIVERED", codAmount: { gt: 0 } },
        _count: { _all: true },
        _sum: { codAmount: true },
      }),
      prisma.shipment.aggregate({
        where: {
          organizationId: connection.organizationId,
          status: { in: ["RTO_INITIATED", "RTO_DELIVERED"] },
          codAmount: { gt: 0 },
        },
        _count: { _all: true },
        _sum: { codAmount: true },
      }),
    ]);

    console.log("shipment statuses:");
    for (const s of byStatus.sort((a, b) => b._count._all - a._count._all)) {
      console.log(`  ${s.status.padEnd(17)} ${String(s._count._all).padStart(7)}`);
    }
    console.log(
      `captured payments: ${payments._count._all.toLocaleString("en-IN")} totalling ${rupees(payments._sum.amount ?? 0n)}`
    );
    console.log(
      `COD delivered (courier owes): ${codDelivered._count._all.toLocaleString("en-IN")} shipments, ${rupees(codDelivered._sum.codAmount ?? 0n)}`
    );
    console.log(
      `COD gone RTO (never collected): ${codRto._count._all.toLocaleString("en-IN")} shipments, ${rupees(codRto._sum.codAmount ?? 0n)}`
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
