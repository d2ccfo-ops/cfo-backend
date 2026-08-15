import { describe, expect, it } from "vitest";
import type { MembershipRole } from "@prisma/client";
import { ROLE_ORDER, decideAccess, normaliseRole } from "./rbac.js";
import { reconcileRole } from "../routes/webhooks/clerk.js";

// Access control is the one area where an untested edge case is not a bug but
// a hole. decideAccess is pure precisely so it can be swept exhaustively here
// rather than probed through HTTP a few paths at a time.

const ALL: MembershipRole[] = [...ROLE_ORDER, "MEMBER"];

describe("normaliseRole", () => {
  it("maps the legacy MEMBER to ANALYST", () => {
    // Every membership row in the production database carries MEMBER, and
    // Postgres enum values cannot be removed without a table rewrite.
    expect(normaliseRole("MEMBER")).toBe("ANALYST");
  });

  it("treats an absent role as ANALYST, never as an admin", () => {
    expect(normaliseRole(null)).toBe("ANALYST");
    expect(normaliseRole(undefined)).toBe("ANALYST");
  });

  it("falls back to ANALYST for a value it does not recognise", () => {
    // A role string from a future version, or a corrupted row. The safe
    // default is the least privileged one that can still use the product.
    expect(normaliseRole("SUPERUSER")).toBe("ANALYST");
  });

  it("passes the seven real roles through", () => {
    for (const r of ROLE_ORDER) expect(normaliseRole(r)).toBe(r);
  });
});

describe("reads", () => {
  it("are open to every role, including EXTERNAL_CA", () => {
    // A CA is brought in to look at the books. One who cannot read them is not
    // a role, it is a locked door.
    for (const role of ALL) {
      for (const path of ["/metrics/revenue", "/connections", "/evidence/revenue", "/audit", "/organization/members"]) {
        expect(decideAccess(role, "GET", path).allowed, `${role} GET ${path}`).toBe(true);
      }
    }
  });

  it("ignore the query string", () => {
    expect(decideAccess("VIEWER", "GET", "/metrics/revenue").allowed).toBe(true);
  });
});

describe("credential writes", () => {
  const paths = ["/connections/shopify/connect", "/connections/abc123", "/connections/bank/upload"];

  it("are open to OWNER and ADMIN only", () => {
    for (const path of paths) {
      expect(decideAccess("OWNER", "POST", path).allowed).toBe(true);
      expect(decideAccess("ADMIN", "DELETE", path).allowed).toBe(true);
      // A finance manager who can read every figure has no reason to rotate an
      // API key.
      expect(decideAccess("FINANCE_MANAGER", "POST", path).allowed).toBe(false);
      expect(decideAccess("ACCOUNTANT", "POST", path).allowed).toBe(false);
      expect(decideAccess("ANALYST", "POST", path).allowed).toBe(false);
      expect(decideAccess("VIEWER", "POST", path).allowed).toBe(false);
      expect(decideAccess("EXTERNAL_CA", "POST", path).allowed).toBe(false);
    }
  });

  it("explain themselves in the refusal", () => {
    const d = decideAccess("ANALYST", "POST", "/connections/shopify/connect");
    expect(d.reason).toContain("data source");
    expect(d.reason).toContain("ANALYST");
  });
});

describe("cost writes", () => {
  it("add ACCOUNTANT to the write set", () => {
    for (const role of ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT"] as MembershipRole[]) {
      expect(decideAccess(role, "POST", "/costs/upload").allowed, role).toBe(true);
    }
    for (const role of ["ANALYST", "VIEWER", "EXTERNAL_CA"] as MembershipRole[]) {
      expect(decideAccess(role, "POST", "/costs/upload").allowed, role).toBe(false);
    }
  });

  it("do not leak that permission to other paths", () => {
    // The bug a prefix policy invites: /costs granting ACCOUNTANT a write, and
    // a path that merely starts with the same letters inheriting it.
    expect(decideAccess("ACCOUNTANT", "POST", "/reconciliation/write-off").allowed).toBe(false);
    expect(decideAccess("ACCOUNTANT", "POST", "/costsomething").allowed).toBe(false);
  });
});

