import { describe, expect, it } from "vitest";
import type { CashForecast, ForecastDay } from "./cashForecast.js";
import { applyScenario, normaliseParams } from "./cashScenario.js";

// The levers are arithmetic, so they are verified against a hand-built base
// with no database involved. scripts/checkCashForecast.ts covers the real
// engine; this covers what the transform does to it.

function day(date: string, placed: bigint, projected: bigint, outflow: bigint, opening: bigint): ForecastDay {
  const inflow = placed + projected;
  return {
    date,
    openingMinor: opening.toString(),
    inflowMinor: inflow.toString(),
    outflowMinor: outflow.toString(),
    closingMinor: (opening + inflow - outflow).toString(),
    inflowFromPlacedOrdersMinor: placed.toString(),
    inflowFromProjectedOrdersMinor: projected.toString(),
  };
}

/** Four days, ₹1,000 opening, ₹100/day placed + ₹100/day projected, ₹50/day out. */
function makeBase(over: Partial<CashForecast> = {}): CashForecast {
  const days: ForecastDay[] = [];
  let running = 100_000n;
  for (const d of ["2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"]) {
    const row = day(d, 10_000n, 10_000n, 5_000n, running);
    running = BigInt(row.closingMinor);
    days.push(row);
  }
  return {
    version: "v2",
    generatedAt: "2026-08-12T00:00:00.000Z",
    timezone: "Asia/Kolkata",
    horizonDays: 4,
    openingBalance: { valueMinor: "100000", value: 1000, basis: "measured", note: "" },
    days,
    totals: { inflowMinor: "80000", outflowMinor: "20000", netMinor: "60000", closingMinor: running.toString() },
    lowestBalance: { valueMinor: "100000", value: 1000, date: "2026-08-12" },
    cashShortageDate: null,
    projectedInflowSharePct: 50,
    components: [
      { key: "outflow_vendor_bills", label: "Vendor bills due", basis: "measured", valueMinor: "8000", note: "" },
      { key: "outflow_run_rate", label: "Operating spend and ads", basis: "measured", valueMinor: "12000", note: "" },
    ],
    reliability: "usable",
    reliabilityNote: "base note.",
    assumptions: { prepaidSettlementLagDays: 3, codRemittanceLagDays: 9, velocityWindowDays: 28 },
    ...over,
  } as CashForecast;
}

describe("normaliseParams", () => {
  it("clamps an absurd growth delta rather than drawing it", () => {
    expect(normaliseParams({ growthDeltaPct: 99_999 }).growthDeltaPct).toBe(500);
    expect(normaliseParams({ growthDeltaPct: -900 }).growthDeltaPct).toBe(-100);
  });

  it("caps collection acceleration at the COD lag — cash cannot arrive before the order", () => {
    expect(normaliseParams({ collectionAccelDays: 60 }).collectionAccelDays).toBe(9);
  });

  it("drops a zero or malformed inventory purchase instead of applying it", () => {
    expect(normaliseParams({ inventoryPurchase: { amountPaise: "0", date: "2026-08-14" } }).inventoryPurchase).toBeUndefined();
    expect(normaliseParams({ inventoryPurchase: { amountPaise: "500", date: "14/08/2026" } }).inventoryPurchase).toBeUndefined();
  });

  it("ignores NaN and Infinity", () => {
    expect(normaliseParams({ adSpendDeltaPct: Number.NaN }).adSpendDeltaPct).toBeUndefined();
    expect(normaliseParams({ rtoDeltaPct: Number.POSITIVE_INFINITY }).rtoDeltaPct).toBeUndefined();
  });
});

