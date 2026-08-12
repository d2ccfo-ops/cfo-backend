import { describe, expect, it } from "vitest";
import {
  daysInMonth,
  expandSchedule,
  monthlyEquivalent,
  occurrencesInRange,
  type RecurringOutflow,
} from "./recurringOutflows.js";

// P2.2e is calendar arithmetic, and calendar arithmetic is where quiet money
// bugs live: a month that has no 31st, a quarter anchored later in the year
// than the window, an EMI that ended last March. All of it is pure, so all of
// it is tested here with no database.

function entry(over: Partial<RecurringOutflow> = {}): RecurringOutflow {
  return {
    id: "e1",
    label: "Salary",
    category: "SALARY",
    amountPaise: "40000000", // ₹4,00,000
    cadence: "MONTHLY",
    dayOfMonth: 1,
    ...over,
  };
}

const days = (o: RecurringOutflow, from: string, to: string) => occurrencesInRange(o, from, to).map((x) => x.day);

describe("daysInMonth", () => {
  it("knows February, including leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe("monthly", () => {
  it("lands once per month on the configured day", () => {
    expect(days(entry({ dayOfMonth: 7 }), "2026-08-01", "2026-10-31")).toEqual([
      "2026-08-07",
      "2026-09-07",
      "2026-10-07",
    ]);
  });

  it("includes a payment on the window's first and last day", () => {
    // Inclusive on both ends. An off-by-one here silently drops a ₹4L payroll
    // from a 30-day forecast that starts on the 1st.
    expect(days(entry({ dayOfMonth: 1 }), "2026-08-01", "2026-08-01")).toEqual(["2026-08-01"]);
    expect(days(entry({ dayOfMonth: 31 }), "2026-08-31", "2026-08-31")).toEqual(["2026-08-31"]);
  });

  it("clamps to the last day of a short month rather than skipping it", () => {
    // The decision that matters. Skipping would make rent vanish for a month
    // and the line would quietly look better than reality.
    const got = occurrencesInRange(entry({ dayOfMonth: 31 }), "2026-01-01", "2026-04-30");
    expect(got.map((o) => o.day)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(got.map((o) => o.clamped ?? false)).toEqual([false, true, false, true]);
  });

  it("clamps to 29 February in a leap year", () => {
    expect(days(entry({ dayOfMonth: 30 }), "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
  });

  it("crosses a year boundary", () => {
    expect(days(entry({ dayOfMonth: 15 }), "2026-11-20", "2027-02-01")).toEqual(["2026-12-15", "2027-01-15"]);
  });
});

describe("weekly", () => {
  it("lands on every matching weekday in the window", () => {
    // 2026-08-13 is a Thursday.
    expect(days(entry({ cadence: "WEEKLY", weekday: 4, dayOfMonth: undefined }), "2026-08-10", "2026-08-31")).toEqual([
      "2026-08-13",
      "2026-08-20",
      "2026-08-27",
    ]);
  });

  it("produces nothing when the window is shorter than a week and misses the day", () => {
    expect(days(entry({ cadence: "WEEKLY", weekday: 0, dayOfMonth: undefined }), "2026-08-10", "2026-08-14")).toEqual([]);
  });
});

describe("quarterly and annual", () => {
  it("quarterly repeats every third month from the anchor", () => {
    expect(days(entry({ cadence: "QUARTERLY", month: 1, dayOfMonth: 15 }), "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-15",
      "2026-04-15",
      "2026-07-15",
      "2026-10-15",
    ]);
  });

  it("quarterly works when the anchor month is later in the year than the window", () => {
    // Advance tax anchored to June, asked about February–May. A naive
    // (m − anchor) % 3 goes negative here and matches nothing.
    expect(days(entry({ cadence: "QUARTERLY", month: 6, dayOfMonth: 15 }), "2026-02-01", "2026-05-31")).toEqual([
      "2026-03-15",
    ]);
  });

  it("annual lands once, in the anchor month", () => {
    expect(days(entry({ cadence: "ANNUAL", month: 3, dayOfMonth: 31 }), "2026-01-01", "2027-06-30")).toEqual([
      "2026-03-31",
      "2027-03-31",
    ]);
  });
});

describe("lifetime bounds", () => {
  it("does not pay before it starts", () => {
    expect(days(entry({ dayOfMonth: 1, startDay: "2026-09-15" }), "2026-08-01", "2026-11-30")).toEqual([
      "2026-10-01",
      "2026-11-01",
    ]);
  });

  it("stops after it ends", () => {
    expect(days(entry({ dayOfMonth: 1, endDay: "2026-09-30" }), "2026-08-01", "2026-11-30")).toEqual([
      "2026-08-01",
      "2026-09-01",
    ]);
  });

  it("an entry whose lifetime is entirely outside the window produces nothing", () => {
    expect(days(entry({ endDay: "2025-01-01" }), "2026-08-01", "2026-11-30")).toEqual([]);
    expect(days(entry({ startDay: "2030-01-01" }), "2026-08-01", "2026-11-30")).toEqual([]);
  });
});

describe("guards", () => {
  it("ignores a zero or missing amount rather than placing ₹0 on a day", () => {
    expect(occurrencesInRange(entry({ amountPaise: "0" }), "2026-08-01", "2026-12-31")).toEqual([]);
    expect(occurrencesInRange(entry({ amountPaise: "" }), "2026-08-01", "2026-12-31")).toEqual([]);
  });

  it("returns nothing for an inverted window instead of looping", () => {
    expect(occurrencesInRange(entry(), "2026-12-31", "2026-01-01")).toEqual([]);
  });
});

describe("monthlyEquivalent", () => {
  it("normalises each cadence to a typical month, in integers", () => {
    expect(monthlyEquivalent(entry({ cadence: "MONTHLY", amountPaise: "1200" }))).toBe(1200n);
    expect(monthlyEquivalent(entry({ cadence: "QUARTERLY", amountPaise: "1200" }))).toBe(400n);
    expect(monthlyEquivalent(entry({ cadence: "ANNUAL", amountPaise: "1200" }))).toBe(100n);
    // 52 weeks over 12 months, not "about 4.33 × the weekly amount".
    expect(monthlyEquivalent(entry({ cadence: "WEEKLY", amountPaise: "1200" }))).toBe(5200n);
  });
});

describe("expandSchedule", () => {
  it("sums several entries landing on the same day", () => {
    const s = expandSchedule(
      [
        entry({ id: "a", label: "Salary", amountPaise: "40000000", dayOfMonth: 1 }),
        entry({ id: "b", label: "Rent", category: "RENT", amountPaise: "15000000", dayOfMonth: 1 }),
      ],
      "2026-08-01",
      "2026-08-31"
    );
    expect(s.byDay.get("2026-08-01")).toBe(55000000n);
    expect(s.totalPaise).toBe(55000000n);
    expect(s.monthlyEquivalentPaise).toBe(55000000n);
  });

  it("orders occurrences by date, not by the order the entries were configured", () => {
    const s = expandSchedule(
      [entry({ id: "a", dayOfMonth: 28 }), entry({ id: "b", label: "Rent", dayOfMonth: 5 })],
      "2026-08-01",
      "2026-08-31"
    );
    expect(s.occurrences.map((o) => o.day)).toEqual(["2026-08-05", "2026-08-28"]);
  });

  it("names the entries whose dates were clamped, without duplicating a label", () => {
    const s = expandSchedule([entry({ label: "Rent", dayOfMonth: 31 })], "2026-01-01", "2026-06-30");
    // Clamped in February, April and June — reported once.
    expect(s.clampedLabels).toEqual(["Rent"]);
  });

  it("an empty schedule is empty, not zero-valued", () => {
    const s = expandSchedule([], "2026-08-01", "2026-08-31");
    expect(s.byDay.size).toBe(0);
    expect(s.occurrences).toEqual([]);
    expect(s.totalPaise).toBe(0n);
  });
});
