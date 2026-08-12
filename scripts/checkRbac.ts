import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { ROLE_ORDER, decideAccess, normaliseRole } from "../src/middleware/rbac.js";

// P5.1 against the real router tree and the real database.
//
// The unit tests assert the POLICY. This asserts the two things a unit test
// structurally cannot:
//
//   Coverage. Every mutating route in the app is enumerated from source and
//   run through decideAccess. A route nobody wrote a policy for should land on
//   the strictest general rule — but "should" is the word that precedes every
//   access-control hole, so it is checked rather than assumed.
//
//   Wiring. requireAuth must actually carry enforceRbac, and every protected
//   route must actually spread requireAuth. A perfect policy that is not
//   mounted is worse than no policy, because the Team page now tells users it
//   is enforced.
//
// Run with: npx tsx scripts/checkRbac.ts

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

const BACKEND = new URL("../", pathToFileURL(import.meta.dirname + "/"));
const FRONTEND = new URL("../../cfo-frontend/", pathToFileURL(import.meta.dirname + "/"));

// Router variable name -> mount path in app.ts.
async function mountMap(): Promise<Map<string, string>> {
  const src = await readFile(new URL("src/app.ts", BACKEND), "utf8");
  const map = new Map<string, string>();
  for (const m of src.matchAll(/app\.use\("([^"]+)",\s*(?:express\.raw\([^)]*\),\s*)?(\w+)\)/g)) {
    map.set(m[2]!, m[1]!);
  }
  return map;
}

async function routeFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: URL, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(`${prefix}${entry.name}`);
    }
  };
  await walk(new URL("src/routes/", BACKEND), "");
  return out;
}

