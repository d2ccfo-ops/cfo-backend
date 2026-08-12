import { describe, expect, it } from "vitest";
import { formatInr, majorToMinorUnits, paiseToRupees, rupeesToPaise, sumPaise } from "./money.js";

// Money is bigint paise everywhere past this module's boundary — the whole
// point is that these conversions never touch a float mid-calculation. Every
// case here is chosen to break under naive float arithmetic if it crept in.
describe("rupeesToPaise / paiseToRupees", () => {
  it("round-trips exactly for values that break float arithmetic", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE754 — the classic case an accidental float
    // path would fail on.
    expect(rupeesToPaise(0.1) + rupeesToPaise(0.2)).toBe(30n);
    expect(paiseToRupees(30n)).toBe(0.3);
  });

  it("rounds to the nearest paisa rather than truncating", () => {
    expect(rupeesToPaise(10.005)).toBe(1001n); // banker's-adjacent, Math.round half-up
    expect(rupeesToPaise(10.004)).toBe(1000n);
  });

  it("handles zero and negative amounts (refunds, credits)", () => {
    expect(rupeesToPaise(0)).toBe(0n);
    expect(rupeesToPaise(-50)).toBe(-5000n);
    expect(paiseToRupees(-5000n)).toBe(-50);
  });

  it("handles amounts at the scale this product actually sees", () => {
    // ₹1.70 Cr, the fabricated-margin figure from this session's audits.
    expect(rupeesToPaise(17_000_000)).toBe(1_700_000_000n);
    expect(paiseToRupees(1_700_000_000n)).toBe(17_000_000);
  });
});

describe("sumPaise", () => {
  it("sums exactly across many small amounts — no float drift", () => {
    // 25,963 orders' worth of ₹1 lines would drift under repeated float
    // addition; bigint addition cannot.
    const lines = Array.from({ length: 25_963 }, () => 100n);
    expect(sumPaise(lines)).toBe(2_596_300n);
  });

  it("returns 0n for an empty list rather than throwing", () => {
    expect(sumPaise([])).toBe(0n);
  });

  it("sums positive and negative together (refund netting)", () => {
    expect(sumPaise([10000n, -3000n, 500n])).toBe(7500n);
  });
});

describe("majorToMinorUnits", () => {
  it("is the same rounding rule as rupeesToPaise, for any 2-decimal currency", () => {
    expect(majorToMinorUnits(99.995)).toBe(rupeesToPaise(99.995));
  });
});

describe("formatInr", () => {
  it("formats as INR with no decimal places", () => {
    expect(formatInr(1_700_000_000n)).toBe("₹1,70,00,000");
  });

  it("formats zero and negative correctly", () => {
    expect(formatInr(0n)).toBe("₹0");
    expect(formatInr(-500000n)).toBe("-₹5,000");
  });
});
