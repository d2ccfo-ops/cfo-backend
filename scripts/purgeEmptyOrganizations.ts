import { prisma } from "../src/lib/prisma.js";

// Removes the leftover Postgres rows for organisations that have already been
// deleted in Clerk. Run AFTER deleting them in the Clerk dashboard, never
// before — Clerk owns the org switcher, so removing our rows first would leave
// the org visible but unselectable (requireAuth returns 409
// organization_not_synced), which is strictly worse than an empty dashboard.
//
// Run with:  npx tsx scripts/purgeEmptyOrganizations.ts          (dry run)
//            npx tsx scripts/purgeEmptyOrganizations.ts --commit (deletes)
//
// The target list is explicit rather than "anything that looks empty". An
// org can be empty because it is junk, or empty because a connector has not
// finished its first sync — and this script cannot tell those apart, so it
// refuses to guess.

const TARGET_CLERK_ORG_IDS = [
  "org_3Hb1EoXp8Hq0izR4iZVfDANrgoF", // ramakant pvt ltd
  "org_3Hb1BZVNlpioTPpcsLHB8OQYPyW", // ramakant pvt ltd (second one)
  "org_3HcJFU7XnbVOPLVDJFkw4R5Lgh7", // technox pvt ltd
  "org_3HcJI8WOnhOM0H3eeYXIXSlFGsm", // hritksdfa s
  "org_3HcJJFojKK4FOuQVoa2Z0Dz0gW9", // asdfasdf
  "org_3HcJLwdybJN8jv3xeQP7mtHQ2O7", // Hritik kumar
  "org_3HcJPyzQo6M8h2H3GGOWZDbAxHK", // checking pvt ltdd
];

// The orgs holding real data. Named explicitly so that a copy-paste mistake in
// the list above cannot destroy them — the script aborts rather than deleting
// anything if one of these ever appears as a target.
const PROTECTED_CLERK_ORG_IDS = new Set([
  "org_3HaBTIqsJggVmp7HnkBKUqwJIAM", // Hrtiik pvt ltd — Shopify + 2 bank connections
  "org_3HctDsxtmS1BzxqnXGKORaEtOHS", // hritik — Shopify
]);

// Anything whose presence means the org is NOT disposable. Memberships,
// legal entities, dashboard layouts and zero-valued metric snapshots are
// excluded: all four are created automatically just by signing in and opening
// a page, so none of them is evidence that a human put something there.
async function meaningfulRowCounts(organizationId: string) {
  const [
    connections, orders, products, payments, settlements, bankTransactions,
    shipments, adSpend, expenses, vendorBills, productCosts, rawEvents,
    reconciliationMatches, auditLog,
  ] = await Promise.all([
    prisma.connection.count({ where: { organizationId } }),
    prisma.order.count({ where: { organizationId } }),
    prisma.product.count({ where: { organizationId } }),
    prisma.payment.count({ where: { organizationId } }),
    prisma.settlement.count({ where: { organizationId } }),
    prisma.bankTransaction.count({ where: { organizationId } }),
    prisma.shipment.count({ where: { organizationId } }),
    prisma.adSpend.count({ where: { organizationId } }),
    prisma.expense.count({ where: { organizationId } }),
    prisma.vendorBill.count({ where: { organizationId } }),
    prisma.productCost.count({ where: { organizationId } }),
    prisma.rawEvent.count({ where: { organizationId } }),
    prisma.reconciliationMatch.count({ where: { organizationId } }),
    prisma.auditLog.count({ where: { organizationId } }),
  ]);

  return {
    connections, orders, products, payments, settlements, bankTransactions,
    shipments, adSpend, expenses, vendorBills, productCosts, rawEvents,
    reconciliationMatches, auditLog,
  };
}

async function main() {
  const commit = process.argv.includes("--commit");

  const orgs = await prisma.organization.findMany({
    where: { clerkOrgId: { in: TARGET_CLERK_ORG_IDS } },
    select: { id: true, name: true, clerkOrgId: true },
  });

  for (const id of TARGET_CLERK_ORG_IDS) {
    if (PROTECTED_CLERK_ORG_IDS.has(id)) {
      console.error(`REFUSING: ${id} is in the protected list. Nothing deleted.`);
      process.exit(1);
    }
  }

  const missing = TARGET_CLERK_ORG_IDS.filter((id) => !orgs.some((o) => o.clerkOrgId === id));
  if (missing.length > 0) {
    console.log(`Already absent from Postgres (${missing.length}): ${missing.join(", ")}\n`);
  }

  const deletable: typeof orgs = [];
  for (const org of orgs) {
    const counts = await meaningfulRowCounts(org.id);
    const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);

    if (nonEmpty.length > 0) {
      console.log(`SKIP  ${org.name} (${org.clerkOrgId}) — has ${nonEmpty.map(([k, n]) => `${k}=${n}`).join(", ")}`);
      continue;
    }

    const [memberships, snapshots, layouts, entities] = await Promise.all([
      prisma.membership.count({ where: { organizationId: org.id } }),
      prisma.metricSnapshot.count({ where: { organizationId: org.id } }),
      prisma.dashboardLayout.count({ where: { organizationId: org.id } }),
      prisma.legalEntity.count({ where: { organizationId: org.id } }),
    ]);
    console.log(
      `OK    ${org.name} (${org.clerkOrgId}) — empty; will also drop ${memberships} membership(s), ${snapshots} zero snapshot(s), ${layouts} layout(s), ${entities} legal entit(ies)`
    );
    deletable.push(org);
  }

  if (deletable.length === 0) {
    console.log("\nNothing to delete.");
    return;
  }

  if (!commit) {
    console.log(`\nDry run. ${deletable.length} organisation(s) would be deleted. Re-run with --commit.`);
    return;
  }

  for (const org of deletable) {
    const organizationId = org.id;
    // Ordered by foreign-key dependency. Organization is last because every
    // other row references it.
    await prisma.$transaction([
      prisma.metricSnapshot.deleteMany({ where: { organizationId } }),
      prisma.dashboardLayout.deleteMany({ where: { organizationId } }),
      prisma.membership.deleteMany({ where: { organizationId } }),
      prisma.legalEntity.deleteMany({ where: { organizationId } }),
      prisma.organization.delete({ where: { id: organizationId } }),
    ]);
    console.log(`deleted ${org.name} (${org.clerkOrgId})`);
  }

  const remaining = await prisma.organization.findMany({
    select: { name: true, clerkOrgId: true, _count: { select: { connections: true } } },
    orderBy: { createdAt: "asc" },
  });
  console.log("\nRemaining organisations:");
  for (const o of remaining) {
    console.log(`  ${o.name.padEnd(20)} ${o.clerkOrgId}  connections=${o._count.connections}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
