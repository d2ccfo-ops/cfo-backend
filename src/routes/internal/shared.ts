import type { Request } from "express";

// Helpers shared by the /internal routers.
//
// Two things here differ from every other route in this API, and both follow
// from the console being cross-tenant:
//
//   1. RANGES ARE UTC, NOT ORGANISATION-LOCAL. Everywhere else, a date range is
//      cut on the organisation's timezone, because "today's revenue" means the
//      merchant's today (see lib/dateRange.ts). An operations question spans
//      every tenant at once, and there is no single local midnight to cut on —
//      so these use plain UTC windows and say so.
//   2. THERE IS NO req.auth. requireSuperAdmin authenticates a person, not a
//      tenant, so nothing downstream may reach for an organizationId.

/** Days back from now, clamped. Defaults to 30. */
export function daysParam(req: Request, fallback = 30, max = 365): number {
  const raw = Number(req.query.days);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.trunc(raw), max);
}

/** Hours back from now, clamped. Defaults to 24. */
export function hoursParam(req: Request, fallback = 24, max = 24 * 90): number {
  const raw = Number(req.query.hours);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.trunc(raw), max);
}

export function limitParam(req: Request, fallback = 50, max = 500): number {
  const raw = Number(req.query.limit);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.trunc(raw), max);
}

export function since(ms: number, now = new Date()): Date {
  return new Date(now.getTime() - ms);
}

/** The fixed upper bounds of the latency histogram, in order. */
export const LATENCY_BOUNDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

export interface HistogramCounts {
  le10: number;
  le25: number;
  le50: number;
  le100: number;
  le250: number;
  le500: number;
  le1000: number;
  le2500: number;
  le5000: number;
  leInf: number;
}

export function emptyHistogram(): HistogramCounts {
  return { le10: 0, le25: 0, le50: 0, le100: 0, le250: 0, le500: 0, le1000: 0, le2500: 0, le5000: 0, leInf: 0 };
}

export function addHistogram(a: HistogramCounts, b: HistogramCounts): HistogramCounts {
  return {
    le10: a.le10 + b.le10,
    le25: a.le25 + b.le25,
    le50: a.le50 + b.le50,
    le100: a.le100 + b.le100,
    le250: a.le250 + b.le250,
    le500: a.le500 + b.le500,
    le1000: a.le1000 + b.le1000,
    le2500: a.le2500 + b.le2500,
    le5000: a.le5000 + b.le5000,
    leInf: a.leInf + b.leInf,
  };
}

export interface Quantile {
  /** Estimated milliseconds, or null when there were no observations. */
  ms: number | null;
  /**
   * True when the quantile lands in the unbounded top band, i.e. all we can
   * honestly say is "worse than 5000ms".
   *
   * Surfaced rather than hidden because the alternative — quietly returning
   * 5000 — reports a route that is timing out as one that is merely slow.
   */
  saturated: boolean;
}

/**
 * Estimate a quantile from bucket counts, the way Prometheus does.
 *
 * WHY A HISTOGRAM AT ALL. Percentiles do not average: given two minutes of
 * traffic you cannot combine their p95s into the p95 of the pair, which is
 * exactly what every chart on the infrastructure page needs to do. Counts in
 * fixed bands DO add, across minutes and across the four API processes, so the
 * quantile is computed once at read time over the summed bands.
 *
 * Within the containing band the position is linearly interpolated, which
 * assumes requests are spread evenly through it. They are not — but the band
 * edges bound the error, and the alternative of reporting the band's upper edge
 * overstates every quantile by up to the band's width.
 */
export function quantileFromHistogram(h: HistogramCounts, q: number): Quantile {
  // Bound paired with its count, so the two can never drift out of step.
  const bands: Array<[number, number]> = [
    [10, h.le10],
    [25, h.le25],
    [50, h.le50],
    [100, h.le100],
    [250, h.le250],
    [500, h.le500],
    [1000, h.le1000],
    [2500, h.le2500],
    [5000, h.le5000],
  ];

  const total = bands.reduce((a, [, c]) => a + c, 0) + h.leInf;
  if (total === 0) return { ms: null, saturated: false };

  const target = q * total;
  let cumulative = 0;
  let lowerBound = 0;

  for (const [upperBound, count] of bands) {
    const next = cumulative + count;
    if (next >= target) {
      if (count === 0) return { ms: upperBound, saturated: false };
      const withinBand = (target - cumulative) / count;
      return { ms: Math.round(lowerBound + (upperBound - lowerBound) * withinBand), saturated: false };
    }
    cumulative = next;
    lowerBound = upperBound;
  }

  // Past every finite band: the honest answer is a floor, not a number.
  return { ms: 5000, saturated: true };
}
