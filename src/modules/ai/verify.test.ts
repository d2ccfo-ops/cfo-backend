import { describe, expect, it } from "vitest";
import { extractFigures, verifyFigures, verifyNoPii, verifySources } from "./verify.js";
import type { StructuredAnswer } from "./orchestrator.js";

// P4.7. The string-match harness is the single mechanism standing between "the
// LLM never calculates money" as a rule and as a wish, so it is tested harder
// than most things here — including the ways it could WRONGLY pass, which are
// more dangerous than the ways it could wrongly fail.

function answer(over: Partial<StructuredAnswer> = {}): StructuredAnswer {
  return {
    directAnswer: "Net revenue was ₹12,45,000 this month.",
    keyFigures: [{ label: "Net revenue", value: "₹12,45,000", source: "get_revenue_summary" }],
    drivers: [],
    evidence: [],
    dataStatus: "estimated",
    warnings: [],
    recommendedAction: null,
    ...over,
  };
}

describe("extractFigures", () => {
  it("finds Indian-grouped rupee figures", () => {
    expect(extractFigures("₹12,45,000 and ₹8,20,000")).toEqual(["1245000", "820000"]);
  });
  it("finds percentages, which are as fabricable as amounts", () => {
    expect(extractFigures("margin fell to 11.5%")).toContain("11.5");
  });
  it("ignores single digits so ordinary English does not fail", () => {
    // "1 of 6 legs", "top 3 SKUs" — a fabricated figure that matters is never
    // one character long.
    expect(extractFigures("4 of 6 legs ran, top 3 SKUs")).toEqual([]);
  });
  it("handles negatives", () => {
    expect(extractFigures("closing at -47,04,237")).toContain("-4704237");
  });
});

describe("verifyFigures", () => {
  it("passes a figure that appears verbatim in a tool result", () => {
    const r = verifyFigures(answer(), ['{"valueMinor":"124500000","value":1245000}']);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(1);
  });

  it("FAILS a figure that appears nowhere — the whole point", () => {
    const r = verifyFigures(answer(), ['{"valueMinor":"999900","value":9999}']);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain("1245000");
  });

  it("catches arithmetic the model did itself", () => {
    // Tools returned 1245000 and 820000; the model subtracted. 425000 appears
    // in no tool result, and that is exactly what must be caught.
    const r = verifyFigures(
      answer({ directAnswer: "Revenue is ₹12,45,000, up ₹4,25,000 on last month's ₹8,20,000." }),
      ['{"a":"1245000","b":"820000"}']
    );
    expect(r.ok).toBe(false);
    expect(r.unsupported).toEqual(["425000"]);
  });

  it("accepts a rupee figure quoted from a paise field, and the reverse", () => {
    expect(verifyFigures(answer({ directAnswer: "₹12,450" }), ['{"valueMinor":"1245000"}']).ok).toBe(true);
    expect(verifyFigures(answer({ directAnswer: "1245000 paise" }), ['{"value":12450}']).ok).toBe(true);
  });

  it("accepts lakh rendering but not a wrong one", () => {
    expect(verifyFigures(answer({ directAnswer: "about ₹12.45 L", keyFigures: [] }), ['{"v":"1245000"}']).ok).toBe(true);
    expect(verifyFigures(answer({ directAnswer: "about ₹12.46 L", keyFigures: [] }), ['{"v":"1245000"}']).ok).toBe(false);
  });

  it("tolerates a trailing .0 in either direction", () => {
    expect(verifyFigures(answer({ directAnswer: "11.0%", keyFigures: [] }), ['{"pct":11}']).ok).toBe(true);
    expect(verifyFigures(answer({ directAnswer: "11%", keyFigures: [] }), ['{"pct":11.0}']).ok).toBe(true);
  });

  it("checks drivers and keyFigures, not just the headline", () => {
    // A fabricated number is just as harmful in a "what caused this" bullet.
    const r = verifyFigures(
      answer({ directAnswer: "Revenue held.", keyFigures: [], drivers: ["Ad spend rose to ₹3,33,333"] }),
      ['{"v":"1245000"}']
    );
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain("333333");
  });

  it("is not fooled by a figure that is only a substring of a longer number", () => {
    // 4500 appears inside 1245000 as digits, but "12450" does not contain
    // "4500" — guard that the haystack match is on the stripped digits and a
    // genuinely absent figure still fails.
    const r = verifyFigures(answer({ directAnswer: "₹98,765", keyFigures: [] }), ['{"v":"1245000"}']);
    expect(r.ok).toBe(false);
  });
});

describe("verifySources", () => {
  it("passes when every source names a real tool", () => {
    expect(verifySources(answer()).ok).toBe(true);
  });
  it("fails an invented tool name", () => {
    const r = verifySources(answer({ keyFigures: [{ label: "x", value: "1", source: "get_magic_number" }] }));
    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(["get_magic_number"]);
  });
});

describe("verifyNoPii", () => {
  it("passes a clean answer", () => {
    expect(verifyNoPii(answer()).ok).toBe(true);
  });
  it("fails an email or a phone number anywhere in the structure", () => {
    expect(verifyNoPii(answer({ drivers: ["contact ravi@example.com"] })).hits).toContain("email");
    expect(verifyNoPii(answer({ warnings: ["call 98765 43210"] })).hits).toContain("phone");
  });
});