async function main() {
  // ---------------------------------------------------------------------------
  console.log("\n[1] The guard is actually mounted");
  // ---------------------------------------------------------------------------
  const authSrc = await readFile(new URL("src/middleware/auth.ts", BACKEND), "utf8");
  // Order matters and is asserted, not just membership: authorise before
  // rate-limiting, so a request that will be refused for role does not consume
  // the organisation's budget. P5.7 appended enforceRateLimit to this chain.
  ok(
    "requireAuth resolves the org, then authorises, then rate-limits",
    /requireAuth\s*=\s*\[resolveOrgContext,\s*enforceRbac,\s*enforceRateLimit\]/.test(authSrc)
  );
  ok("the auth context carries the Membership role, not Clerk's", authSrc.includes("prisma.membership.findUnique"));
  ok(
    "a missing membership row never falls back to OWNER",
    !/membership[\s\S]{0,400}?\?\?\s*"OWNER"/.test(authSrc) && authSrc.includes('"ANALYST"')
  );

  // ---------------------------------------------------------------------------
  console.log("\n[2] Every mutating route is covered and lands somewhere sane");
  // ---------------------------------------------------------------------------
  const mounts = await mountMap();
  const files = await routeFiles();
  let mutating = 0;
  let unguarded = 0;
  const decided: Array<{ method: string; path: string; roles: string[] }> = [];

  for (const file of files) {
    if (file.startsWith("webhooks/")) continue; // authenticated by signature, not session
    const src = await readFile(new URL(`src/routes/${file}`, BACKEND), "utf8");
    for (const m of src.matchAll(/(\w+)\.(get|post|put|patch|delete)\(\s*"([^"]*)"([\s\S]{0,80})/g)) {
      const [, routerVar, method, routePath, tail] = m as unknown as [string, string, string, string, string];
      const mount = mounts.get(routerVar);
      if (mount === undefined) continue;
      const full = `${mount}${routePath === "/" ? "" : routePath}` || "/";
      const guarded = tail.includes("...requireAuth");
      // requireUser is a WEAKER but real guard: signed in, no organisation
      // required. It exists for onboarding, which renders before an org
      // exists. Legitimate on a read; never on a write, because a write with
      // no organisation has nothing to scope itself to.
      const userOnly = tail.includes("...requireUser");

      if (method === "get") {
        // OAuth callbacks are hit by the provider's redirect, carrying a
        // signed state parameter rather than a session. They and the
        // onboarding vocabularies are the only routes not behind requireAuth.
        if (!guarded && !userOnly && !routePath.includes("callback")) {
          unguarded += 1;
          ok(`GET ${full} is behind an auth guard`, false, "no guard and not an OAuth callback");
        }
        continue;
      }

      mutating += 1;
      ok(`${method.toUpperCase()} ${full} is behind requireAuth`, guarded, userOnly ? "guarded by requireUser only — a write cannot be org-less" : "");

      // Substitute a concrete value for each :param so the policy sees a real
      // path shape rather than a pattern.
      const concrete = full.replace(/:[A-Za-z]+/g, "abc123");
      const allowed = ROLE_ORDER.filter((r) => decideAccess(r, method.toUpperCase(), concrete).allowed);
      decided.push({ method: method.toUpperCase(), path: concrete, roles: allowed });

      // The property that matters: no mutating route may be open to a
      // read-only role, and none may be open to nobody.
      ok(`${method.toUpperCase()} ${concrete} is not writable by VIEWER`, !allowed.includes("VIEWER"));
      ok(`${method.toUpperCase()} ${concrete} is not writable by EXTERNAL_CA`, !allowed.includes("EXTERNAL_CA"));
      ok(`${method.toUpperCase()} ${concrete} is writable by someone`, allowed.length > 0);
      ok(`${method.toUpperCase()} ${concrete} is always writable by OWNER`, allowed.includes("OWNER"));
    }
  }
  ok(`found a realistic number of mutating routes`, mutating >= 30, `${mutating} found`);
  ok(`no unguarded non-callback GET routes`, unguarded === 0);

  console.log("\n  Effective write matrix:");
  for (const d of decided.sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`    ${d.method.padEnd(6)} ${d.path.padEnd(48)} ${d.roles.join(", ")}`);
  }

  // ---------------------------------------------------------------------------
  console.log("\n[3] Reads stay open to every role");
  // ---------------------------------------------------------------------------
  for (const role of ROLE_ORDER) {
    ok(`${role} can read metrics`, decideAccess(role, "GET", "/metrics/revenue").allowed);
  }

  // ---------------------------------------------------------------------------
  console.log("\n[4] Real membership rows resolve to real roles");
  // ---------------------------------------------------------------------------
  const memberships = await prisma.membership.findMany({ select: { role: true, email: true, organizationId: true } });
  ok("there are membership rows to check", memberships.length > 0, `${memberships.length} rows`);
  const byRole = new Map<string, number>();
  for (const m of memberships) byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);
  for (const [role, count] of byRole) {
    const effective = normaliseRole(role);
    console.log(`  · ${count} membership(s) stored as ${role} → effective ${effective}`);
    ok(`${role} resolves to a role that can read`, decideAccess(effective, "GET", "/metrics/revenue").allowed);
  }
  // Nobody is locked out. A row whose effective role cannot even read would be
  // a person staring at 403s with no way to tell why.
  ok(
    "no stored role resolves to something that cannot read",
    [...byRole.keys()].every((r) => decideAccess(normaliseRole(r), "GET", "/metrics/revenue").allowed)
  );

  // Every organisation should have someone who can manage it. An org with no
  // OWNER or ADMIN cannot connect a source or change a role — recoverable only
  // by hand in the database.
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  let orgsWithoutAdmin = 0;
  for (const org of orgs) {
    const admins = memberships.filter(
      (m) => m.organizationId === org.id && (normaliseRole(m.role) === "OWNER" || normaliseRole(m.role) === "ADMIN")
    ).length;
    const anyMember = memberships.filter((m) => m.organizationId === org.id).length;
    if (anyMember > 0 && admins === 0) {
      orgsWithoutAdmin += 1;
      console.log(`  · "${org.name}" has ${anyMember} member(s) and no OWNER or ADMIN`);
    }
  }
  ok("every organisation with members has at least one owner or admin", orgsWithoutAdmin === 0, `${orgsWithoutAdmin} without`);

  // ---------------------------------------------------------------------------
  console.log("\n[5] The Team page describes the policy that exists");
  // ---------------------------------------------------------------------------
  const teamSrc = await readFile(new URL("app/(dashboard)/team/page.js", FRONTEND), "utf8");
  for (const role of ROLE_ORDER) {
    ok(`the page names ${role}`, teamSrc.includes(role));
  }
  ok("the page reads the real endpoint", teamSrc.includes("/organization/members"));
  ok("the page surfaces the server's refusal message", teamSrc.includes("body?.message"));
  ok(
    "the page no longer claims permissions are unenforced",
    !/aren't implemented|not implemented anywhere|every member of this organisation can currently/i.test(teamSrc)
  );
  ok("the page shows the legacy MEMBER value rather than hiding it", teamSrc.includes("stored as MEMBER"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
