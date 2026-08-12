import { prisma } from "../src/lib/prisma.js";
import { normaliseRole } from "../src/middleware/rbac.js";

// One-time backfill for P5.1.
//
// Before RBAC existed, every member of an organisation could do everything, so
// an org whose only membership row said MEMBER worked fine. The moment roles
// are enforced, that org's only member can no longer connect a data source or
// change a role — and there is nobody who can grant it to them. The lockout is
// recoverable only by editing the database by hand.
//
// scripts/checkRbac.ts found exactly one such organisation in this database.
//
// The rule applied here is the one Clerk itself uses: whoever created the
// organisation owns it. The earliest membership row is that person.
//
// Idempotent, and it never demotes: an org that already has an OWNER or ADMIN
// is left alone.
//
// Run with: npx tsx scripts/backfillOrgOwners.ts [--apply]

const APPLY = process.argv.includes("--apply");

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  let promoted = 0;
  let alreadyFine = 0;
  let empty = 0;

  for (const org of orgs) {
    const members = await prisma.membership.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    if (members.length === 0) {
      empty += 1;
      continue;
    }
    const hasManager = members.some((m) => {
      const r = normaliseRole(m.role);
      return r === "OWNER" || r === "ADMIN";
    });
    if (hasManager) {
      alreadyFine += 1;
      continue;
    }

    const first = members[0]!;
    console.log(
      `${APPLY ? "PROMOTING" : "WOULD PROMOTE"}  ${org.name}: ${first.email} (${first.role}, joined ${first.createdAt.toISOString().slice(0, 10)}) → OWNER`
    );
    if (APPLY) {
      await prisma.membership.update({ where: { id: first.id }, data: { role: "OWNER" } });
      await prisma.auditLog.create({
        data: {
          organizationId: org.id,
          actorType: "SYSTEM",
          actorId: "backfillOrgOwners",
          action: "membership.role_changed",
          entityType: "MEMBERSHIP",
          entityId: first.id,
          metadata: {
            email: first.email,
            from: first.role,
            to: "OWNER",
            reason:
              "P5.1 backfill: this organisation had members but nobody who could manage it once roles began to be enforced. The earliest member — whoever created the organisation — was promoted.",
          },
        },
      });
    }
    promoted += 1;
  }

  console.log(
    `\n${orgs.length} organisations: ${alreadyFine} already had an owner or admin, ${promoted} ${APPLY ? "promoted" : "would be promoted"}, ${empty} have no members.`
  );
  if (!APPLY && promoted > 0) console.log("\nRe-run with --apply to make the change.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
