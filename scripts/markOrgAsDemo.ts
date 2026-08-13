/**
 * Applies (or removes) the "DEMO — " name prefix on an organisation.
 *
 *   npx tsx scripts/markOrgAsDemo.ts --org "Hrtiik pvt ltd"
 *   npx tsx scripts/markOrgAsDemo.ts --org "DEMO — Hrtiik pvt ltd" --undo
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS INSTEAD OF A --force FLAG ON seedDemoGaps.ts
 * ---------------------------------------------------------------------------
 * The seeder refuses any org without the prefix, because fabricated costs
 * written into an org holding measured data are indistinguishable from the
 * measured ones — a margin that is fiction looks exactly like a real margin.
 *
 * The obvious way to seed such an org anyway is a --force flag. That would be
 * the wrong tool: --force is a per-run override that leaves no trace, so the
 * NEXT person to open the org sees fabricated freight invoices sitting next to
 * real ones with nothing to tell them apart.
 *
 * This changes the org's own name instead. The declaration is durable, it is
 * visible in the org switcher and on every page, and the seeder's guard keeps
 * working unmodified — an org that carries the prefix has been declared
 * synthetic, which is exactly the precondition the guard was checking for.
 *
 * --undo removes the prefix, and refuses if the org still holds rows the
 * seeder created, because that would strip the declaration off data that is
 * still fabricated.
 */
import { prisma } from "../src/lib/prisma.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DEMO_NAME_PREFIX = "DEMO — ";
const DEMO_CREDENTIALS_PREFIX = "demo-seed:";
const UNDO = flag("undo");
const ORG_QUERY = value("org");

async function main() {
  if (!ORG_QUERY) {
    console.error('Usage: npx tsx scripts/markOrgAsDemo.ts --org "<name or id>" [--undo]');
    process.exit(1);
  }

  const orgs = await prisma.organization.findMany({
    where: { OR: [{ id: ORG_QUERY }, { name: { contains: ORG_QUERY, mode: "insensitive" } }] },
    select: { id: true, name: true },
  });
  if (orgs.length === 0) throw new Error(`No organisation matches "${ORG_QUERY}".`);
  if (orgs.length > 1) {
    throw new Error(
      `"${ORG_QUERY}" matches ${orgs.length} organisations:\n${orgs.map((o) => `  ${o.name} (${o.id})`).join("\n")}\nPass the id.`
    );
  }
  const org = orgs[0]!;

  if (UNDO) {
    if (!org.name.startsWith(DEMO_NAME_PREFIX)) {
      console.log(`"${org.name}" does not carry the prefix — nothing to do.`);
      await prisma.$disconnect();
      return;
    }
    // The refusal that makes --undo safe. Stripping the prefix off an org that
    // still holds seeded rows would relabel fabricated data as real.
    const seeded = await prisma.connection.count({
      where: { organizationId: org.id, credentialsRef: { startsWith: DEMO_CREDENTIALS_PREFIX } },
    });
    if (seeded > 0) {
      throw new Error(
        `REFUSED: "${org.name}" still holds ${seeded} seeded connection(s).\n\n` +
          `Removing the prefix would leave fabricated freight invoices, settlement lines and\n` +
          `costs in an org that no longer announces itself as synthetic.\n\n` +
          `Run: npx tsx scripts/seedDemoGaps.ts --org "${org.name}" --purge`
      );
    }
    const name = org.name.slice(DEMO_NAME_PREFIX.length);
    await prisma.organization.update({ where: { id: org.id }, data: { name } });
    console.log(`"${org.name}" → "${name}"`);
    await prisma.$disconnect();
    return;
  }

  if (org.name.startsWith(DEMO_NAME_PREFIX)) {
    console.log(`"${org.name}" already carries the prefix — nothing to do.`);
    await prisma.$disconnect();
    return;
  }

  // Report what is already in there before relabelling it. Marking an org as a
  // demo is cheap; doing it to the wrong org and then seeding over the top is
  // not, so the counts are printed rather than assumed.
  const [orders, payments, shipments, settlements] = await Promise.all([
    prisma.order.count({ where: { organizationId: org.id } }),
    prisma.payment.count({ where: { organizationId: org.id } }),
    prisma.shipment.count({ where: { organizationId: org.id } }),
    prisma.settlement.count({ where: { organizationId: org.id } }),
  ]);
  console.log(`"${org.name}" holds ${orders} orders, ${payments} payments, ${shipments} shipments, ${settlements} settlements.`);

  const name = `${DEMO_NAME_PREFIX}${org.name}`;
  await prisma.organization.update({ where: { id: org.id }, data: { name } });
  console.log(`"${org.name}" → "${name}"`);
  console.log(`\nseedDemoGaps.ts will now accept this org. Run:`);
  console.log(`  npx tsx scripts/seedDemoGaps.ts --org "${org.id}"`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
