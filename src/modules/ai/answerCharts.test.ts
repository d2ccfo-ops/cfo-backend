import { describe, expect, it } from "vitest";
import { answerCharts } from "./answerCharts.js";

// The charts a founder sees inside an AI answer. Every test here exists to
// pin down one way a chart could become a claim nobody measured — the failure
// mode is not "the chart looks wrong", it is "the chart looks right and is
// not true".

const envelope = (data: unknown) => ({ data });

const layer = (over: Record<string, unknown> = {}) => ({
  key: "cogs",
  label: "Product COGS",
  amount: 1200,
  amountMinor: "120000",
  covered: true,
  hasSource: true,
  ...over,
});

describe("answerCharts — contribution ladder", () => {
  it("charts the measured cost layers", () => {
    const [chart] = answerCharts([
      { name: "get_contribution_margin", result: envelope({ layers: [layer(), layer({ label: "Packaging", amount: 300 })] }) },
    ]);
    expect(chart!.kind).toBe("bar");
    expect(chart!.source).toBe("get_contribution_margin");
    expect(chart!.series[0]!.points).toEqual([
      { x: "Product COGS", y: 1200 },
      { x: "Packaging", y: 300 },
    ]);
  });

  it("drops memo layers — their rupees are already inside another layer", () => {
    const [chart] = answerCharts([
      {
        name: "get_contribution_margin",
        result: envelope({ layers: [layer(), layer({ key: "rto", label: "RTO cost", amount: 900, memo: true })] }),
      },
    ]);
    expect(chart!.series[0]!.points.map((p) => p.x)).toEqual(["Product COGS"]);
  });

  it("drops a layer with no source instead of drawing it at zero, and names it", () => {
    const [chart] = answerCharts([
      {
        name: "get_contribution_margin",
        result: envelope({ layers: [layer(), layer({ label: "Packaging", amount: 0, hasSource: false })] }),
      },
    ]);
    expect(chart!.series[0]!.points.map((p) => p.x)).toEqual(["Product COGS"]);
    expect(chart!.footnote).toContain("Packaging");
    expect(chart!.footnote).toContain("not measured");
  });

  it("yields no chart at all when every layer is unsourced", () => {
    expect(
      answerCharts([
        { name: "get_contribution_margin", result: envelope({ layers: [layer({ hasSource: false })] }) },
      ])
    ).toEqual([]);
  });
});

describe("answerCharts — cash forecast", () => {
  const days = [
    { date: "2026-08-01", closingMinor: "500000" },
    { date: "2026-08-02", closingMinor: "-250000" },
  ];

  it("charts the projected closing balance, converting paise to rupees", () => {
    const [chart] = answerCharts([{ name: "get_cash_forecast", result: envelope({ days }) }]);
    expect(chart!.kind).toBe("line");
    expect(chart!.series[0]!.points).toEqual([
      { x: "2026-08-01", y: 5000 },
      { x: "2026-08-02", y: -2500 },
    ]);
  });

  it("keeps a negative trough rather than flooring it at zero", () => {
    const [chart] = answerCharts([{ name: "get_cash_forecast", result: envelope({ days }) }]);
    expect(chart!.series[0]!.points.some((p) => p.y < 0)).toBe(true);
  });

  it("reports truncation instead of silently shortening the line", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ date: `d${i}`, closingMinor: "100" }));
    const [chart] = answerCharts([{ name: "get_cash_forecast", result: envelope({ days: many }) }]);
    expect(chart!.series[0]!.points).toHaveLength(90);
    expect(chart!.footnote).toContain("120");
  });

  it("covers the scenario re-run, which returns the same shape", () => {
    const [chart] = answerCharts([{ name: "run_forecast_scenario", result: envelope({ days }) }]);
    expect(chart?.kind).toBe("line");
  });
});

describe("answerCharts — loss-making products", () => {
  const sku = (over: Record<string, unknown> = {}) => ({
    sku: "SKU-1",
    productName: "Tee",
    cm0: -140,
    cm0Minor: "-14000",
    costed: true,
    ...over,
  });

  it("charts SKUs the calc already ranked, in the order it ranked them", () => {
    const [chart] = answerCharts([
      {
        name: "get_product_profitability",
        result: envelope({ bottomByMargin: [sku(), sku({ productName: "Cap", cm0: -20 })], totalSkuCount: 741 }),
      },
    ]);
    expect(chart!.series[0]!.points).toEqual([
      { x: "Tee", y: -140 },
      { x: "Cap", y: -20 },
    ]);
    expect(chart!.footnote).toContain("741");
  });

  it("skips an uncosted SKU — a null margin is unknown, not zero", () => {
    const [chart] = answerCharts([
      {
        name: "get_product_profitability",
        result: envelope({ bottomByMargin: [sku(), sku({ productName: "Mug", cm0: null, cm0Minor: null, costed: false })] }),
      },
    ]);
    expect(chart!.series[0]!.points.map((p) => p.x)).toEqual(["Tee"]);
  });
});

