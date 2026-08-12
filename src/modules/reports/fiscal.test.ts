import { describe, expect, it } from "vitest";
import {
  DEFAULT_FISCAL_START_MONTH,
  availablePeriods,
  fiscalQuarterPeriod,
  fiscalYearLabel,
  fiscalYearOf,
  fiscalYearPeriod,
  monthPeriod,
} from "./fiscal.js";

// Every off-by-one here puts a whole quarter in the wrong year, and it does it
// SILENTLY — the figures would all be real and correctly computed, just
// labelled with a year they do not belong to. That is a much harder error to
// notice than a wrong number, which is why this is swept rather than sampled.

const IST = "Asia/Kolkata";
const APR = DEFAULT_FISCAL_START_MONTH; // 4

describe("fiscalYearOf", () => {
  it("puts 31 March in the year that is ending", () => {
    expect(fiscalYearOf(new Date("2026-03-31T18:00:00.000Z"), APR, IST)).toBe(2025);
  });

  it("puts 1 April in the year that is beginning", () => {
    expect(fiscalYearOf(new Date("2026-04-01T00:00:00.000Z"), APR, IST)).toBe(2026);
  });

  it("resolves the boundary on the ORGANISATION's clock, not UTC", () => {
    // 2026-03-31T19:00Z is already 1 April in IST (+5:30). A UTC-thinking
    // implementation would file this in the previous financial year.
    expect(fiscalYearOf(new Date("2026-03-31T19:00:00.000Z"), APR, IST)).toBe(2026);
    expect(fiscalYearOf(new Date("2026-03-31T17:00:00.000Z"), APR, IST)).toBe(2025);
  });

  it("handles a January start as the calendar year", () => {
    expect(fiscalYearOf(new Date("2026-03-31T00:00:00.000Z"), 1, IST)).toBe(2026);
    expect(fiscalYearOf(new Date("2026-12-31T00:00:00.000Z"), 1, IST)).toBe(2026);
  });
});

describe("fiscalYearLabel", () => {
  it("uses the Indian two-year form", () => {
    expect(fiscalYearLabel(2026, APR)).toBe("FY2026-27");
    expect(fiscalYearLabel(2099, APR)).toBe("FY2099-00");
  });

  it("does not fake a span for a calendar-year organisation", () => {
    // "FY2026-27" for a January start would be wrong, not merely odd.
    expect(fiscalYearLabel(2026, 1)).toBe("FY2026");
  });
});

describe("fiscalYearPeriod", () => {
  it("runs April to March", () => {
    const p = fiscalYearPeriod(2026, APR, IST);
    expect(p.from.toISOString()).toBe("2026-03-31T18:30:00.000Z"); // 1 Apr 2026, 00:00 IST
    expect(p.to.toISOString()).toBe("2027-03-31T18:29:59.999Z"); // 31 Mar 2027, 23:59:59.999 IST
    expect(p.label).toBe("FY2026-27");
  });

  it("runs January to December for a calendar-year organisation", () => {
    const p = fiscalYearPeriod(2026, 1, IST);
    expect(p.from.toISOString()).toBe("2025-12-31T18:30:00.000Z");
    expect(p.to.toISOString()).toBe("2026-12-31T18:29:59.999Z");
  });

  it("covers exactly one year with no gap and no overlap", () => {
    const a = fiscalYearPeriod(2025, APR, IST);
    const b = fiscalYearPeriod(2026, APR, IST);
    expect(b.from.getTime() - a.to.getTime()).toBe(1);
  });
});

describe("fiscalQuarterPeriod", () => {
  it("starts Q1 at the fiscal start month", () => {
    const q1 = fiscalQuarterPeriod(2026, APR, 1, IST);
    expect(q1.from.toISOString()).toBe("2026-03-31T18:30:00.000Z"); // 1 Apr
    expect(q1.to.toISOString()).toBe("2026-06-30T18:29:59.999Z"); // 30 Jun
    expect(q1.label).toBe("Q1 FY2026-27");
  });

  it("rolls Q4 into the following calendar year", () => {
    // The case a naive implementation gets wrong: Jan-Mar 2027 is Q4 of
    // FY2026-27, not Q4 of FY2027.
    const q4 = fiscalQuarterPeriod(2026, APR, 4, IST);
    expect(q4.from.toISOString()).toBe("2026-12-31T18:30:00.000Z"); // 1 Jan 2027
    expect(q4.to.toISOString()).toBe("2027-03-31T18:29:59.999Z"); // 31 Mar 2027
    expect(q4.label).toBe("Q4 FY2026-27");
  });

  it("tiles the financial year exactly", () => {
    const fy = fiscalYearPeriod(2026, APR, IST);
    const quarters = ([1, 2, 3, 4] as const).map((q) => fiscalQuarterPeriod(2026, APR, q, IST));
    expect(quarters[0]!.from.getTime()).toBe(fy.from.getTime());
    expect(quarters[3]!.to.getTime()).toBe(fy.to.getTime());
    for (let i = 1; i < 4; i += 1) {
      expect(quarters[i]!.from.getTime() - quarters[i - 1]!.to.getTime()).toBe(1);
    }
  });
});

describe("monthPeriod", () => {
  it("ends on the last day of the month", () => {
    expect(monthPeriod(2026, 8, IST).to.toISOString()).toBe("2026-08-31T18:29:59.999Z");
  });

  it("handles February in a non-leap year", () => {
    expect(monthPeriod(2026, 2, IST).to.toISOString()).toBe("2026-02-28T18:29:59.999Z");
  });

  it("handles February in a leap year", () => {
    // Computed from the first of the next month rather than a days-in-month
    // table, so 29 February needs no special case.
    expect(monthPeriod(2028, 2, IST).to.toISOString()).toBe("2028-02-29T18:29:59.999Z");
  });

  it("handles December rolling the year", () => {
    expect(monthPeriod(2026, 12, IST).to.toISOString()).toBe("2026-12-31T18:29:59.999Z");
  });
});

describe("availablePeriods", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");

  it("lists recent months newest first, including the current partial one", () => {
    const periods = availablePeriods(now, APR, IST);
    expect(periods[0]!.label).toBe("August 2026");
    expect(periods[1]!.label).toBe("July 2026");
  });

  it("does not offer a quarter that has not started", () => {
    // Q3 FY2026-27 begins in October. Listing it in August produces an empty
    // report that reads like a catastrophic month.
    const labels = availablePeriods(now, APR, IST).map((p) => p.label);
    expect(labels).toContain("Q1 FY2026-27");
    expect(labels).toContain("Q2 FY2026-27");
    expect(labels).not.toContain("Q3 FY2026-27");
    expect(labels).not.toContain("Q4 FY2026-27");
  });

  it("offers the current and previous financial years", () => {
    const labels = availablePeriods(now, APR, IST).map((p) => p.label);
    expect(labels).toContain("FY2026-27");
    expect(labels).toContain("FY2025-26");
  });

  it("gives every period a unique key", () => {
    const keys = availablePeriods(now, APR, IST, 24).map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("crosses the year boundary correctly when run in March", () => {
    const march = new Date("2027-03-15T12:00:00.000Z");
    const labels = availablePeriods(march, APR, IST).map((p) => p.label);
    // Still FY2026-27 in March, and all four quarters have begun.
    expect(labels).toContain("FY2026-27");
    expect(labels).toContain("Q4 FY2026-27");
    expect(labels).toContain("March 2027");
    expect(labels).toContain("February 2027");
  });
});
