import { describe, expect, it } from "vitest";
import { historyEcho, parseStructuredAnswer, toAlternatingHistory } from "./orchestrator.js";

// Regression tests for a failure that cost 4 of 13 production runs.
//
// agent_messages.content holds prose (directAnswer), because a human reads that
// column too. Replaying it verbatim as the assistant's prior turn taught the
// model that prose was the accepted format, and it kept writing prose — three
// consecutive runs came back as markdown bullet lists, 580-865 output tokens
// each, all discarded. The fixture below is one of them, verbatim.

const REAL_FAILED_OUTPUT = `Confirmed with fresh data — same answer holds.

**Shopify is the only channel actually making money right now; Amazon has zero orders this month.**

**Channel breakdown (this month, CM2 = revenue − COGS − freight − payment fees):**
- **Shopify**: 548 orders, net revenue ₹9,33,541.11, CM2 of ₹5,60,771.88 (60.1% margin)
- **Amazon**: 0 orders, 0 revenue, but still has ₹38,538.19 of ad spend allocated to it`;

const answer = (over: Record<string, unknown> = {}) => ({
  headline: "Shopify is the only channel making money.",
  directAnswer: "Shopify cleared ₹5.6L of CM2 this month; Amazon took ad spend against no orders.",
  keyFigures: [
    { label: "Shopify CM2", value: "₹5,60,771.88", source: "get_contribution_margin" },
    { label: "Amazon orders", value: "0", source: "get_sales_summary" },
  ],
  drivers: ["Amazon had no orders"],
  evidence: ["/evidence/contribution_margin"],
  dataStatus: "provisional",
  warnings: ["7 order lines have no product cost attached"],
  recommendedAction: null,
  followUps: [],
  ...over,
});

describe("historyEcho — the assistant's prior turn is echoed as the contract", () => {
  it("replays a stored answer as JSON, not as the prose the column holds", () => {
    const echoed = historyEcho("Shopify cleared ₹5.6L of CM2 this month.", answer());
    const reparsed = JSON.parse(echoed);
    expect(reparsed.directAnswer).toContain("Shopify cleared");
    expect(reparsed.headline).toBe("Shopify is the only channel making money.");
    expect(reparsed.keyFigures[0]).toEqual({
      label: "Shopify CM2",
      value: "₹5,60,771.88",
      source: "get_contribution_margin",
    });
  });

  it("echoes a SUBSET — the bulk fields are not restated to the model", () => {
    const reparsed = JSON.parse(historyEcho("x", answer()));
    // Context, not a record. The founder already read these; paying to restate
    // them on every follow-up buys nothing.
    expect(reparsed).not.toHaveProperty("drivers");
    expect(reparsed).not.toHaveProperty("warnings");
    expect(reparsed).not.toHaveProperty("charts");
    expect(reparsed).not.toHaveProperty("evidence");
  });

  it("produces something that survives the history slice intact", () => {
    // toAlternatingHistory cuts at a byte offset. If the echo were longer than
    // that cut, the model would be shown malformed JSON as its own last reply —
    // teaching precisely the habit this function exists to prevent.
    const huge = answer({
      directAnswer: "x".repeat(5000),
      keyFigures: Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, value: `${i}`, source: "get_sales_summary" })),
    });
    const echoed = historyEcho("prose", huge);
    expect(echoed.length).toBeLessThan(1500);
    expect(() => JSON.parse(echoed)).not.toThrow();

    // And again after the real shaping path, which is where the slice lives.
    const shaped = toAlternatingHistory([
      { role: "USER", content: "which channel makes money?" },
      { role: "ASSISTANT", content: echoed },
    ]);
    expect(shaped).toHaveLength(2);
    expect(() => JSON.parse(shaped[1]!.content as string)).not.toThrow();
  });

  it("caps the figure list rather than echoing all of them", () => {
    const many = answer({
      keyFigures: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: `${i}`, source: "get_sales_summary" })),
    });
    expect(JSON.parse(historyEcho("p", many)).keyFigures).toHaveLength(4);
  });

  it("falls back to the prose when there is no stored structure", () => {
    // Pre-contract rows and salvaged FAILED runs both land here.
    expect(historyEcho("just prose", null)).toBe("just prose");
    expect(historyEcho("just prose", undefined)).toBe("just prose");
    expect(historyEcho("just prose", "not an object")).toBe("just prose");
    expect(historyEcho("just prose", [1, 2])).toBe("just prose");
    expect(historyEcho("just prose", { headline: "no direct answer" })).toBe("just prose");
    expect(historyEcho("just prose", { directAnswer: "   " })).toBe("just prose");
  });

  it("round-trips: what it echoes is what parseStructuredAnswer accepts", () => {
    // The point of the echo is to model the required output. If the parser
    // would reject it, it is modelling the wrong thing.
    const parsed = parseStructuredAnswer(historyEcho("p", answer()));
    expect(parsed).not.toBeNull();
    expect(parsed!.directAnswer).toContain("Shopify cleared");
  });
});

describe("the failure this prevents", () => {
  it("the real discarded output is genuinely unparseable — no leniency could have saved it", () => {
    // Worth pinning: the fix had to be upstream. parseStructuredAnswer already
    // strips fences and hunts an embedded object, and this text contains no
    // JSON at all, so no amount of parser tolerance would have recovered it.
    expect(parseStructuredAnswer(REAL_FAILED_OUTPUT)).toBeNull();
    expect(REAL_FAILED_OUTPUT).not.toContain("{");
  });

  it("the same answer, echoed through the fixed path, parses", () => {
    expect(parseStructuredAnswer(historyEcho(REAL_FAILED_OUTPUT, answer()))).not.toBeNull();
  });
});