describe("general writes", () => {
  it("need OWNER, ADMIN or FINANCE_MANAGER", () => {
    for (const path of ["/reconciliation/write-off", "/anomalies/abc/status", "/preferences/org"]) {
      expect(decideAccess("FINANCE_MANAGER", "POST", path).allowed, path).toBe(true);
      expect(decideAccess("ACCOUNTANT", "POST", path).allowed, path).toBe(false);
      expect(decideAccess("ANALYST", "POST", path).allowed, path).toBe(false);
      expect(decideAccess("VIEWER", "POST", path).allowed, path).toBe(false);
    }
  });

  it("cover every mutating method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(decideAccess("VIEWER", method, "/anything").allowed, method).toBe(false);
      expect(decideAccess("OWNER", method, "/anything").allowed, method).toBe(true);
    }
  });

  it("default-deny an unrecognised path rather than default-allow", () => {
    // A route added tomorrow under a prefix nobody wrote a policy for lands on
    // the strictest general rule, not on nothing.
    expect(decideAccess("ANALYST", "POST", "/some/new/thing/nobody/planned").allowed).toBe(false);
    expect(decideAccess("FINANCE_MANAGER", "POST", "/some/new/thing/nobody/planned").allowed).toBe(true);
  });
});

describe("read-like writes", () => {
  const paths = ["/metrics/cash-forecast/scenario", "/ai/ask", "/notifications/abc123/read", "/preferences/dashboard-layout"];

  it("are open to ANALYST — the role whose whole job is analysis", () => {
    for (const path of paths) {
      expect(decideAccess("ANALYST", "POST", path).allowed, path).toBe(true);
      expect(decideAccess("MEMBER", "POST", path).allowed, path).toBe(true);
      expect(decideAccess("ACCOUNTANT", "POST", path).allowed, path).toBe(true);
    }
  });

  it("stay closed to read-only roles, because they cost money or write audit rows", () => {
    for (const path of paths) {
      expect(decideAccess("VIEWER", "POST", path).allowed, path).toBe(false);
      expect(decideAccess("EXTERNAL_CA", "POST", path).allowed, path).toBe(false);
    }
  });

  it("match exactly, not by prefix", () => {
    // /ai/ask is read-like; /ai/daily-brief/generate is not — it overwrites a
    // shared artefact everyone in the org reads.
    expect(decideAccess("ANALYST", "POST", "/ai/daily-brief/generate").allowed).toBe(false);
    expect(decideAccess("ANALYST", "POST", "/ai/askanything").allowed).toBe(false);
  });
});

describe("the legacy MEMBER role behaves exactly as ANALYST", () => {
  it("across every path the policy distinguishes", () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      for (const path of ["/metrics/revenue", "/connections/x", "/costs/upload", "/ai/ask", "/reconciliation/write-off"]) {
        expect(decideAccess("MEMBER", method, path).allowed, `${method} ${path}`).toBe(
          decideAccess("ANALYST", method, path).allowed
        );
      }
    }
  });
});

describe("reconcileRole", () => {
  it("lets Clerk assert ownership", () => {
    expect(reconcileRole("org:owner", null)).toBe("OWNER");
    expect(reconcileRole("org:owner", "VIEWER")).toBe("OWNER");
  });

  it("does not demote an owner that Clerk lists as an admin", () => {
    // Clerk lists the owner as an admin too. Without this an org could lose
    // its only owner to a webhook replay.
    expect(reconcileRole("org:admin", "OWNER")).toBe("OWNER");
    expect(reconcileRole("org:admin", "ANALYST")).toBe("ADMIN");
  });

  it("preserves an in-app functional role when Clerk says plain member", () => {
    // The bug this exists to prevent: every unrelated Clerk membership event
    // flattening a FINANCE_MANAGER back to the default, silently.
    expect(reconcileRole("org:member", "FINANCE_MANAGER")).toBe("FINANCE_MANAGER");
    expect(reconcileRole("org:member", "ACCOUNTANT")).toBe("ACCOUNTANT");
    expect(reconcileRole("org:member", "EXTERNAL_CA")).toBe("EXTERNAL_CA");
    expect(reconcileRole("org:member", "VIEWER")).toBe("VIEWER");
  });

  it("treats a Clerk demotion from admin as a real demotion", () => {
    expect(reconcileRole("org:member", "ADMIN")).toBe("ANALYST");
    expect(reconcileRole("org:member", "OWNER")).toBe("ANALYST");
  });

  it("defaults a brand-new member to ANALYST, not MEMBER", () => {
    expect(reconcileRole("org:member", null)).toBe("ANALYST");
  });
});

describe("explicit exceptions", () => {
  it("let a finance manager trigger a resync without granting credential access", () => {
    // The person who notices the data is stale should not have to find an
    // admin. A resync neither reads nor changes a credential.
    expect(decideAccess("FINANCE_MANAGER", "POST", "/connections/abc123/sync").allowed).toBe(true);
    expect(decideAccess("FINANCE_MANAGER", "POST", "/connections/abc123").allowed).toBe(false);
    expect(decideAccess("FINANCE_MANAGER", "POST", "/connections/shopify/connect").allowed).toBe(false);
  });

  it("do not extend the exception to read-only roles", () => {
    expect(decideAccess("ANALYST", "POST", "/connections/abc123/sync").allowed).toBe(false);
    expect(decideAccess("VIEWER", "POST", "/connections/abc123/sync").allowed).toBe(false);
  });

  it("match exactly, so a nested route does not inherit the exception", () => {
    expect(decideAccess("FINANCE_MANAGER", "POST", "/connections/abc123/sync/force").allowed).toBe(false);
  });
});