describe("applyScenario", () => {
  it("an empty scenario returns the base line unchanged", () => {
    const base = makeBase();
    const s = applyScenario(base, {});
    expect(s.totals).toEqual(base.totals);
    expect(s.days.map((d) => d.closingMinor)).toEqual(base.days.map((d) => d.closingMinor));
    expect(s.comparison.closingDeltaMinor).toBe("0");
  });

  it("growth moves projected inflow only, never orders already placed", () => {
    const s = applyScenario(makeBase(), { growthDeltaPct: 100 });
    // projected 10,000 -> 20,000; placed stays 10,000
    expect(s.days[0]!.inflowFromProjectedOrdersMinor).toBe("20000");
    expect(s.days[0]!.inflowFromPlacedOrdersMinor).toBe("10000");
  });

  it("a negative growth delta reduces the line", () => {
    const s = applyScenario(makeBase(), { growthDeltaPct: -50 });
    expect(s.days[0]!.inflowFromProjectedOrdersMinor).toBe("5000");
    expect(BigInt(s.totals.closingMinor)).toBeLessThan(BigInt(makeBase().totals.closingMinor));
  });

  it("ad spend scales the run-rate component, not the bills", () => {
    const base = makeBase();
    // run-rate total 12,000 over 4 days; +100% adds 12,000 => +3,000/day
    const s = applyScenario(base, { adSpendDeltaPct: 100 });
    expect(BigInt(s.days[0]!.outflowMinor)).toBe(5_000n + 3_000n);
    expect(BigInt(s.totals.outflowMinor)).toBe(BigInt(base.totals.outflowMinor) + 12_000n);
  });

  it("RTO removes projected cash as percentage points", () => {
    const s = applyScenario(makeBase(), { rtoDeltaPct: 10 });
    // 10 points of 10,000 = 1,000
    expect(s.days[0]!.inflowFromProjectedOrdersMinor).toBe("9000");
  });

  it("a one-off purchase lands on its named day only", () => {
    const s = applyScenario(makeBase(), { inventoryPurchase: { amountPaise: "50000", date: "2026-08-15" } });
    expect(BigInt(s.days[2]!.outflowMinor)).toBe(5_000n + 50_000n);
    expect(BigInt(s.days[0]!.outflowMinor)).toBe(5_000n);
    expect(s.appliedLevers.find((l) => l.key === "inventoryPurchase")?.applied).toBe(true);
  });

  it("a purchase outside the horizon is reported unapplied, not clamped onto the last day", () => {
    const s = applyScenario(makeBase(), { inventoryPurchase: { amountPaise: "50000", date: "2027-01-01" } });
    expect(s.totals.outflowMinor).toBe(makeBase().totals.outflowMinor);
    const lever = s.appliedLevers.find((l) => l.key === "inventoryPurchase");
    expect(lever?.applied).toBe(false);
    expect(lever?.note).toMatch(/outside this horizon/);
  });

  it("reports codShareDeltaPct as accepted but not modelled, rather than silently ignoring it", () => {
    const s = applyScenario(makeBase(), { codShareDeltaPct: 20 });
    const lever = s.appliedLevers.find((l) => l.key === "codShareDeltaPct");
    expect(lever).toBeDefined();
    expect(lever!.applied).toBe(false);
    expect(lever!.note).toMatch(/[Nn]ot modelled/);
    // And the line is genuinely unchanged, matching the claim.
    expect(s.totals).toEqual(makeBase().totals);
  });

  it("says a lever was inert when the base has no data for it", () => {
    const base = makeBase({
      components: [
        { key: "outflow_vendor_bills", label: "Vendor bills due", basis: "unavailable", valueMinor: "0", note: "" },
        { key: "outflow_run_rate", label: "Operating spend and ads", basis: "unavailable", valueMinor: "0", note: "" },
      ],
    });
    const s = applyScenario(base, { adSpendDeltaPct: 50, vendorPaymentDelayDays: 30 });
    expect(s.appliedLevers.find((l) => l.key === "adSpendDeltaPct")?.applied).toBe(false);
    expect(s.appliedLevers.find((l) => l.key === "vendorPaymentDelayDays")?.applied).toBe(false);
    expect(s.reliabilityNote).toMatch(/no run-rate to change|No vendor bills/);
  });

  it("never lets a lever push a day's inflow below zero", () => {
    // 500 percentage points of RTO would take projected inflow deeply negative
    const s = applyScenario(makeBase(), { rtoDeltaPct: 100 });
    for (const d of s.days) {
      expect(BigInt(d.inflowMinor)).toBeGreaterThanOrEqual(0n);
      expect(BigInt(d.inflowFromProjectedOrdersMinor)).toBeGreaterThanOrEqual(0n);
    }
  });

  it("the re-walked line is internally consistent", () => {
    const s = applyScenario(makeBase(), { growthDeltaPct: 40, adSpendDeltaPct: 25 });
    let running = BigInt(s.openingBalance.valueMinor);
    let inSum = 0n;
    let outSum = 0n;
    for (const d of s.days) {
      expect(d.openingMinor).toBe(running.toString());
      running = running + BigInt(d.inflowMinor) - BigInt(d.outflowMinor);
      expect(d.closingMinor).toBe(running.toString());
      expect(BigInt(d.inflowFromPlacedOrdersMinor) + BigInt(d.inflowFromProjectedOrdersMinor)).toBe(BigInt(d.inflowMinor));
      inSum += BigInt(d.inflowMinor);
      outSum += BigInt(d.outflowMinor);
    }
    expect(s.totals.inflowMinor).toBe(inSum.toString());
    expect(s.totals.outflowMinor).toBe(outSum.toString());
    expect(s.totals.closingMinor).toBe(running.toString());
  });

  it("surfaces a shortage the scenario itself causes", () => {
    const base = makeBase();
    expect(base.cashShortageDate).toBeNull();
    const s = applyScenario(base, { inventoryPurchase: { amountPaise: "5000000", date: "2026-08-13" } });
    expect(s.cashShortageDate).toBe("2026-08-13");
    expect(s.comparison.baseCashShortageDate).toBeNull();
    expect(s.comparison.scenarioCashShortageDate).toBe("2026-08-13");
    expect(BigInt(s.comparison.lowestBalanceDeltaMinor)).toBeLessThan(0n);
  });

  it("keeps the base's reliability — a scenario cannot improve the data under it", () => {
    const base = makeBase({ reliability: "inflows_only", reliabilityNote: "no outflow source." });
    const s = applyScenario(base, { growthDeltaPct: 50 });
    expect(s.reliability).toBe("inflows_only");
    expect(s.reliabilityNote).toMatch(/no scenario built on it is a cash balance/);
  });

  it("is deterministic — identical params produce an identical line", () => {
    const params = { growthDeltaPct: 33, adSpendDeltaPct: -12, rtoDeltaPct: 4 };
    const a = applyScenario(makeBase(), params);
    const b = applyScenario(makeBase(), params);
    expect(a.days).toEqual(b.days);
    expect(a.totals).toEqual(b.totals);
  });
});
