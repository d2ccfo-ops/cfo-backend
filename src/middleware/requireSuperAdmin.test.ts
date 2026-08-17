import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The one door in this API that opens onto every tenant at once. These tests
// are about who it refuses, and about the fact that it refuses INDISTINGUISHABLY
// from a route that does not exist.

let currentUserId: string | null = null;

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: currentUserId }),
}));

interface DbBehaviour {
  /** Rows the operator table returns. `revokedAt: null` means an active grant. */
  rows?: Array<{ clerkUserId: string }>;
  /** When set, the operator lookup throws instead of answering. */
  fail?: boolean;
}

/**
 * Load the module fresh with a given allowlist and database behaviour.
 *
 * Fresh every time because both the environment allowlist and the operator
 * cache are module state: a cached grant from a previous test would make the
 * next one pass for the wrong reason.
 */
async function load(allowlist: string | undefined, db: DbBehaviour = {}) {
  vi.resetModules();
  vi.doMock("../config/env.js", () => ({ env: { INTERNAL_ADMIN_USER_IDS: allowlist } }));
  vi.doMock("../lib/prisma.js", () => ({
    prisma: {
      internalOperator: {
        findMany: () =>
          db.fail
            ? Promise.reject(new Error("connection refused"))
            : Promise.resolve(db.rows ?? []),
      },
    },
  }));
  return await import("./requireSuperAdmin.js");
}

interface Outcome {
  status: number | null;
  body: unknown;
  passed: boolean;
}

/**
 * Runs the middleware and resolves on whichever outcome it reaches.
 *
 * Resolving on the outcome rather than waiting a fixed number of ticks matters
 * now that authorisation can touch the database: a tick count that happens to
 * be enough today would silently start asserting on a half-finished request the
 * moment another await appeared in the path.
 */
function run(mw: (req: Request, res: Response, next: NextFunction) => void): Promise<Outcome> {
  return new Promise((resolve) => {
    const out: Outcome = { status: null, body: undefined, passed: false };
    const res = {
      status(code: number) {
        out.status = code;
        return this;
      },
      json(body: unknown) {
        out.body = body;
        resolve(out);
        return this;
      },
    } as unknown as Response;
    mw({ originalUrl: "/internal/overview", method: "GET" } as Request, res, () => {
      out.passed = true;
      resolve(out);
    });
  });
}

beforeEach(() => {
  currentUserId = null;
});

describe("when the console is not configured", () => {
  it("404s even for a signed-in user", async () => {
    const { requireSuperAdmin, internalConsoleEnabled } = await load(undefined);
    currentUserId = "user_anyone";
    expect(internalConsoleEnabled()).toBe(false);
    expect(await run(requireSuperAdmin)).toEqual({ status: 404, body: { error: "not_found" }, passed: false });
  });

  it("treats an empty string as not configured", async () => {
    const { internalConsoleEnabled } = await load("");
    expect(internalConsoleEnabled()).toBe(false);
  });

  it("treats a list of only separators and blanks as not configured", async () => {
    // " , , " is a plausible result of editing an env file down to nothing, and
    // must not produce an allowlist containing empty-string — which would then
    // match a caller whose userId failed to resolve.
    const { internalConsoleEnabled } = await load(" , ,  ");
    expect(internalConsoleEnabled()).toBe(false);
  });

  // The environment list is the feature switch, and database grants are additive
  // ON TOP of it — never a way to open a console nobody turned on.
  it("404s a database-granted operator when the environment list is empty", async () => {
    const { requireSuperAdmin } = await load("", { rows: [{ clerkUserId: "user_granted" }] });
    currentUserId = "user_granted";
    const outcome = await run(requireSuperAdmin);
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBe(404);
  });
});

describe("when the console is configured", () => {
  it("lets an allowlisted user through", async () => {
    const { requireSuperAdmin } = await load("user_founder");
    currentUserId = "user_founder";
    expect((await run(requireSuperAdmin)).passed).toBe(true);
  });

  it("accepts a comma-separated list with whitespace", async () => {
    const { requireSuperAdmin } = await load("user_a, user_b ,user_c");
    currentUserId = "user_b";
    expect((await run(requireSuperAdmin)).passed).toBe(true);
  });

  // 404 rather than 403, deliberately. A 403 confirms the console exists and
  // that the caller merely has the wrong account, which is the one fact worth
  // not confirming on an internet-facing endpoint.
  it("404s a signed-in user who is not on the list — never 403", async () => {
    const { requireSuperAdmin } = await load("user_founder");
    currentUserId = "user_someone_else";
    const outcome = await run(requireSuperAdmin);
    expect(outcome.status).toBe(404);
    expect(outcome.passed).toBe(false);
  });

  it("404s an unauthenticated caller", async () => {
    const { requireSuperAdmin } = await load("user_founder");
    currentUserId = null;
    expect(await run(requireSuperAdmin)).toEqual({ status: 404, body: { error: "not_found" }, passed: false });
  });

  it("refuses a caller whose id merely contains an allowlisted id", async () => {
    // Set membership, not substring matching. "user_founder_evil" must not
    // inherit "user_founder"'s access.
    const { requireSuperAdmin } = await load("user_founder");
    currentUserId = "user_founder_evil";
    expect((await run(requireSuperAdmin)).passed).toBe(false);
  });

  it("gives the same body on every refusal, so the reason cannot be inferred", async () => {
    const { requireSuperAdmin } = await load("user_founder");

    currentUserId = null;
    const unauthenticated = await run(requireSuperAdmin);
    currentUserId = "user_someone_else";
    const notAllowed = await run(requireSuperAdmin);

    expect(unauthenticated.status).toBe(notAllowed.status);
    expect(unauthenticated.body).toEqual(notAllowed.body);
  });
});

describe("database-granted operators", () => {
  it("lets an active grant through", async () => {
    const { requireSuperAdmin } = await load("user_founder", { rows: [{ clerkUserId: "user_ops" }] });
    currentUserId = "user_ops";
    expect((await run(requireSuperAdmin)).passed).toBe(true);
  });

  // Revocation is a revokedAt timestamp rather than a delete, so the query that
  // feeds authorisation must filter on it. If that filter were ever dropped, a
  // revoked operator would keep full cross-tenant access and every other test
  // here would still pass — which is why this one asserts on the shape the
  // lookup returns rather than trusting the query.
  it("refuses someone the lookup does not return as active", async () => {
    const { requireSuperAdmin } = await load("user_founder", { rows: [{ clerkUserId: "user_still_here" }] });
    currentUserId = "user_revoked";
    expect((await run(requireSuperAdmin)).passed).toBe(false);
  });

  // Fails CLOSED. An unreadable operator table must never mean "let everyone in".
  it("refuses a database-granted operator when the lookup fails", async () => {
    const { requireSuperAdmin } = await load("user_founder", { fail: true });
    currentUserId = "user_ops";
    const outcome = await run(requireSuperAdmin);
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBe(404);
  });

  // ...but break glass still works. This is the whole reason the environment
  // list is checked first and without touching the database: a Postgres outage
  // must leave the console reachable by exactly the people who can fix it.
  it("still admits an environment operator when the database is down", async () => {
    const { requireSuperAdmin } = await load("user_founder", { fail: true });
    currentUserId = "user_founder";
    expect((await run(requireSuperAdmin)).passed).toBe(true);
  });
});
