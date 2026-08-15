import { createClerkClient } from "@clerk/backend";
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { decideAccess } from "../src/middleware/rbac.js";

// A shared read-only login for showing the product, so the owner's own
// credentials never have to be handed out.
//
// WHY FINANCE_MANAGER.
//
// Reads were never gated: rbac.ts opens every GET to every role, and the
// frontend has no role-based UI gating at all. So every page, figure and chart
// was already fully visible on this login regardless of role — "showing less
// than a paid account" was never true of what is on screen.
//
// What the role decides is only what a visitor may CHANGE. FINANCE_MANAGER is
// every ordinary action a paying customer takes: entering and restamping
// costs, writing off exceptions, acknowledging anomalies, running what-if
// scenarios, triggering a resync, approvals, notifications, reports.
//
// It stops short of exactly two things, and both would end the demo rather
// than demonstrate it:
//
//   /connections — DELETE /connections/:id is one click in the UI and would
//   drop one of the eleven live sources for every later visitor, permanently.
//   The same prefix rotates stored provider credentials.
//
//   /organization and /legal-entities — members and the company identity.
//
// It survives the Clerk webhook without a fixing step: reconcileRole with a
// clerkRole of "org:member" returns the EXISTING role for anything that is not
// OWNER or ADMIN, so FINANCE_MANAGER is preserved on every membership sync.
//
// WHAT THIS DOES NOT PROTECT AGAINST. This account can ask the AI CFO, and
// every question spends Anthropic tokens on the owner's key. A public demo
// login is therefore a public spend endpoint. Watch it, or point the demo at a
// key with a budget cap. It can also write costs and exception decisions,
// which persist for later visitors — that is the trade for a demo where
// nothing a visitor clicks returns a permission error.
//
// Idempotent: re-running finds the existing user and membership rather than
// failing. Run with:
//   npx tsx scripts/createDemoLogin.ts
// Optional overrides: DEMO_EMAIL, DEMO_PASSWORD, DEMO_ORG (organisation name).

const EMAIL = process.env.DEMO_EMAIL ?? "d2ccfo-demo@gmail.com";
const PASSWORD = process.env.DEMO_PASSWORD ?? "d2cfo";
const ORG_NAME = process.env.DEMO_ORG ?? "DEMO — Hrtiik pvt ltd";

