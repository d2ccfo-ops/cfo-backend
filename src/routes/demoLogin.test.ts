import { describe, expect, it } from "vitest";
import { normaliseRole, decideAccess } from "../middleware/rbac.js";
import { SHAREABLE_ROLES } from "./demoLogin.js";
import type { MembershipRole } from "@prisma/client";

// What the demo-login route promises, tested against the real policy rather
// than against a comment. The route hands a stranger a session; these are the
// properties that make that acceptable.
//
// The route itself is a thin shell over the Clerk SDK — mocking Clerk to
// assert "createSignInToken was called" would test the mock. What is worth
// pinning is the RULE it enforces, which is pure and shared with rbac.ts: the
// set of roles it will issue a token for must be exactly the set that cannot
// change a figure or a credential.

/** The real predicate from routes/demoLogin.ts, not a copy of it. */
function safeToShare(role: MembershipRole | string): boolean {
  return SHAREABLE_ROLES.includes(normaliseRole(role));
}

describe("demo login refuses the roles that can end the demo", () => {
  it("allows the working roles", () => {
    for (const role of ["FINANCE_MANAGER", "ACCOUNTANT", "ANALYST", "VIEWER"] as MembershipRole[]) {
      expect(safeToShare(role), `${role} should be shareable`).toBe(true);
    }
  });

  it("refuses OWNER and ADMIN — the only roles that can overwrite a source credential", () => {
    // The real risk, checked against real routes. There is no disconnect
    // endpoint in this codebase; /connect and /install are what exist, and
    // both replace the stored credential for a live provider.
    const CREDENTIAL_WRITES = [
      "/connections/shopify/connect",
      "/connections/razorpay/connect",
      "/connections/bank/connect",
      "/connections/meta-ads/install",
      "/connections/amazon/install",
    ];
    for (const role of ["OWNER", "ADMIN"] as MembershipRole[]) {
      expect(safeToShare(role), `${role} must never be shareable`).toBe(false);
      for (const p of CREDENTIAL_WRITES) {
        expect(decideAccess(role, "POST", p).allowed, `${role} can ${p}`).toBe(true);
      }
    }
    // And the shareable ceiling genuinely cannot reach any of them.
    for (const p of CREDENTIAL_WRITES) {
      expect(decideAccess("FINANCE_MANAGER", "POST", p).allowed, `FM must not reach ${p}`).toBe(false);
    }
  });

  it("refuses EXTERNAL_CA — read-only, but a named professional identity, not a demo", () => {
    expect(safeToShare("EXTERNAL_CA")).toBe(false);
  });

  it("treats the legacy MEMBER value as ANALYST, matching the rest of the system", () => {
    // MEMBER ≡ ANALYST everywhere else; if this route disagreed it would
    // refuse to sign in an account the webhook considers perfectly ordinary.
    expect(normaliseRole("MEMBER")).toBe("ANALYST");
    expect(safeToShare("MEMBER")).toBe(true);
  });

  it("an unrecognised role lands on ANALYST, which cannot touch credentials", () => {
    // normaliseRole maps unknown values to ANALYST, so a role this build has
    // never heard of becomes shareable. That is the safe direction, and this
    // pins the property that makes it safe.
    expect(safeToShare("SOMETHING_NEW")).toBe(true);
    expect(decideAccess("ANALYST", "POST", "/connections/shopify/connect").allowed).toBe(false);
  });
});

describe("the role the demo account actually holds", () => {
  const CAN: Array<[string, string]> = [
    ["GET", "/metrics/revenue"],
    ["GET", "/anomalies"],
    ["GET", "/reports"],
    ["POST", "/ai/ask"],
    ["POST", "/ai/ask/stream"],
    ["POST", "/metrics/cash-forecast/scenario"],
    ["POST", "/costs"],
    ["POST", "/costs/bulk"],
    ["POST", "/costs/restamp"],
    ["POST", "/exceptions/abc123/write-off"],
    ["POST", "/anomalies/abc123/acknowledge"],
    ["POST", "/approvals/abc123/approve"],
    ["POST", "/connections/abc123/sync"],
  ];
  const CANNOT: Array<[string, string]> = [
    ["POST", "/connections/shopify/connect"],
    ["POST", "/connections/razorpay/connect"],
    ["POST", "/connections/meta-ads/install"],
    ["PUT", "/legal-entities/primary"],
    ["POST", "/organization/members"],
  ];

  it.each(CAN)("FINANCE_MANAGER may %s %s", (method, path) => {
    expect(decideAccess("FINANCE_MANAGER", method, path).allowed).toBe(true);
  });

  it.each(CANNOT)("FINANCE_MANAGER may NOT %s %s", (method, path) => {
    expect(decideAccess("FINANCE_MANAGER", method, path).allowed).toBe(false);
  });

  it("every read is open to every role, which is why the demo was never showing less", () => {
    // The premise behind "open everything a paid account has": reads were
    // already open. If this ever stops being true, a demo visitor starts
    // seeing a smaller product than a customer, silently.
    for (const role of ["OWNER", "FINANCE_MANAGER", "ANALYST", "VIEWER", "EXTERNAL_CA"] as MembershipRole[]) {
      expect(decideAccess(role, "GET", "/metrics/revenue").allowed).toBe(true);
      expect(decideAccess(role, "GET", "/profitability").allowed).toBe(true);
    }
  });

  it("VIEWER cannot ask the AI, which is why the demo is not a VIEWER", () => {
    expect(decideAccess("VIEWER", "POST", "/ai/ask").allowed).toBe(false);
    expect(decideAccess("VIEWER", "GET", "/metrics/revenue").allowed).toBe(true);
  });
});
