import { describe, expect, it } from "vitest";
import { canonicalNumber, enrichFigures, type ToolResultRecord } from "./enrichFigures.js";

// The single rule under test: ONLY COPY, NEVER COMPUTE.
//
// Most of these cases are not "does the happy path work" but "does the module
// refuse when it cannot be sure". That asymmetry is the point — a missing
// delta renders as no delta, while a wrong one is a measured-looking number
// shown against something it does not describe.

/** get_revenue_summary, as modules/calc/revenue.ts actually returns it. */
const revenueResult = (over: Record<string, unknown> = {}): ToolResultRecord => ({
  name: "get_revenue_summary",
  result: {
    data: {
      metricKey: "net_revenue_mtd",
      currency: "INR",
      valueMinor: "124500000",
      value: 1245000,
      priorValueMinor: "136000000",
      priorValue: 1360000,
      changePct: -8.4,
      orderCount: 412,
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-07-31T00:00:00.000Z",
      comparison: "previous_month",
      formulaVersion: "v1",
      ...over,
    },
    dataStatus: { status: "provisional", reasons: ["Not verified against a bank credit."] },
    evidenceRef: "/evidence/revenue",
  },
});

/** get_sales_summary — several metrics, each with its own changePct. */
const salesResult: ToolResultRecord = {
  name: "get_sales_summary",
  result: {
    data: {
      currency: "INR",
      comparison: "previous_period",
      grossSales: { metricKey: "gross_sales_mtd", valueMinor: "150000000", value: 1500000, priorValueMinor: "140000000", priorValue: 1400000, changePct: 7.1 },
      orders: { metricKey: "order_count_mtd", value: 412, priorValue: 500, changePct: -17.6, recognised: 400 },
      averageOrderValue: { metricKey: "aov_mtd", value: 3640, priorValue: 2800, changePct: 30 },
      discounts: { metricKey: "discount_rate_mtd", valueMinor: "9000000", value: 90000, ratePct: 6, priorRatePct: 4.5 },
    },
    evidenceRef: "/revenue",
  },
};

const figure = (label: string, value: string, source: string) => ({ label, value, source });

describe("canonicalNumber", () => {
  it("reads a rupee figure and a bare number to the same canonical form", () => {
    expect(canonicalNumber("₹12,45,000")).toBe("1245000");
    expect(canonicalNumber(1245000)).toBe("1245000");
    expect(canonicalNumber("6%")).toBe("6");
    expect(canonicalNumber("1240.50")).toBe("1240.5");
  });

  it("refuses anything that is not plainly a number", () => {
    // An ISO date and a version string must never be mistaken for a value.
    expect(canonicalNumber("2026-07-01T00:00:00.000Z")).toBeNull();
    expect(canonicalNumber("v1")).toBeNull();
    expect(canonicalNumber("previous_month")).toBeNull();
    expect(canonicalNumber(null)).toBeNull();
    expect(canonicalNumber(Number.NaN)).toBeNull();
  });
});

describe("enrichFigures — copying what a tool measured", () => {
  it("copies changePct, its direction, the comparison and the dataStatus verbatim", () => {
    const [f] = enrichFigures([figure("Net revenue", "₹12,45,000", "get_revenue_summary")], [revenueResult()]);
    expect(f).toEqual({
      label: "Net revenue",
      value: "₹12,45,000",
      source: "get_revenue_summary",
      delta: -8.4,
      deltaDirection: "down",
      comparison: "previous_month",
      dataStatus: { status: "provisional", reasons: ["Not verified against a bank credit."] },
    });
  });

  it("reads direction from the sign the tool gave, never from a magnitude", () => {
    const dir = (changePct: number | null) =>
      enrichFigures([figure("Net revenue", "₹12,45,000", "get_revenue_summary")], [revenueResult({ changePct })])[0]!
        .deltaDirection;
    expect(dir(7.1)).toBe("up");
    expect(dir(-8.4)).toBe("down");
    expect(dir(0)).toBe("flat");
    expect(dir(null)).toBeUndefined();
  });

  it("matches a paise field, and a lakh rendering, to the same metric", () => {
    const paise = enrichFigures([figure("Net revenue", "124500000 paise", "get_revenue_summary")], [revenueResult()])[0]!;
    expect(paise.delta).toBe(-8.4);
    const lakh = enrichFigures([figure("Net revenue", "₹12.45 lakh", "get_revenue_summary")], [revenueResult()])[0]!;
    expect(lakh.delta).toBe(-8.4);
  });

  it("gives each metric of a multi-metric tool its own delta", () => {
    const out = enrichFigures(
      [
        figure("Gross sales", "₹15,00,000", "get_sales_summary"),
        figure("Orders", "412", "get_sales_summary"),
        figure("AOV", "₹3,640", "get_sales_summary"),
      ],
      [salesResult]
    );
    expect(out.map((f) => f.delta)).toEqual([7.1, -17.6, 30]);
    expect(out.map((f) => f.deltaDirection)).toEqual(["up", "down", "up"]);
    // The comparison label is inherited from the result that carries it.
    expect(out.every((f) => f.comparison === "previous_period")).toBe(true);
  });
});

