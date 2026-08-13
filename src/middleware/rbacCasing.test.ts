import { describe, expect, it } from "vitest";
import { decideAccess } from "./rbac.js";
import { INGEST_LIMIT, limitFor } from "./rateLimit.js";

// Express 4 routes case-INSENSITIVELY by default; these policies matched
// case-SENSITIVELY. The gap was a privilege escalation, reproduced live against
// this repo's own Express before the fix.

describe("RBAC policy matching is case-insensitive", () => {
  const CREDENTIAL_WRITES = [
    "/connections/shopify/connect",
    "/connections/razorpay/connect",
    "/organization/members",
    "/legal-entities",
  ];

  it("refuses a FINANCE_MANAGER on credential writes however the path is cased", () => {
    for (const path of CREDENTIAL_WRITES) {
      for (const variant of [path, path.toUpperCase(), path.replace("/c", "/C").replace("/o", "/O").replace("/l", "/L")]) {
        const d = decideAccess("FINANCE_MANAGER", "POST", variant);
        expect(d.allowed, `${variant} must stay refused`).toBe(false);
      }
    }
  });

  it("still allows OWNER and ADMIN on those same paths", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      expect(decideAccess(role, "POST", "/connections/shopify/connect").allowed).toBe(true);
      expect(decideAccess(role, "POST", "/Connections/shopify/connect").allowed).toBe(true);
    }
  });

  it("keeps the sync carve-out working in any casing", () => {
    // FINANCE_MANAGER may trigger a sync — that exception must survive the
    // normalisation, not be collapsed into the credential rule.
    expect(decideAccess("FINANCE_MANAGER", "POST", "/connections/abc123/sync").allowed).toBe(true);
    expect(decideAccess("FINANCE_MANAGER", "POST", "/Connections/abc123/sync").allowed).toBe(true);
  });

  it("keeps read-like writes open to ANALYST in any casing", () => {
    expect(decideAccess("ANALYST", "POST", "/ai/ask").allowed).toBe(true);
    expect(decideAccess("ANALYST", "POST", "/AI/ask").allowed).toBe(true);
    expect(decideAccess("VIEWER", "POST", "/AI/ask").allowed).toBe(false);
  });

  it("does not accidentally widen anything: costs still refuse ANALYST", () => {
    expect(decideAccess("ANALYST", "POST", "/costs").allowed).toBe(false);
    expect(decideAccess("ANALYST", "POST", "/Costs").allowed).toBe(false);
    expect(decideAccess("ACCOUNTANT", "POST", "/costs").allowed).toBe(true);
  });
});

describe("rate-limit bucket selection is case-insensitive", () => {
  it("keeps the tight ingest ceiling on upload paths however cased", () => {
    // Same root cause: /Costs missed the prefix list and silently got the
    // 120/min write ceiling instead of the 20/min ingest one — on a route that
    // parses a 50 MB body.
    for (const p of ["/costs", "/Costs", "/COSTS", "/connections/bank", "/Connections/Bank"]) {
      expect(limitFor("POST", p), p).toBe(INGEST_LIMIT);
    }
  });
});
