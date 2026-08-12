import { describe, expect, it } from "vitest";
import { parseBriefNarrative, renderDiffForModel } from "./dailyBrief.js";
import type { DailyMetricMove } from "../calc/dailySnapshot.js";

// The brief's two pure halves: what the model is shown, and what is accepted
// back. Both matter more than usual because there are no tools in this path —
// the rendered text IS the complete set of figures the narrative is entitled
// to use, so anything missing from it is a figure the model cannot legally
// write, and anything wrongly stated in it becomes a wrong sentence nobody
// can trace.

const spec = (key: string, label: string, unit: "minor" | "pct" | "count" | "months", betterWhen: "higher" | "lower" | null) =>
  ({ key, label, unit, betterWhen }) as DailyMetricMove["metric"];

const move = (over: Partial<DailyMetricMove> & { metric: DailyMetricMove["metric"] }): DailyMetricMove => ({
  current: { valueMinor: null, valueNumeric: null, day: "2026-08-11", confidence: "MEASURED", computedAt: new Date() } as never,
  previous: null,
  deltaMinor: null,
  delta: null,
  deltaNumeric: null,
  changePct: null,
  direction: null,
  previousIsAdjacent: true,
  ...over,
});

describe("renderDiffForModel", () => {
  it("formats money through formatInr, never as a raw number", () => {
    const text = renderDiffForModel(
      [
        move({
          metric: spec("available_cash", "Available cash", "minor", "higher"),
          current: { valueMinor: "63833310", valueNumeric: null } as never,
          deltaMinor: "-500000",
          direction: "down",
        }),
      ],
      []
    );
    // The bug this guards: paiseToRupees returns a Number, and a Number in
    // prose renders as "638333.1" — which a model will then quote verbatim.
    expect(text).not.toMatch(/638333\.1/);
    expect(text).toContain("₹");
  });

  it("states when a move is not against the adjacent day", () => {
    const text = renderDiffForModel(
      [
        move({
          metric: spec("available_cash", "Available cash", "minor", "higher"),
          current: { valueMinor: "100000", valueNumeric: null } as never,
          deltaMinor: "10000",
          direction: "up",
          previousIsAdjacent: false,
        }),
      ],
      []
    );
    // A brief that says "cash rose overnight" off a three-day gap is
    // describing three days while claiming one.
    expect(text).toContain("NOT the adjacent day");
  });

  it("does not claim a gap when the comparison is adjacent", () => {
    const text = renderDiffForModel(
      [
        move({
          metric: spec("available_cash", "Available cash", "minor", "higher"),
          current: { valueMinor: "100000", valueNumeric: null } as never,
          deltaMinor: "10000",
          direction: "up",
          previousIsAdjacent: true,
        }),
      ],
      []
    );
    expect(text).not.toContain("NOT the adjacent day");
  });

  it("says there is nothing to compare rather than implying zero change", () => {
    const text = renderDiffForModel(
      [move({ metric: spec("rto_rate_28d", "RTO rate", "pct", "lower"), current: { valueMinor: null, valueNumeric: 11.5 } as never })],
      []
    );
    expect(text).toContain("no earlier snapshot");
    expect(text).toContain("11.5%");
  });

  it("carries the snapshot engine's own warnings through", () => {
    const text = renderDiffForModel([], ["the order source never observed 2026-08-11"]);
    expect(text).toContain("never observed");
  });

  it("tells the model which direction is good", () => {
    const text = renderDiffForModel([move({ metric: spec("rto_rate_28d", "RTO rate", "pct", "lower"), current: { valueMinor: null, valueNumeric: 11.5 } as never })], []);
    expect(text).toContain("higher is worse");
  });
});

describe("parseBriefNarrative", () => {
  const good = {
    headline: "Cash fell ₹5,00,000 overnight.",
    whatChanged: ["Available cash: ₹6,38,333"],
    whyItMatters: ["Runway shortens"],
    watchFor: [],
    caveats: [],
  };

  it("accepts the contract", () => {
    expect(parseBriefNarrative(JSON.stringify(good))?.headline).toBe(good.headline);
  });

  it("tolerates a markdown fence", () => {
    expect(parseBriefNarrative("```json\n" + JSON.stringify(good) + "\n```")).not.toBeNull();
  });

  it("rejects an object with no headline", () => {
    // An object that does not say anything is not a narrative in a different
    // format; it is a failure, and storing it would print an empty card.
    expect(parseBriefNarrative(JSON.stringify({ ...good, headline: "" }))).toBeNull();
    expect(parseBriefNarrative(JSON.stringify({ whatChanged: [] }))).toBeNull();
  });

  it("rejects prose", () => {
    expect(parseBriefNarrative("Cash fell overnight and margin held.")).toBeNull();
  });

  it("drops non-string array members rather than rendering [object Object]", () => {
    const parsed = parseBriefNarrative(JSON.stringify({ ...good, whatChanged: ["ok", { a: 1 }, 5] }));
    expect(parsed?.whatChanged).toEqual(["ok"]);
  });
});
