import { describe, expect, it } from "vitest";
import {
  decideAdSpendSpike,
  decideCancellationIncrease,
  decideCashBelowThreshold,
  decideCourierCostIncrease,
  decideDuplicatePayments,
  decideMissingSettlement,
  decideNegativeMarginSkus,
  decideProductCostIncrease,
  decideRefundIncrease,
  decideRevenueChange,
  decideRtoIncrease,
} from "./anomalies.js";

describe("decideRevenueChange", () => {
  it("fires REVENUE_DECLINE at -20% or worse", () => {
    const r = decideRevenueChange({ changePct: -20, value: 80000, priorValue: 100000, valueMinor: "8000000", priorValueMinor: "10000000" });
    expect(r?.type).toBe("REVENUE_DECLINE");
    expect(r?.severity).toBe("CRITICAL");
  });

  it("does not fire just above the decline threshold", () => {
    expect(decideRevenueChange({ changePct: -19.9, value: 1, priorValue: 1, valueMinor: "1", priorValueMinor: "1" })).toBeNull();
  });

  it("fires REVENUE_SPIKE at +50% or more", () => {
    const r = decideRevenueChange({ changePct: 55, value: 155000, priorValue: 100000, valueMinor: "15500000", priorValueMinor: "10000000" });
    expect(r?.type).toBe("REVENUE_SPIKE");
    expect(r?.severity).toBe("INFO");
  });

  it("is silent in the ordinary band between -20% and +50%", () => {
    expect(decideRevenueChange({ changePct: 10, value: 1, priorValue: 1, valueMinor: "1", priorValueMinor: "1" })).toBeNull();
  });

  it("is silent with no prior-period data to compare against", () => {
    expect(decideRevenueChange({ changePct: null, value: 1, priorValue: 0, valueMinor: "1", priorValueMinor: "0" })).toBeNull();
  });
});

describe("decideAdSpendSpike", () => {
  it("fires at +50% or more", () => {
    const r = decideAdSpendSpike({ changePct: 60, value: 16000, priorValue: 10000, valueMinor: "1600000", priorValueMinor: "1000000", currency: "INR" });
    expect(r?.type).toBe("AD_SPEND_SPIKE");
  });

  it("is silent on mixed-currency (null changePct)", () => {
    expect(decideAdSpendSpike({ changePct: null, value: null, priorValue: null, valueMinor: null, priorValueMinor: null, currency: null })).toBeNull();
  });

  it("is silent below the threshold", () => {
    expect(decideAdSpendSpike({ changePct: 49, value: 1, priorValue: 1, valueMinor: "1", priorValueMinor: "1", currency: "INR" })).toBeNull();
  });
});

describe("decideRtoIncrease", () => {
  it("fires on a 5-point-or-more jump", () => {
    const r = decideRtoIncrease({ rtoRatePct: 12, priorRtoRatePct: 6, changePct: 6, dispatchedCount: 100, rtoCount: 12 });
    expect(r?.type).toBe("RTO_INCREASE");
    expect(r?.difference).toBe(6);
  });

  it("is silent on a small base-rate move under 5 points", () => {
    expect(decideRtoIncrease({ rtoRatePct: 3, priorRtoRatePct: 2, changePct: 1, dispatchedCount: 100, rtoCount: 3 })).toBeNull();
  });

  it("is silent with no dispatched shipments to rate", () => {
    expect(decideRtoIncrease({ rtoRatePct: null, priorRtoRatePct: null, changePct: null, dispatchedCount: 0, rtoCount: 0 })).toBeNull();
  });
});

describe("decideRefundIncrease / decideCancellationIncrease", () => {
  it("refund rate fires at 5% or more", () => {
    const r = decideRefundIncrease({ revenueRefundRatePct: 5, priorRevenueRefundRatePct: 2, ordersWithRefund: 10, value: 50000 });
    expect(r?.type).toBe("REFUND_INCREASE");
  });

  it("refund rate is silent below 5%", () => {
    expect(decideRefundIncrease({ revenueRefundRatePct: 4.9, priorRevenueRefundRatePct: 1, ordersWithRefund: 1, value: 1 })).toBeNull();
  });

  it("cancellation rate fires at 5% or more", () => {
    const r = decideCancellationIncrease({ ratePct: 6, priorRatePct: 3, count: 6, value: 30000 });
    expect(r?.type).toBe("CANCELLATION_INCREASE");
  });

  it("cancellation rate is silent below 5%", () => {
    expect(decideCancellationIncrease({ ratePct: 1, priorRatePct: 1, count: 1, value: 1 })).toBeNull();
  });
});