async function main() {
  if (!env.CLERK_SECRET_KEY) throw new Error("CLERK_SECRET_KEY is not set — cannot manage Clerk users.");
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  const org = await prisma.organization.findFirst({
    where: { name: ORG_NAME },
    select: { id: true, name: true, clerkOrgId: true },
  });
  if (!org) throw new Error(`No organisation named ${JSON.stringify(ORG_NAME)}.`);
  if (!org.clerkOrgId) throw new Error(`${org.name} has no clerkOrgId — it cannot take members.`);
  const orders = await prisma.order.count({ where: { organizationId: org.id } });
  console.log(`Organisation : ${org.name}`);
  console.log(`               ${org.clerkOrgId}  ·  ${orders.toLocaleString("en-IN")} orders\n`);

  // --- the user -------------------------------------------------------------
  const existing = await clerk.users.getUserList({ emailAddress: [EMAIL] });
  let userId: string;
  if (existing.data.length > 0) {
    userId = existing.data[0]!.id;
    console.log(`User         : found ${EMAIL} (${userId})`);
    // Re-running should make the stated password true, not merely not-fail.
    await clerk.users.updateUser(userId, { password: PASSWORD, skipPasswordChecks: true });
    console.log(`               password reset to the documented demo password`);
  } else {
    const created = await clerk.users.createUser({
      emailAddress: [EMAIL],
      password: PASSWORD,
      // The demo password is short by design — it is meant to be typed off a
      // slide. Clerk's strength and breach checks would refuse it, and they
      // are right to for a real account; this one holds no personal data and
      // can write nothing.
      skipPasswordChecks: true,
      firstName: "Demo",
      lastName: "Viewer",
      publicMetadata: { demo: true },
      skipLegalChecks: true,
    });
    userId = created.id;
    console.log(`User         : created ${EMAIL} (${userId})`);
  }

  // --- the membership -------------------------------------------------------
  const members = await clerk.organizations.getOrganizationMembershipList({
    organizationId: org.clerkOrgId,
    limit: 100,
  });
  const already = members.data.find((m) => m.publicUserData?.userId === userId);
  if (already) {
    console.log(`Membership   : already a member as ${already.role}`);
    if (already.role !== "org:member") {
      // org:admin reconciles to ADMIN, which can rotate credentials. Never that.
      await clerk.organizations.updateOrganizationMembership({
        organizationId: org.clerkOrgId,
        userId,
        role: "org:member",
      });
      console.log(`               demoted to org:member (was ${already.role})`);
    }
  } else {
    await clerk.organizations.createOrganizationMembership({
      organizationId: org.clerkOrgId,
      userId,
      role: "org:member",
    });
    console.log(`Membership   : added to ${org.name} as org:member`);
  }

  // --- the DB row -----------------------------------------------------------
  // Clerk's webhook writes this, but a local run may have no tunnel for it to
  // reach, so the row is ensured here too. Same value either way.
  const row = await prisma.membership.upsert({
    where: { organizationId_clerkUserId: { organizationId: org.id, clerkUserId: userId } },
    update: { role: "FINANCE_MANAGER", email: EMAIL },
    create: { organizationId: org.id, clerkUserId: userId, email: EMAIL, role: "FINANCE_MANAGER" },
    select: { role: true },
  });
  console.log(`DB role      : ${row.role}\n`);

  // --- prove the permissions, against the real policy ------------------------
  const CAN = [
    ["GET", "/metrics/revenue"],
    ["GET", "/anomalies"],
    ["GET", "/reports"],
    ["POST", "/ai/ask"],
    ["POST", "/ai/ask/stream"],
    ["POST", "/metrics/cash-forecast/scenario"],
    // The day-to-day writes a paying customer makes. These are the ones that
    // used to 403 on this login and made the demo look half-built.
    ["POST", "/costs"],
    ["POST", "/costs/bulk"],
    ["POST", "/costs/restamp"],
    ["POST", "/exceptions/abc123/write-off"],
    ["POST", "/anomalies/abc123/acknowledge"],
    ["POST", "/approvals/abc123/approve"],
    // Refreshing data is a demo feature, not a risk: it re-reads from a source
    // that is already connected and changes no credential.
    ["POST", "/connections/abc123/sync"],
  ] as const;
  const CANNOT = [
    // The demo-enders. Everything here either drops a data source for every
    // later visitor or touches a stored provider credential.
    ["POST", "/connections/shopify/connect"],
    ["DELETE", "/connections/abc123"],
    ["PUT", "/legal-entities/primary"],
    ["POST", "/organization/members"],
  ] as const;

  let bad = 0;
  console.log("Permissions (checked against src/middleware/rbac.ts):");
  for (const [method, path] of CAN) {
    const ok = decideAccess(row.role, method, path).allowed;
    if (!ok) bad++;
    console.log(`   ${ok ? "yes" : "NO — EXPECTED YES"}   ${method} ${path}`);
  }
  for (const [method, path] of CANNOT) {
    const ok = decideAccess(row.role, method, path).allowed;
    if (ok) bad++;
    console.log(`   ${ok ? "ALLOWED — EXPECTED NO" : "no "}   ${method} ${path}`);
  }
  if (bad > 0) throw new Error(`${bad} permission(s) are not what a demo account should have.`);

  // --- what Clerk actually believes -----------------------------------------
  // Printed because the two things that silently break a demo login are an
  // unverified email (Clerk interrupts the sign-in with a code the visitor
  // cannot receive) and a user who is not attached to the org (they sign in
  // successfully and land on onboarding, seeing none of the data).
  const fresh = (await clerk.users.getUserList({ emailAddress: [EMAIL] })).data[0]!;
  const memberships = await clerk.users.getOrganizationMembershipList({ userId });
  console.log("Clerk state:");
  console.log(`   password set        ${fresh.passwordEnabled ? "yes" : "NO — sign-in will fail"}`);
  console.log(`   email verification  ${fresh.emailAddresses[0]?.verification?.status ?? "none"}`);
  for (const m of memberships.data) {
    console.log(`   member of           ${m.organization.name} (${m.role})`);
  }

  const unverified = fresh.emailAddresses[0]?.verification?.status !== "verified";
  if (unverified) {
    console.log("\n   ! Clerk may ask this account to verify its email on first sign-in.");
    console.log("     If it does, verify it once in the Clerk dashboard (Users -> this user");
    console.log("     -> email -> mark as verified); the session then works for everyone.");
  }

  console.log(`\nDone. Sign in at /login with ${EMAIL}.`);
  console.log("Every question asked on this login spends tokens on your Anthropic key.");
}

main()
  .catch((err) => {
    // Clerk errors carry the useful detail in `errors`, not in `message`.
    const detail = (err as { errors?: unknown }).errors;
    console.error("FAILED:", err instanceof Error ? err.message : err);
    if (detail) console.error(JSON.stringify(detail, null, 2));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
