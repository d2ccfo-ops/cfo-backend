import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The one door in this API that opens onto every tenant at once. These tests
// are about who it refuses, and about the fact that it refuses INDISTINGUISHABLY
// from a route that does not exist.

let currentUserId: string | null = null;

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: currentUserId }),
}));

/** Load the module fresh with a given allowlist — it parses env at import. */
async function load(allowlist: string | undefined) {
  vi.resetModules();
  vi.doMock("../config/env.js", () => ({ env: { INTERNAL_ADMIN_USER_IDS: allowlist } }));
  return await import("./requireSuperAdmin.js");
}

interface Outcome {
  status: number | null;
  body: unknown;
  passed: boolean;
}

function run(mw: (req: Request, res: Response, next: NextFunction) => void): Outcome {
  const out: Outcome = { status: null, body: undefined, passed: false };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
      return this;
    },
  } as unknown as Response;
  mw({ originalUrl: "/internal/overview", method: "GET" } as Request, res, () => {
    out.passed = true;
  });
  return out;
}

beforeEach(() => {
  currentUserId = null;
});

describe("when the console is not configured", () => {
  it("404s even for a signed-in user", async () => {
    const { requireSuperAdmin, internalConsoleEnabled } = await load(undefined);
    currentUserId = "user_anyone";
    expect(internalConsoleEnabled()).toBe(false);
    expect(run(requireSuperAdmin)).toEqual({ status: 404, body: { error: "not_found" }, passed: false });
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
});

describe("when the console is configured", () => {
  it("lets an allowlisted user through", async () => {
    const { requireSuperAdmin } = await load("user_founder");
    currentUserId = "user_founder";
    expect(run(requireSuperAdmin).passed).toBe(true);
  });

  it("accepts a comma-separated list with whitespace", async () => {
    const { requireSuperAdmin } = await load("user_a, user_b ,user_c");
    currentUserId = "user_b";
    expect(run(requireSuperAdmin).passed).toBe(true);
  });

  // 404 rather than 403, deliberately. A 403 confirms the console exists and
  // that the caller merely has the wrong account, which is the one fact worth
  // not confirming on an internet-facing endpoint.
  it("404s a signed-in user who is not on the list — never 403", async () => {
    const { requireSuperAdmin } = await load("user_founder");
    currentUserId = "user_someone_else";
    const outcome = run(requireSuperAdmin);
    expect(outcome.status).toBe(404);
    expect(outcome.passed).toBe(false);
  });

  it("404s an unauthenticated caller", async () => {
    const { requireSuperAdmin } = await load("user_founder");
    currentUserId = null;
    expect(run(requireSuperAdmin)).toEqual({ status: 404, body: { error: "not_found" }, passed: false });
  });

  it("refuses a caller whose id merely contains an allowlisted id", async () => {
    // Set membership, not substring matching. "user_founder_evil" must not
    // inherit "user_founder"'s access.
    const { requireSuperAdmin } = await load("user_founder");
    currentUserId = "user_founder_evil";
    expect(run(requireSuperAdmin).passed).toBe(false);
  });

  it("gives the same body on every refusal, so the reason cannot be inferred", async () => {
    const { requireSuperAdmin } = await load("user_founder");

    currentUserId = null;
    const unauthenticated = run(requireSuperAdmin);
    currentUserId = "user_someone_else";
    const notAllowed = run(requireSuperAdmin);

    expect(unauthenticated.status).toBe(notAllowed.status);
    expect(unauthenticated.body).toEqual(notAllowed.body);
  });
});
