import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A cache in front of money figures has one failure mode that outweighs every
// millisecond it saves: answering a request with somebody else's numbers.
// These tests are about the key, not the speed.
//
// The middleware is driven directly rather than over HTTP — this repo has no
// HTTP-test dependency, and the whole surface here is (req, res, next), so a
// fake trio exercises every branch without a server.

const store = new Map<string, string>();
const writes: Array<{ organizationId: string; variant: string; body: string }> = [];

vi.mock("../lib/orgReadCache.js", () => ({
  readCachedResponse: async (organizationId: string, variant: string) =>
    store.get(`${organizationId}::${variant}`) ?? null,
  writeCachedResponse: async (organizationId: string, variant: string, body: string) => {
    writes.push({ organizationId, variant, body });
    store.set(`${organizationId}::${variant}`, body);
  },
}));

// The durable store is mocked too, and must be: without this, every miss in
// these tests makes a real Postgres round trip, which is both slow and outside
// what this file is about. The durable layer has its own tests below.
const durable = new Map<string, string>();
const durableWrites: Array<{ organizationId: string; variant: string }> = [];

vi.mock("../lib/precomputedStore.js", () => ({
  isPersistable: (name: string) => name !== "status" && name !== "cash-forecast" && name !== "reconciliation-summary",
  readPrecomputed: async (organizationId: string, variant: string) =>
    durable.get(`${organizationId}::${variant}`) ?? null,
  writePrecomputed: (organizationId: string, variant: string, body: string) => {
    durableWrites.push({ organizationId, variant });
    durable.set(`${organizationId}::${variant}`, body);
  },
}));

const { calcCache } = await import("./calcCache.js");

interface Ctx {
  organizationId?: string;
  legalEntityId?: string | null;
  entityCount?: number;
  query?: Record<string, string>;
  method?: string;
}

interface Outcome {
  cacheHeader: string | undefined;
  ranHandler: boolean;
  status: number;
  text: string | undefined;
  json: unknown;
}

/** One request through the middleware, then through a handler that answers
 *  with `body` (and records that it ran at all). */
async function call(mw: ReturnType<typeof calcCache>, ctx: Ctx, body: unknown, status = 200): Promise<Outcome> {
  const headers: Record<string, string> = {};
  let ranHandler = false;
  let sentText: string | undefined;
  let sentJson: unknown;

  const req = {
    method: ctx.method ?? "GET",
    query: ctx.query ?? {},
    auth: ctx.organizationId ? { organizationId: ctx.organizationId } : undefined,
    entityScope:
      ctx.legalEntityId === undefined
        ? undefined
        : { legalEntityId: ctx.legalEntityId, entityCount: ctx.entityCount ?? 1 },
  } as unknown as Request;

  const res = {
    statusCode: status,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    send: (payload: string) => {
      sentText = payload;
    },
    json: (payload: unknown) => {
      sentJson = payload;
      sentText = JSON.stringify(payload);
      return res;
    },
  } as unknown as Response;

  await new Promise<void>((resolve) => {
    const next: NextFunction = () => {
      ranHandler = true;
      // Stands in for the route handler, which always answers with res.json.
      res.json(body);
      resolve();
    };
    mw(req, res, next);
    // A cache hit answers without calling next(); give that path a tick.
    setTimeout(resolve, 0);
  });

  return { cacheHeader: headers["x-calc-cache"], ranHandler, status, text: sentText, json: sentJson };
}

beforeEach(() => {
  durable.clear();
  durableWrites.length = 0;
  store.clear();
  writes.length = 0;
});

describe("calcCache never lets one scope answer for another", () => {
  it("does not serve one organisation's body to another", async () => {
    const mw = calcCache("m");
    const a = await call(mw, { organizationId: "org-A", legalEntityId: null }, { who: "A" });
    const b = await call(mw, { organizationId: "org-B", legalEntityId: null }, { who: "B" });

    expect(a.cacheHeader).toBe("miss");
    // Same route, same query, same scope shape, different organisation. Were
    // the organisation not in the key this would be a hit and org B would be
    // reading org A's money.
    expect(b.cacheHeader).toBe("miss");
    expect(b.json).toEqual({ who: "B" });
  });

  it("does not serve one legal entity's body to another", async () => {
    const mw = calcCache("m");
    const first = await call(mw, { organizationId: "org", legalEntityId: "ent-1", entityCount: 2 }, { e: 1 });
    const second = await call(mw, { organizationId: "org", legalEntityId: "ent-2", entityCount: 2 }, { e: 2 });

    expect(first.cacheHeader).toBe("miss");
    expect(second.cacheHeader).toBe("miss");
    expect(second.json).toEqual({ e: 2 });
  });

  it("treats a changed entityCount as a different question", async () => {
    // legalEntityId=null means "the whole organisation", and what that covers
    // changes the moment a second entity exists. A body computed when there
    // was one entity must not answer once there are two.
    const mw = calcCache("m");
    await call(mw, { organizationId: "org", legalEntityId: null, entityCount: 1 }, { n: 1 });
    const after = await call(mw, { organizationId: "org", legalEntityId: null, entityCount: 2 }, { n: 2 });
    expect(after.cacheHeader).toBe("miss");
  });

  it("keeps two endpoints apart even when their scope and query match", async () => {
    const ladder = calcCache("revenue-ladder");
    const margin = calcCache("contribution-margin");
    await call(ladder, { organizationId: "org", legalEntityId: null }, { from: "ladder" });
    const other = await call(margin, { organizationId: "org", legalEntityId: null }, { from: "margin" });
    expect(other.cacheHeader).toBe("miss");
    expect(other.json).toEqual({ from: "margin" });
  });

  it("separates windows, and reunites the same window written two ways", async () => {
    const mw = calcCache("m");
    await call(mw, { organizationId: "org", legalEntityId: null, query: { from: "2026-01-01", to: "2026-03-31" } }, { q: 1 });

    const otherWindow = await call(
      mw,
      { organizationId: "org", legalEntityId: null, query: { from: "2026-04-01", to: "2026-06-30" } },
      { q: 2 }
    );
    expect(otherWindow.cacheHeader).toBe("miss");

    // Same window, parameters in the other order: one entry, not two.
    const reordered = await call(
      mw,
      { organizationId: "org", legalEntityId: null, query: { to: "2026-03-31", from: "2026-01-01" } },
      { q: 999 }
    );
    expect(reordered.cacheHeader).toBe("hit");
    expect(reordered.ranHandler).toBe(false);
    expect(JSON.parse(reordered.text!)).toEqual({ q: 1 });
  });
});