describe("enrichFigures — refusing when it cannot be sure", () => {
  it("attaches no delta when the tool measured none, even though a prior value is present", () => {
    // The trap this exists for: priorValue and value are both here, and
    // subtracting them would produce a delta. That subtraction is forbidden.
    const [f] = enrichFigures(
      [figure("Net revenue", "₹12,45,000", "get_revenue_summary")],
      [revenueResult({ changePct: null })]
    );
    expect(f!.delta).toBeUndefined();
    expect(f!.deltaDirection).toBeUndefined();
    expect(f!.comparison).toBeUndefined();
    // dataStatus is a property of the fetch, not of the delta, so it stays.
    expect(f!.dataStatus).toEqual({ status: "provisional", reasons: ["Not verified against a bank credit."] });
  });

  it("attaches no delta to a figure the tool result carries no measured change for", () => {
    // Discount rate has a priorRatePct but no changePct. No delta exists.
    const [f] = enrichFigures([figure("Discount rate", "6%", "get_sales_summary")], [salesResult]);
    expect(f!.delta).toBeUndefined();
  });

  it("never lends one metric's delta to a sibling the delta does not describe", () => {
    // orderCount sits beside net revenue's changePct in the same object.
    // Copying "the tool's changePct" onto it would be a measured number shown
    // against the wrong metric.
    const [f] = enrichFigures([figure("Orders", "412", "get_revenue_summary")], [revenueResult()]);
    expect(f!.delta).toBeUndefined();
  });

  it("attaches no delta to a figure that quotes the PRIOR period's value", () => {
    const [f] = enrichFigures([figure("June net revenue", "₹13,60,000", "get_revenue_summary")], [revenueResult()]);
    expect(f!.delta).toBeUndefined();
  });

  it("attaches no delta when two calls of the same tool disagree", () => {
    // Asked for July and for June. Both results are get_revenue_summary, and
    // a figure that matches neither uniquely could belong to either.
    const july = revenueResult();
    const june = revenueResult({ changePct: 4.2, value: 1360000, valueMinor: "136000000", priorValue: 1300000 });
    const [ambiguous] = enrichFigures([figure("Net revenue", "₹13,60,000", "get_revenue_summary")], [july, june]);
    // ₹13,60,000 is July's priorValue AND June's value — but priorValue is
    // never an anchor, so only June matches and its delta is the right one.
    expect(ambiguous!.delta).toBe(4.2);

    // Now make both results genuinely claim the same value with different
    // measured changes. Nothing can decide between them.
    const collision = revenueResult({ changePct: 4.2 });
    const [f] = enrichFigures([figure("Net revenue", "₹12,45,000", "get_revenue_summary")], [july, collision]);
    expect(f!.delta).toBeUndefined();
    expect(f!.comparison).toBeUndefined();
  });

  it("keeps the delta when two calls of the same tool agree exactly", () => {
    const [f] = enrichFigures(
      [figure("Net revenue", "₹12,45,000", "get_revenue_summary")],
      [revenueResult(), revenueResult()]
    );
    expect(f!.delta).toBe(-8.4);
  });

  it("drops dataStatus when two calls of the same tool report different statuses", () => {
    const stale: ToolResultRecord = {
      name: "get_revenue_summary",
      result: { ...(revenueResult().result as object), dataStatus: { status: "estimated", reasons: ["Seeded costs."] } },
    };
    const [f] = enrichFigures([figure("Net revenue", "₹12,45,000", "get_revenue_summary")], [revenueResult(), stale]);
    expect(f!.dataStatus).toBeUndefined();
  });

  it("leaves a figure untouched when no tool result matches its source", () => {
    const input = [figure("Net revenue", "₹12,45,000", "get_burn_and_runway")];
    const [f] = enrichFigures(input, [revenueResult()]);
    expect(f).toEqual(input[0]);
  });

  it("leaves a figure untouched when its value is not a number", () => {
    const [f] = enrichFigures([figure("Runway", "not enough data", "get_revenue_summary")], [revenueResult()]);
    expect(f!.delta).toBeUndefined();
    // The envelope status still applies to the fetch.
    expect(f!.dataStatus).toBeDefined();
  });

  it("never mutates the figures it was given", () => {
    const input = [figure("Net revenue", "₹12,45,000", "get_revenue_summary")];
    enrichFigures(input, [revenueResult()]);
    expect(input[0]).toEqual({ label: "Net revenue", value: "₹12,45,000", source: "get_revenue_summary" });
  });

  it("adds nothing at all when there are no tool results", () => {
    const input = [figure("Net revenue", "₹12,45,000", "get_revenue_summary")];
    expect(enrichFigures(input, [])).toEqual(input);
  });

  it("survives a tool result that is not an object", () => {
    expect(() =>
      enrichFigures([figure("x", "12", "get_revenue_summary")], [{ name: "get_revenue_summary", result: null }])
    ).not.toThrow();
  });

  it("finds a delta inside an array of per-row results", () => {
    const rows: ToolResultRecord = {
      name: "get_product_profitability",
      result: {
        data: {
          comparison: "previous_month",
          topByMargin: [
            { sku: "A-1", value: 50000, changePct: 12.5 },
            { sku: "B-2", value: 30000, changePct: -3 },
          ],
        },
        dataStatus: { status: "estimated", reasons: ["Seeded costs."] },
      },
    };
    const out = enrichFigures(
      [figure("A-1 margin", "₹50,000", "get_product_profitability"), figure("B-2 margin", "₹30,000", "get_product_profitability")],
      [rows]
    );
    expect(out.map((f) => f.delta)).toEqual([12.5, -3]);
  });
});
