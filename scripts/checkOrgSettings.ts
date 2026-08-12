import { prisma } from "../src/lib/prisma.js";
import { getOrgSettings } from "../src/modules/orgs/settings.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// P2.0: org-wide settings, against the DEMO org. Exercises getOrgSettings()
// and the PUT route's merge-not-replace semantics directly via Prisma — the
// route handler itself is a thin wrapper over exactly this (see
// routes/preferences.ts), so this is the actual logic worth verifying live.
// orgSettingsSchema's validation rules are unit-tested in settings.test.ts;
// this checks what only a real Postgres round-trip can: reading back what
// was written, and that a partial write doesn't clobber other keys.
//
// Run with: npx tsx scripts/checkOrgSettings.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// Mirrors PUT /preferences/org's merge step exactly, so this script proves
// the same behavior the route exposes rather than a lookalike.
async function putOrgSettings(organizationId: string, patch: Record<string, unknown>) {
  const merged = { ...(await getOrgSettings(organizationId)), ...patch };
  await prisma.organization.update({ where: { id: organizationId }, data: { settings: merged } });
  return merged;
}

async function main() {
  const org = await findDemoOrg();
  if (!org) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }

  const before = await prisma.organization.findUnique({ where: { id: org.id }, select: { settings: true } });

  try {
    console.log("\n[1] an org with no settings yet reads back as {}");
    await prisma.organization.update({ where: { id: org.id }, data: { settings: null } });
    const empty = await getOrgSettings(org.id);
    ok("empty object, not null or an exception", JSON.stringify(empty) === "{}", JSON.stringify(empty));

    console.log("\n[2] writing one setting round-trips exactly");
    await putOrgSettings(org.id, { cashThresholdPaise: "5000000" });
    const afterFirst = await getOrgSettings(org.id);
    ok("cashThresholdPaise reads back unchanged", afterFirst.cashThresholdPaise === "5000000", JSON.stringify(afterFirst));

    console.log("\n[3] writing an unrelated key merges instead of replacing");
    // A future feature's key (P3.3 notification digests, say) is simulated
    // directly rather than imported, since orgSettingsSchema doesn't define
    // one yet — the point is proving the MERGE, not any specific key.
    await putOrgSettings(org.id, { futureFeatureFlag: "on" } as never);
    const afterSecond = (await prisma.organization.findUnique({ where: { id: org.id }, select: { settings: true } }))!.settings as Record<
      string,
      unknown
    >;
    ok("the earlier cashThresholdPaise survived the second, unrelated write", afterSecond.cashThresholdPaise === "5000000", JSON.stringify(afterSecond));
    ok("the new key landed alongside it", afterSecond.futureFeatureFlag === "on", JSON.stringify(afterSecond));

    console.log("\n[4] writing null explicitly unsets, distinct from never having been set");
    await putOrgSettings(org.id, { cashThresholdPaise: null });
    const afterUnset = await getOrgSettings(org.id);
    ok("cashThresholdPaise is null, key still present", afterUnset.cashThresholdPaise === null, JSON.stringify(afterUnset));
  } finally {
    // Explicit null, not undefined: Prisma drops an undefined field from the
    // update entirely (treats it as "not provided"), which would leave
    // whatever this script last wrote in place instead of restoring "never
    // configured" when the demo org started with no settings at all.
    await prisma.organization.update({ where: { id: org.id }, data: { settings: before?.settings ?? null } });
  }

  console.log("\n" + "─".repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f}`));
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