describe("calcCache returns the same answer it stored", () => {
  it("replays a hit byte-for-byte, money still strings", async () => {
    const body = { netRevenue: "123456789012", nested: { refunds: "-1", zero: "0" }, list: [1, "2", null] };
    const mw = calcCache("m");

    const miss = await call(mw, { organizationId: "org", legalEntityId: null }, body);
    const hit = await call(mw, { organizationId: "org", legalEntityId: null }, { should: "not be used" });

    expect(miss.cacheHeader).toBe("miss");
    expect(hit.cacheHeader).toBe("hit");
    expect(hit.text).toBe(miss.text); // byte-identical, not merely deep-equal
    expect(JSON.parse(hit.text!)).toEqual(body);
    expect(hit.ranHandler).toBe(false); // the handler really did not run again
  });

  it("caches nothing for a non-200, so an error cannot outlive its incident", async () => {
    const mw = calcCache("m");
    await call(mw, { organizationId: "org", legalEntityId: null }, { error: "upstream down" }, 503);
    expect(writes).toHaveLength(0);
  });

  it("declines to cache when there is no organisation to scope a key to", async () => {
    const mw = calcCache("m");
    const res = await call(mw, { legalEntityId: null }, { ok: true });
    expect(res.ranHandler).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("leaves non-GET requests alone", async () => {
    const mw = calcCache("m");
    const res = await call(mw, { organizationId: "org", legalEntityId: null, method: "POST" }, { ok: true });
    expect(res.ranHandler).toBe(true);
    expect(writes).toHaveLength(0);
  });
});

// The durable layer. Redis' 60s TTL means an expensive metric is recomputed
// every minute for as long as anyone watches the page; these rows survive that
// expiry, so what matters is that they are written for the right things, read
// only when Redis has nothing, and never written for anything a clock can move.
describe("calcCache durable layer", () => {
  it("serves from the durable store when Redis has expired, and refills Redis", async () => {
    const mw = calcCache("contribution-margin");
    const ctx = { organizationId: "org", legalEntityId: null };

    const miss = await call(mw, ctx, { cm3: "1234" });
    expect(miss.cacheHeader).toBe("miss");
    expect(durableWrites).toHaveLength(1);

    // Exactly what a TTL expiry looks like: Redis empty, the row still there.
    store.clear();

    const warm = await call(mw, ctx, { should: "not be computed" });
    expect(warm.ranHandler).toBe(false);
    // Distinguishable from a Redis hit, so the two layers can be told apart
    // from outside the server.
    expect(warm.cacheHeader).toBe("warm");
    expect(warm.text).toBe(JSON.stringify({ cm3: "1234" }));
    // Refilled, so the next sixty seconds do not touch Postgres either.
    expect(store.size).toBe(1);
  });

  it("never persists a clock-driven metric", async () => {
    // These move with the passage of time and no write, so nothing would ever
    // invalidate a durable row. Redis' TTL is what keeps them honest.
    for (const name of ["status", "cash-forecast", "reconciliation-summary"]) {
      durableWrites.length = 0;
      const out = await call(calcCache(name), { organizationId: "org", legalEntityId: null }, { v: name });
      expect(out.cacheHeader).toBe("miss");
      expect(durableWrites, `${name} must not be persisted`).toHaveLength(0);
    }
  });

  it("never persists a non-200", async () => {
    await call(calcCache("revenue"), { organizationId: "org", legalEntityId: null }, { error: "down" }, 503);
    expect(durableWrites).toHaveLength(0);
  });

  it("keeps organisations apart in the durable store too", async () => {
    const mw = calcCache("revenue");
    await call(mw, { organizationId: "org-A", legalEntityId: null }, { who: "A" });
    store.clear();
    const b = await call(mw, { organizationId: "org-B", legalEntityId: null }, { who: "B" });
    // org-B must compute its own answer, not inherit A's durable row.
    expect(b.ranHandler).toBe(true);
    expect(b.cacheHeader).toBe("miss");
  });
});
