import { describe, expect, it } from "vitest";
import { addHistogram, emptyHistogram, quantileFromHistogram } from "./shared.js";

// The whole reason request_metrics stores bands instead of a mean is that
// percentiles do not average. These tests pin that they also do not lie.

const h = (partial: Partial<ReturnType<typeof emptyHistogram>>) => ({ ...emptyHistogram(), ...partial });

describe("quantileFromHistogram", () => {
  it("returns null for an empty histogram rather than zero", () => {
    // Zero would render as "this route answers instantly", which is the
    // opposite of "this route has no traffic".
    expect(quantileFromHistogram(emptyHistogram(), 0.95)).toEqual({ ms: null, saturated: false });
  });

  it("puts the median inside the band that contains it", () => {
    // 100 requests, all between 25ms and 50ms.
    const q = quantileFromHistogram(h({ le50: 100 }), 0.5);
    expect(q.ms).toBeGreaterThan(25);
    expect(q.ms).toBeLessThanOrEqual(50);
    expect(q.saturated).toBe(false);
  });

  // The case that makes a mean useless: 95% fast, 5% catastrophic. The mean of
  // this distribution is about 260ms and looks fine; p95 is the number that
  // tells the truth.
  it("finds the slow tail a mean would hide", () => {
    const fastAndSlow = h({ le10: 950, leInf: 50 });
    const p50 = quantileFromHistogram(fastAndSlow, 0.5);
    const p95 = quantileFromHistogram(fastAndSlow, 0.95);
    const p99 = quantileFromHistogram(fastAndSlow, 0.99);

    expect(p50.ms).toBeLessThanOrEqual(10);
    expect(p50.saturated).toBe(false);
    // p95 sits exactly at the boundary into the unbounded band.
    expect(p99.saturated).toBe(true);
    expect(p95.ms).not.toBeNull();
  });

  it("reports saturation instead of pretending the answer is 5000ms", () => {
    // Everything slower than the largest finite band. The honest answer is a
    // floor and a flag, not a number that reads as a measurement.
    const q = quantileFromHistogram(h({ leInf: 10 }), 0.5);
    expect(q).toEqual({ ms: 5000, saturated: true });
  });

  it("interpolates within the containing band", () => {
    // 10 requests in (10, 25], asking for the 10th percentile lands near the
    // bottom of that band; the 90th near the top.
    const low = quantileFromHistogram(h({ le25: 10 }), 0.1);
    const high = quantileFromHistogram(h({ le25: 10 }), 0.9);
    expect(low.ms).toBeLessThan(high.ms!);
    expect(low.ms).toBeGreaterThanOrEqual(10);
    expect(high.ms).toBeLessThanOrEqual(25);
  });

  it("is unaffected by which bucket the observations were recorded in", () => {
    // The property that makes this table re-aggregatable across minutes and
    // across the four API processes: summing bands then taking the quantile
    // must equal taking the quantile of the sum.
    const a = h({ le10: 40, le100: 10 });
    const b = h({ le10: 60, le100: 40, leInf: 5 });
    const merged = addHistogram(a, b);

    expect(merged.le10).toBe(100);
    expect(merged.le100).toBe(50);
    expect(merged.leInf).toBe(5);
    expect(quantileFromHistogram(merged, 0.5).ms).toBeLessThanOrEqual(10);
  });
});
