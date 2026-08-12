import { prisma } from "../src/lib/prisma.js";

// Clears freight cost that no longer has an invoice behind it.
//
// The first version of the Bluedart invoice parser wrote freightAmount straight
// onto shipments and discarded the invoice. Freight invoices are now persisted
// (FreightInvoice / FreightInvoiceLine) so that a charge can be traced to the
// document that made it, a re-upload can be detected, and waybills billed for
// parcels we have no record of can be surfaced at all.
//
// That leaves shipments carrying a cost with no document behind it. Left alone
// they would report as "billed" on a reconciliation leg that has no invoice to
// match them to — a figure nobody could explain or dispute. Cleared here; the
// invoices need re-uploading, which is now one multi-select.
//
// Run with: npx tsx scripts/clearOrphanFreight.ts          (dry run)
//           npx tsx scripts/clearOrphanFreight.ts --apply

async function main() {
  const apply = process.argv.includes("--apply");

  const orphans = await prisma.$queryRaw<Array<{ organizationId: string; n: number; total: bigint }>>`
    SELECT s."organizationId", count(*)::int AS n, coalesce(sum(s."freightAmount"), 0)::bigint AS total
    FROM shipments s
    WHERE s."freightAmount" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM freight_invoice_lines l WHERE l."shipmentId" = s.id
      )
    GROUP BY s."organizationId"`;

  if (orphans.length === 0) {
    console.log("no orphaned freight — every costed shipment traces to an invoice line");
    await prisma.$disconnect();
    return;
  }

  for (const o of orphans) {
    const org = await prisma.organization.findUnique({
      where: { id: o.organizationId },
      select: { name: true },
    });
    console.log(
      `${org?.name ?? o.organizationId}: ${o.n} shipments carrying ₹${(Number(o.total) / 100).toFixed(2)} with no invoice behind it`
    );
  }

  if (!apply) {
    console.log("\ndry run — re-run with --apply to clear");
    await prisma.$disconnect();
    return;
  }

  const cleared = await prisma.$executeRaw`
    UPDATE shipments s SET "freightAmount" = NULL
    WHERE s."freightAmount" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM freight_invoice_lines l WHERE l."shipmentId" = s.id
      )`;
  console.log(`\ncleared ${cleared} shipments — re-upload the invoice PDFs to restore the cost with its source`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