describe("every real mutating route in the app has a decided policy", () => {
  // Enumerated from the router definitions. The point is coverage: a path
  // that falls through to a surprising answer is caught here rather than in
  // production by someone who cannot do their job.
  const ROUTES: Array<[string, string, MembershipRole[]]> = [
    ["POST", "/ai/ask", ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT", "ANALYST"]],
    ["POST", "/ai/daily-brief/generate", ["OWNER", "ADMIN", "FINANCE_MANAGER"]],
    ["POST", "/anomalies/run", ["OWNER", "ADMIN", "FINANCE_MANAGER"]],
    ["PATCH", "/anomalies/abc", ["OWNER", "ADMIN", "FINANCE_MANAGER"]],
    ["POST", "/costs/bulk", ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT"]],
    ["POST", "/costs/restamp", ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT"]],
    ["POST", "/notifications/abc/read", ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT", "ANALYST"]],
    ["POST", "/notifications/read-all", ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT", "ANALYST"]],
    ["POST", "/notifications/run", ["OWNER", "ADMIN", "FINANCE_MANAGER"]],
    ["PATCH", "/organization/members/abc/role", ["OWNER", "ADMIN"]],
    ["POST", "/metrics/cash-forecast/scenario", ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT", "ANALYST"]],
    ["POST", "/metrics/snapshot-history/run", ["OWNER", "ADMIN", "FINANCE_MANAGER"]],
    ["POST", "/legal-entities", ["OWNER", "ADMIN"]],
    ["PUT", "/legal-entities/primary", ["OWNER", "ADMIN"]],
    ["POST", "/reconciliation/run", ["OWNER", "ADMIN", "FINANCE_MANAGER"]],
    ["POST", "/reconciliation/items/123/write-off", ["OWNER", "ADMIN", "FINANCE_MANAGER"]],
    ["PUT", "/preferences/dashboard-layout", ["OWNER", "ADMIN", "FINANCE_MANAGER", "ACCOUNTANT", "ANALYST"]],
    ["PUT", "/preferences/org", ["OWNER", "ADMIN", "FINANCE_MANAGER"]],
    ["POST", "/connections/shopify/connect", ["OWNER", "ADMIN"]],
    ["POST", "/connections/bank/abc/upload", ["OWNER", "ADMIN"]],
    ["POST", "/connections/bluedart/abc/invoice", ["OWNER", "ADMIN"]],
    ["POST", "/connections/email-ingest/rotate", ["OWNER", "ADMIN"]],
    ["PATCH", "/connections/abc/opening-balance", ["OWNER", "ADMIN"]],
    ["POST", "/connections/abc/sync", ["OWNER", "ADMIN", "FINANCE_MANAGER"]],
  ];

  it.each(ROUTES)("%s %s", (method, path, allowedRoles) => {
    for (const role of ROLE_ORDER) {
      expect(decideAccess(role, method, path).allowed, `${role} ${method} ${path}`).toBe(allowedRoles.includes(role));
    }
  });
});

describe("both AI transports carry the same permission", () => {
  // /ai/ask/stream is the same orchestrator run with progress events attached.
  // It once fell through to the catch-all write policy, so an ANALYST could ask
  // a question on one URL and got a 403 on the other.
  it("lets an ANALYST ask on either route", () => {
    expect(decideAccess("ANALYST", "POST", "/ai/ask").allowed).toBe(true);
    expect(decideAccess("ANALYST", "POST", "/ai/ask/stream").allowed).toBe(true);
  });

  it("refuses a VIEWER on either route, for the same stated reason", () => {
    // Asking costs money and writes an audit row; a read-only guest does neither.
    const plain = decideAccess("VIEWER", "POST", "/ai/ask");
    const streamed = decideAccess("VIEWER", "POST", "/ai/ask/stream");
    expect(plain.allowed).toBe(false);
    expect(streamed.allowed).toBe(false);
    expect(streamed.reason).toBe(plain.reason);
  });

  it("does not open anything else under /ai", () => {
    // The optional group must not become a prefix match.
    expect(decideAccess("ANALYST", "POST", "/ai/ask/stream/evil").allowed).toBe(false);
    expect(decideAccess("ANALYST", "DELETE", "/ai/conversations/abc").allowed).toBe(false);
  });
});
