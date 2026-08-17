import type { Request } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { bandOf, drain, minuteBucket, observe, resetForTest, routeOf } from "./requestMetrics.js";

// This middleware sits in front of every request in the app, so the two things
// worth pinning are that it cannot blow up memory (route cardinality) and that
// what it counts adds up.

beforeEach(() => {
  resetForTest();
});

describe("bandOf", () => {
  it("is inclusive at each upper bound", () => {
    expect(bandOf(10)).toBe("le10");
    expect(bandOf(11)).toBe("le25");
    expect(bandOf(5000)).toBe("le5000");
  });

  it("sends anything past the largest band to leInf", () => {
    expect(bandOf(5001)).toBe("leInf");
    expect(bandOf(120_000)).toBe("leInf");
  });

  it("puts a zero-millisecond response in the fastest band", () => {
    expect(bandOf(0)).toBe("le10");
  });
});

describe("minuteBucket", () => {
  it("floors to the minute", () => {
    expect(minuteBucket(new Date("2026-08-17T10:23:45.678Z")).toISOString()).toBe("2026-08-17T10:23:00.000Z");
  });

  it("puts two requests in the same minute in the same bucket", () => {
    const a = minuteBucket(new Date("2026-08-17T10:23:00.001Z"));
    const b = minuteBucket(new Date("2026-08-17T10:23:59.999Z"));
    expect(a.getTime()).toBe(b.getTime());
  });
});

describe("routeOf", () => {
  const req = (baseUrl: string, path: string | undefined) =>
    ({ baseUrl, route: path === undefined ? undefined : { path } }) as unknown as Request;

  it("joins the mount point to the route pattern", () => {
    expect(routeOf(req("/metrics", "/revenue"))).toBe("/metrics/revenue");
  });

  // THE CARDINALITY GUARANTEE. req.route.path holds the PATTERN, so a thousand
  // different connection ids collapse to one row instead of a thousand. If this
  // ever starts returning the resolved URL, this table grows without bound.
  it("keeps parameters as patterns, never as resolved values", () => {
    expect(routeOf(req("/connections", "/:id/sync"))).toBe("/connections/:id/sync");
  });

  it("collapses an unmatched request into one countable bucket", () => {
    // Not dropped: a flood of 404s is a real signal, and only countable if it
    // lands somewhere.
    expect(routeOf(req("", undefined))).toBe("(unmatched)");
  });

  it("does not produce two rows for a router root", () => {
    // A router mounted at /audit with a route at "/" is the same endpoint as
    // /audit, and must not be counted twice under two spellings.
    expect(routeOf(req("/audit", "/"))).toBe("/audit");
  });

  it("keeps the app root as /", () => {
    expect(routeOf(req("", "/"))).toBe("/");
  });
});

describe("observe", () => {
  const at = new Date("2026-08-17T10:23:30Z");

  it("folds requests on the same route and minute into one bucket", () => {
    observe({ at, route: "/metrics/revenue", method: "GET", status: 200, durationMs: 12, cache: "miss" });
    observe({ at, route: "/metrics/revenue", method: "GET", status: 200, durationMs: 8, cache: "hit" });

    const [bucket, ...rest] = drain();
    expect(rest).toHaveLength(0);
    expect(bucket!.count).toBe(2);
    expect(bucket!.totalMs).toBe(20);
    expect(bucket!.maxMs).toBe(12);
    expect(bucket!.cacheHit).toBe(1);
    expect(bucket!.cacheMiss).toBe(1);
    expect(bucket!.bands.le10).toBe(1); // the 8ms one
    expect(bucket!.bands.le25).toBe(1); // the 12ms one
  });

  it("separates methods on the same path", () => {
    observe({ at, route: "/costs", method: "GET", status: 200, durationMs: 5, cache: null });
    observe({ at, route: "/costs", method: "POST", status: 201, durationMs: 5, cache: null });
    expect(drain()).toHaveLength(2);
  });

  it("counts status classes, not statuses", () => {
    observe({ at, route: "/x", method: "GET", status: 204, durationMs: 1, cache: null });
    observe({ at, route: "/x", method: "GET", status: 301, durationMs: 1, cache: null });
    observe({ at, route: "/x", method: "GET", status: 404, durationMs: 1, cache: null });
    observe({ at, route: "/x", method: "GET", status: 503, durationMs: 1, cache: null });

    const bucket = drain()[0]!;
    expect(bucket.status2xx).toBe(1);
    expect(bucket.status3xx).toBe(1);
    expect(bucket.status4xx).toBe(1);
    expect(bucket.status5xx).toBe(1);
    expect(bucket.count).toBe(4);
  });

  it("does not count a cache outcome when there was no cache in front", () => {
    // Zero hits and zero misses is how a reader tells "uncached route" from
    // "cache is missing every time" — two opposite conclusions.
    observe({ at, route: "/health", method: "GET", status: 200, durationMs: 1, cache: null });
    const bucket = drain()[0]!;
    expect(bucket.cacheHit).toBe(0);
    expect(bucket.cacheMiss).toBe(0);
  });

  it("drains empty, so a flush cannot double-count", () => {
    observe({ at, route: "/x", method: "GET", status: 200, durationMs: 1, cache: null });
    expect(drain()).toHaveLength(1);
    expect(drain()).toHaveLength(0);
  });

  it("keeps different minutes apart", () => {
    observe({ at, route: "/x", method: "GET", status: 200, durationMs: 1, cache: null });
    observe({ at: new Date("2026-08-17T10:24:30Z"), route: "/x", method: "GET", status: 200, durationMs: 1, cache: null });
    expect(drain()).toHaveLength(2);
  });
});
