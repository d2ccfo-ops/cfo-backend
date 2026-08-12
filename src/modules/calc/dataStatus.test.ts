import { describe, expect, it } from "vitest";
import { buildDataStatusMap, RECONCILED_MIN_PCT, type DataStatusInputs } from "./dataStatus.js";

// The pure half of scripts/checkDataStatusFlip.ts — the DB-backed live flip
// (an ESTIMATED cost row upserted to MANUAL in a scratch org) stays an
// integration script; buildDataStatusMap() itself takes no DB input, so its
// ladder logic is fully unit-testable. §42.8 is the rule every case here
// ultimately defends: estimated data must never read as reconciled.
const baseInputs: DataStatusInputs = {
  costedSkuCount: 10,
  estimatedSkuCount: 0,
  costedValuePct: 100,
  orderPaymentMatchedPct: 99,
  orderPaymentBlockedReason: null,
  settlementBankMatchedPct: 99,
  settlementBankBlockedReason: null,
  bankCreditCount: 5,
  staleSourceCount: 0,
  totalSourceCount: 3,
};

describe("buildDataStatusMap — margin (§42.8)", () => {
  it("marks the margin estimated the moment any SKU rests on a placeholder cost", () => {
    const status = buildDataStatusMap({ ...baseInputs, estimatedSkuCount: 1 });
    expect(status.contribution_margin.status).toBe("estimated");
    expect(status.product_profitability.status).toBe("estimated");
    expect(status.contribution_margin.reasons.join(" ")).toMatch(/placeholder/);
  });

  it("does not let estimated costs drag down revenue's own verification", () => {
    const status = buildDataStatusMap({ ...baseInputs, estimatedSkuCount: 1 });
    expect(status.revenue.status).toBe("reconciled");
  });

  it("reconciles the margin only once costs are real AND revenue is reconciled", () => {
    const status = buildDataStatusMap(baseInputs);
    expect(status.contribution_margin.status).toBe("reconciled");
  });

  it("caps the margin at the revenue side's own status — a margin cannot outrank its inputs", () => {
    const status = buildDataStatusMap({ ...baseInputs, orderPaymentMatchedPct: 87.1 });
    expect(status.revenue.status).toBe("provisional");
    expect(status.contribution_margin.status).toBe("provisional");
  });

  it("treats zero costed SKUs as estimated, not provisional", () => {
    const status = buildDataStatusMap({ ...baseInputs, costedSkuCount: 0 });
    expect(status.contribution_margin.status).toBe("estimated");
  });

  it("holds real-but-partial cost coverage at provisional, below the reconciled threshold", () => {
    const status = buildDataStatusMap({ ...baseInputs, costedValuePct: RECONCILED_MIN_PCT - 1 });
    expect(status.contribution_margin.status).toBe("provisional");
  });
});

describe("buildDataStatusMap — revenue", () => {
  it("reconciles only at or above the RECONCILED_MIN_PCT threshold", () => {
    expect(buildDataStatusMap({ ...baseInputs, orderPaymentMatchedPct: RECONCILED_MIN_PCT }).revenue.status).toBe(
      "reconciled"
    );
    expect(
      buildDataStatusMap({ ...baseInputs, orderPaymentMatchedPct: RECONCILED_MIN_PCT - 0.1 }).revenue.status
    ).toBe("provisional");
  });

  it("is provisional, never estimated, when there is simply nothing to match against", () => {
    const status = buildDataStatusMap({ ...baseInputs, orderPaymentMatchedPct: null });
    expect(status.revenue.status).toBe("provisional");
  });

  it("passes the leg's own blocked-reason text through verbatim when present", () => {
    const status = buildDataStatusMap({
      ...baseInputs,
      orderPaymentMatchedPct: null,
      orderPaymentBlockedReason: "the exact wording the reconciliation leg produced",
    });
    expect(status.revenue.reasons).toContain("the exact wording the reconciliation leg produced");
  });
});

describe("buildDataStatusMap — cash_received", () => {
  it("is provisional with no bank statement at all", () => {
    expect(buildDataStatusMap({ ...baseInputs, bankCreditCount: 0 }).cash_received.status).toBe("provisional");
  });

  it("is provisional when credits exist but nothing to trace them to", () => {
    expect(
      buildDataStatusMap({ ...baseInputs, settlementBankMatchedPct: null }).cash_received.status
    ).toBe("provisional");
  });

  it("reconciles once settlement value is traced to bank credits above threshold", () => {
    expect(buildDataStatusMap(baseInputs).cash_received.status).toBe("reconciled");
  });
});

describe("buildDataStatusMap — cash_forecast", () => {
  it("is always estimated — a projection can never be reconciled (§42.8 read forward)", () => {
    expect(buildDataStatusMap(baseInputs).cash_forecast.status).toBe("estimated");
    expect(buildDataStatusMap({ ...baseInputs, orderPaymentMatchedPct: 100 }).cash_forecast.status).toBe("estimated");
  });
});

describe("buildDataStatusMap — pipeline staleness", () => {
  it("caps an otherwise-reconciled status at provisional when sources are stale", () => {
    const status = buildDataStatusMap({ ...baseInputs, staleSourceCount: 2 });
    expect(status.revenue.status).toBe("provisional");
    expect(status.cash_received.status).toBe("provisional");
    expect(status.revenue.reasons.some((r) => r.includes("have not synced"))).toBe(true);
  });

  it("does not touch an already-estimated status — nothing to cap further", () => {
    const status = buildDataStatusMap({ ...baseInputs, estimatedSkuCount: 1, staleSourceCount: 2 });
    expect(status.contribution_margin.status).toBe("estimated");
  });
});
