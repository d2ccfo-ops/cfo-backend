// P0.4 — verifies the write side (writeAudit) and read side (the query
// buildAuditQuery-shaped logic in routes/audit.ts) agree, in an isolated
// scratch org. Also fails a non-throwing check: a write-failure inside
// writeAudit must not throw into the caller.
import { prisma } from "../src/lib/prisma.js";
import { writeAudit } from "../src/lib/audit.js";

let failures = 0;
function expect(cond: boolean, label: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
}

async function main() {
  const org = await prisma.organization.create({
    data: { name: "TEST audit coverage (auto-deleted)", clerkOrgId: `test_audit_${process.pid}` },
  });
  try {
    await writeAudit({
      organizationId: org.id,
      actorType: "USER",
      actorId: "test-user",
      action: "connection.credential_set",
      entityType: "CONNECTION",
      entityId: "conn-1",
      metadata: { provider: "RAZORPAY" },
    });
    await writeAudit({
      organizationId: org.id,
      actorType: "SYSTEM",
      actorId: "oauth_callback",
      action: "connection.credential_set",
      entityType: "CONNECTION",
      entityId: "conn-2",
      metadata: { provider: "AMAZON" },
    });
    await writeAudit({
      organizationId: org.id,
      actorType: "USER",
      actorId: "test-user",
      action: "cost.bulk_import",
      entityType: "PRODUCT_COST",
      metadata: { saved: 12 },
    });

    const all = await prisma.auditLog.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: "asc" } });
    expect(all.length === 3, "3 writes land as 3 rows");

    const byAction = await prisma.auditLog.findMany({
      where: { organizationId: org.id, action: "connection.credential_set" },
    });
    expect(byAction.length === 2, "action filter narrows to the matching 2");

    const byActorType = await prisma.auditLog.findMany({ where: { organizationId: org.id, actorType: "SYSTEM" } });
    expect(byActorType.length === 1 && byActorType[0]!.actorId === "oauth_callback", "actorType filter isolates the OAuth callback row");

    // Cross-org isolation — the single most important property of an audit
    // trail meant to answer "who did this, in MY org".
    const other = await prisma.organization.create({
      data: { name: "TEST audit isolation (auto-deleted)", clerkOrgId: `test_audit_other_${process.pid}` },
    });
    try {
      const leaked = await prisma.auditLog.findMany({ where: { organizationId: other.id } });
      expect(leaked.length === 0, "a second org sees none of the first org's audit rows");
    } finally {
      await prisma.organization.delete({ where: { id: other.id } });
    }

    // writeAudit must never throw into its caller — an invalid enum value
    // (a typo'd actorType) makes the underlying prisma.create() reject, and
    // that must be swallowed (logged, not thrown).
    let threw = false;
    try {
      // @ts-expect-error — deliberately invalid, to prove the catch works
      await writeAudit({ organizationId: org.id, actorType: "NOT_A_REAL_TYPE", actorId: "x", action: "y", entityType: "Z" });
    } catch {
      threw = true;
    }
    expect(!threw, "a malformed write is swallowed, never thrown into the caller");

    // Cursor pagination shape, same query the route builds.
    const page1 = await prisma.auditLog.findMany({
      where: { organizationId: org.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    });
    const page2 = await prisma.auditLog.findMany({
      where: { organizationId: org.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
      cursor: { id: page1[page1.length - 1]!.id },
      skip: 1,
    });
    const ids1 = new Set(page1.map((r) => r.id));
    const overlap = page2.some((r) => ids1.has(r.id));
    expect(!overlap, "cursor pagination doesn't repeat a row across pages");
  } finally {
    await prisma.auditLog.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