describe("decideCourierCostIncrease", () => {
  it("fires at +20% or more with real coverage on both sides", () => {
    const r = decideCourierCostIncrease({ currentPaise: 120_000n, priorPaise: 100_000n, currentLines: 50, priorLines: 50 });
    expect(r?.type).toBe("COURIER_COST_INCREASE");
  });

  it("is silent when the prior window has no invoiced lines (ingestion gap, not a real decline)", () => {
    expect(decideCourierCostIncrease({ currentPaise: 120_000n, priorPaise: 0n, currentLines: 50, priorLines: 0 })).toBeNull();
  });

  it("is silent when the current window has no invoiced lines yet", () => {
    expect(decideCourierCostIncrease({ currentPaise: 0n, priorPaise: 100_000n, currentLines: 0, priorLines: 50 })).toBeNull();
  });

  it("is silent below the threshold", () => {
    expect(decideCourierCostIncrease({ currentPaise: 110_000n, priorPaise: 100_000n, currentLines: 10, priorLines: 10 })).toBeNull();
  });
});

describe("decideNegativeMarginSkus", () => {
  it("fires on any SKU with negative CM0, surfacing the worst one", () => {
    // Input order matters: the function trusts the caller's worst-first
    // ordering (getProductProfitability.bottomByMargin's own contract)
    // rather than re-sorting, so the fixture lists the worse SKU (B) first.
    const r = decideNegativeMarginSkus([
      { sku: "B", productName: "Widget B", cm0: -2000, cm0Pct: -40, netRevenue: 5000 },
      { sku: "A", productName: "Widget A", cm0: -500, cm0Pct: -10, netRevenue: 5000 },
    ]);
    expect(r?.observedValue).toBe(2);
    expect(r?.recommendedInvestigation).toContain("Widget B");
  });

  it("is silent with no negative-margin SKUs", () => {
    expect(decideNegativeMarginSkus([{ sku: "A", productName: "Widget A", cm0: 500, cm0Pct: 10, netRevenue: 5000 }])).toBeNull();
  });

  it("is silent on an empty list", () => {
    expect(decideNegativeMarginSkus([])).toBeNull();
  });
});

describe("decideMissingSettlement", () => {
  it("fires once the gap since the last settlement exceeds 2x the historical baseline", () => {
    const r = decideMissingSettlement({ connectionId: "c1", label: "RAZORPAY", gapDays: 2, baselineGapDays: 2, daysSinceLast: 5 });
    expect(r?.type).toBe("MISSING_SETTLEMENT");
  });

  it("is silent within twice the baseline", () => {
    expect(decideMissingSettlement({ connectionId: "c1", label: "RAZORPAY", gapDays: 2, baselineGapDays: 2, daysSinceLast: 3.9 })).toBeNull();
  });

  it("floors the baseline at 1 day so a same-day-settling account doesn't fire on ordinary jitter", () => {
    // baseline 0.1 days * 2 would be 0.2 — flooring to 1 means daysSinceLast must clear 2, not 0.2
    expect(decideMissingSettlement({ connectionId: "c1", label: "RAZORPAY", gapDays: 0.1, baselineGapDays: 0.1, daysSinceLast: 1.5 })).toBeNull();
  });

  it("rounds the day counts it stores and renders — a raw float leaks into the UI", () => {
    const r = decideMissingSettlement({
      connectionId: "c1",
      label: "GOKWIK",
      gapDays: 1,
      baselineGapDays: 1.002777777777778,
      daysSinceLast: 5.770833321759259,
    });
    expect(r?.observedValue).toBe(5.8);
    expect(r?.expectedValue).toBe(1);
    expect(r?.recommendedInvestigation).toContain("5.8 days");
    expect(r?.recommendedInvestigation).not.toContain("5.770833");
  });
});

describe("decideDuplicatePayments", () => {
  it("fires on an order with 2+ captured payments of the identical amount", () => {
    const r = decideDuplicatePayments([{ orderId: "o1", amount: 50000n, paymentIds: ["p1", "p2"] }]);
    expect(r?.type).toBe("DUPLICATE_PAYMENT");
    expect((r?.evidence as { totalDuplicatedPaise: string }).totalDuplicatedPaise).toBe("50000");
  });

  it("is silent with no duplicate groups", () => {
    expect(decideDuplicatePayments([])).toBeNull();
  });
});

describe("decideProductCostIncrease", () => {
  it("fires on a 15%+ jump for a SKU", () => {
    const r = decideProductCostIncrease([{ sku: "A", landedCost: 1150n, priorLandedCost: 1000n, effectiveFrom: new Date("2026-01-01") }]);
    expect(r?.type).toBe("PRODUCT_COST_INCREASE");
  });

  it("is silent with no increases", () => {
    expect(decideProductCostIncrease([])).toBeNull();
  });
});

describe("decideCashBelowThreshold", () => {
  it("fires when available cash is below the configured threshold", () => {
    const r = decideCashBelowThreshold({ currentPaise: 4_000_000n, thresholdPaise: 5_000_000n });
    expect(r?.type).toBe("CASH_BELOW_THRESHOLD");
    expect(r?.severity).toBe("CRITICAL");
  });

  it("is silent at or above the threshold", () => {
    expect(decideCashBelowThreshold({ currentPaise: 5_000_000n, thresholdPaise: 5_000_000n })).toBeNull();
  });

  it("is silent when no threshold is configured for the org", () => {
    expect(decideCashBelowThreshold({ currentPaise: 0n, thresholdPaise: null })).toBeNull();
  });
});