describe("answerCharts — revenue trend", () => {
  const bucket = (over: Record<string, unknown> = {}) => ({
    key: "2026-08-01",
    label: "1 Aug",
    netRevenue: 41000,
    cashReceived: 38000,
    ordersVisible: true,
    cashVisible: true,
    ...over,
  });

  it("plots both series when the bank covers the whole window", () => {
    const [chart] = answerCharts([
      {
        name: "get_revenue_trend",
        result: envelope({
          series: [bucket(), bucket({ label: "2 Aug", netRevenue: 52000, cashReceived: 47000 })],
          window: { granularity: "day" },
        }),
      },
    ]);
    expect(chart!.kind).toBe("line");
    expect(chart!.subtitle).toContain("day");
    expect(chart!.series.map((s) => s.name)).toEqual(["Net revenue", "Cash received"]);
    expect(chart!.series[1]!.points).toEqual([
      { x: "1 Aug", y: 38000 },
      { x: "2 Aug", y: 47000 },
    ]);
  });

  it("drops the cash series rather than misaligning it against revenue", () => {
    // toChartRows zips series by INDEX. A cash line covering half the window
    // would put an early bucket's cash under a late bucket's revenue — two real
    // numbers, silently paired into a false comparison.
    const [chart] = answerCharts([
      {
        name: "get_revenue_trend",
        result: envelope({
          series: [
            bucket({ label: "Jun", cashVisible: false, cashReceived: null }),
            bucket({ label: "Jul" }),
            bucket({ label: "Aug" }),
          ],
        }),
      },
    ]);
    expect(chart!.series).toHaveLength(1);
    expect(chart!.footnote).toContain("2 of 3");
  });

  it("skips a bucket from before the business had orders instead of plotting zero", () => {
    const [chart] = answerCharts([
      {
        name: "get_revenue_trend",
        result: envelope({
          series: [
            bucket({ label: "Mar", ordersVisible: false, netRevenue: null, cashVisible: false }),
            bucket({ label: "Jul" }),
            bucket({ label: "Aug" }),
          ],
        }),
      },
    ]);
    expect(chart!.series[0]!.points.map((p) => p.x)).toEqual(["Jul", "Aug"]);
  });

  it("offers no chart for a single bucket", () => {
    expect(
      answerCharts([{ name: "get_revenue_trend", result: envelope({ series: [bucket()] }) }])
    ).toEqual([]);
  });
});

describe("answerCharts — breakdown bars", () => {
  it("charts refunds by gateway from the grouped paise totals", () => {
    const [chart] = answerCharts([
      {
        name: "get_refund_analysis",
        result: envelope({
          byGateway: [
            { gateway: "RAZORPAY", count: 12, refundedPaise: "450000" },
            { gateway: "GOKWIK", count: 4, refundedPaise: "120000" },
          ],
        }),
      },
    ]);
    expect(chart!.kind).toBe("bar");
    expect(chart!.series[0]!.points).toEqual([
      { x: "RAZORPAY", y: 4500 },
      { x: "GOKWIK", y: 1200 },
    ]);
  });

  it("keeps the calc module's sort order rather than re-ranking", () => {
    // byGateway arrives sorted by the calc; a re-sort here would be this file
    // making a claim about which gateway matters most.
    const [chart] = answerCharts([
      {
        name: "get_settlement_summary",
        result: envelope({
          byProvider: [
            { provider: "GOKWIK", kind: "checkout", count: 2, netSettledPaise: "100000" },
            { provider: "RAZORPAY", kind: "gateway", count: 9, netSettledPaise: "900000" },
          ],
        }),
      },
    ]);
    expect(chart!.series[0]!.points.map((p) => p.x)).toEqual(["GOKWIK", "RAZORPAY"]);
  });

  it("offers no chart for a single group — one bar is a figure, not a chart", () => {
    expect(
      answerCharts([
        { name: "get_refund_analysis", result: envelope({ byGateway: [{ gateway: "RAZORPAY", refundedPaise: "100" }] }) },
      ])
    ).toEqual([]);
  });

  it("skips an ad platform whose value is null (mixed currency) rather than plotting zero", () => {
    const [chart] = answerCharts([
      {
        name: "get_ad_spend_analysis",
        result: envelope({
          byProvider: [
            { provider: "META_ADS", value: 42000, valueMinor: "4200000" },
            { provider: "GOOGLE_ADS", value: null, valueMinor: null },
            { provider: "AMAZON_ADS", value: 9000, valueMinor: "900000" },
          ],
        }),
      },
    ]);
    expect(chart!.series[0]!.points.map((p) => p.x)).toEqual(["META_ADS", "AMAZON_ADS"]);
  });
});

describe("answerCharts — the rules that keep it from inventing", () => {
  it("offers nothing for a tool with no extractor", () => {
    expect(answerCharts([{ name: "get_revenue_summary", result: envelope({ value: 1, changePct: -8 }) }])).toEqual([]);
  });

  it("offers nothing for a recognised tool whose shape does not match", () => {
    expect(answerCharts([{ name: "get_cash_forecast", result: envelope({ totals: { closingMinor: "1" } }) }])).toEqual([]);
  });

  it("never plots a non-numeric value", () => {
    const [chart] = answerCharts([
      {
        name: "get_contribution_margin",
        result: envelope({ layers: [layer(), layer({ label: "Bad", amount: "lots", amountMinor: "n/a" })] }),
      },
    ]);
    expect(chart!.series[0]!.points.map((p) => p.x)).toEqual(["Product COGS"]);
  });

  it("keeps one chart per tool when a run called the same tool twice", () => {
    const result = envelope({ days: [{ date: "d", closingMinor: "100" }] });
    expect(answerCharts([
      { name: "get_cash_forecast", result },
      { name: "get_cash_forecast", result },
    ])).toHaveLength(1);
  });

  it("returns charts in the order the run called the tools", () => {
    const charts = answerCharts([
      { name: "get_cash_forecast", result: envelope({ days: [{ date: "d", closingMinor: "100" }] }) },
      { name: "get_contribution_margin", result: envelope({ layers: [layer()] }) },
    ]);
    expect(charts.map((c) => c.source)).toEqual(["get_cash_forecast", "get_contribution_margin"]);
  });

  it("reads a bare tool result as well as the §19 envelope", () => {
    const [chart] = answerCharts([{ name: "get_contribution_margin", result: { layers: [layer()] } }]);
    expect(chart?.kind).toBe("bar");
  });
});
