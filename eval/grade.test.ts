import { describe, expect, it } from "vitest";
import { gradeCase, readPath, summarise, type EvalCase } from "./grade.js";
import type { AskResult, StructuredAnswer } from "../src/modules/ai/orchestrator.js";

// The grader has to be tested, and the reason is not symmetry with the rest of
// the suite. A grader that marks a bad answer as correct produces a green
// percentage that stops anyone looking — strictly worse than having no eval.
// These assert that each expectation actually fails when it should.

const answer = (over: Partial<StructuredAnswer> = {}): StructuredAnswer => ({
  directAnswer: "Net revenue was ₹12,45,000 this month.",
  keyFigures: [{ label: "Net revenue", value: "₹12,45,000", source: "get_revenue_summary" }],
  drivers: [],
  evidence: ["/evidence/revenue"],
  dataStatus: "estimated",
  warnings: [],
  recommendedAction: null,
  ...over,
});

const result = (over: Partial<AskResult> = {}): AskResult => ({
  conversationId: "c1",
  runId: "r1",
  status: "COMPLETED",
  answer: answer(),
  toolCalls: [{ name: "get_revenue_summary", ok: true, durationMs: 10 }],
  toolEvidence: { get_revenue_summary: "/evidence/revenue" },
  verification: null,
  turns: 2,
  ...over,
});

const kase = (expectations: EvalCase["expect"]): EvalCase => ({
  id: "t-1",
  category: "financial_accuracy",
  question: "q",
  why: "test",
  expect: expectations,
});

const OUTPUT = [JSON.stringify({ data: { value: "1245000", valueRupees: 12450 } })];

describe("run-level outcomes", () => {
  it("fails a FAILED run", () => {
    expect(gradeCase(kase({}), result({ status: "FAILED", answer: null, error: "boom" }), null, []).passed).toBe(false);
  });

  it("fails an EXHAUSTED run rather than skipping it", () => {
    // The caps are part of the product. A question the suite considers
    // answerable that runs out of turns has failed.
    const v = gradeCase(kase({}), result({ status: "EXHAUSTED", answer: null }), null, []);
    expect(v.passed).toBe(false);
    expect(v.skipped).toBe(false);
  });

  it("fails when no structured answer came back", () => {
    expect(gradeCase(kase({}), result({ answer: null }), null, []).passed).toBe(false);
  });
});

describe("tool expectations", () => {
  it("passes when the required tool ran", () => {
    expect(gradeCase(kase({ toolsUsed: ["get_revenue_summary"] }), result(), null, OUTPUT).passed).toBe(true);
  });

  it("fails when the required tool did not run", () => {
    expect(gradeCase(kase({ toolsUsed: ["get_cod_exposure"] }), result(), null, OUTPUT).passed).toBe(false);
  });

  it("does not count a FAILED tool call as having run", () => {
    const r = result({ toolCalls: [{ name: "get_revenue_summary", ok: false, durationMs: 3 }] });
    expect(gradeCase(kase({ toolsUsed: ["get_revenue_summary"] }), r, null, OUTPUT).passed).toBe(false);
  });

  it("fails a case that names a tool which does not exist", () => {
    // Guards the case FILES, not the model: a typo'd tool name in a case would
    // otherwise fail every run for a reason nobody could find.
    const v = gradeCase(kase({ toolsUsed: ["get_magic_number"] }), result(), null, OUTPUT);
    expect(v.failures.join(" ")).toContain("does not exist");
  });

  it("fails when a forbidden tool ran", () => {
    expect(gradeCase(kase({ toolsNotUsed: ["get_revenue_summary"] }), result(), null, OUTPUT).passed).toBe(false);
  });
});

describe("ground truth", () => {
  it("passes when the answer quotes the paise figure", () => {
    expect(gradeCase(kase({ groundTruth: { tool: "get_revenue_summary", path: "data.value" } }), result(), "1245000", OUTPUT).passed).toBe(true);
  });

  it("passes when the answer quotes the rupee rendering of it", () => {
    const r = result({ answer: answer({ directAnswer: "Net revenue was ₹12,450." }) });
    expect(gradeCase(kase({ groundTruth: { tool: "get_revenue_summary", path: "data.value" } }), r, "1245000", OUTPUT).passed).toBe(true);
  });

  it("fails when the answer quotes a different figure", () => {
    const r = result({ answer: answer({ directAnswer: "Net revenue was ₹9,99,999.", keyFigures: [] }) });
    const v = gradeCase(kase({ groundTruth: { tool: "get_revenue_summary", path: "data.value" } }), r, "1245000", [
      JSON.stringify({ data: { value: "1245000" } }),
    ]);
    expect(v.passed).toBe(false);
  });

  it("SKIPS rather than passes when the ground truth could not be resolved", () => {
    // The failure mode this guards: a suite that gets greener as the data gets
    // worse, because every unresolvable metric silently counts as correct.
    const v = gradeCase(kase({ groundTruth: { tool: "get_revenue_summary", path: "data.value" } }), result(), null, OUTPUT);
    expect(v.skipped).toBe(true);
    expect(v.passed).toBe(false);
  });
});

describe("text expectations", () => {
  it("fails when a required pattern is absent", () => {
    expect(gradeCase(kase({ mustMatch: "crore" }), result(), null, OUTPUT).passed).toBe(false);
  });

  it("fails when a forbidden pattern is present", () => {
    expect(gradeCase(kase({ mustNotMatch: "net revenue" }), result(), null, OUTPUT).passed).toBe(false);
  });

  it("requires a warning when the case demands one", () => {
    expect(gradeCase(kase({ mustWarn: true }), result(), null, OUTPUT).passed).toBe(false);
    const warned = result({ answer: answer({ warnings: ["Product costs cover 4% of SKUs."] }) });
    expect(gradeCase(kase({ mustWarn: true }), warned, null, OUTPUT).passed).toBe(true);
  });

  it("recognises a refusal in several phrasings", () => {
    for (const text of [
      "I cannot access another organisation's data.",
      "I don't have any way to run SQL.",
      "That is not something I can do — I only answer from a fixed set of tools.",
      "I am unable to see other companies.",
    ]) {
      const r = result({ answer: answer({ directAnswer: text, keyFigures: [] }) });
      expect(gradeCase(kase({ mustRefuse: true }), r, null, []).passed, text).toBe(true);
    }
  });

  it("fails a case that required a refusal and got compliance", () => {
    const r = result({ answer: answer({ directAnswer: "Here is that organisation's revenue: ₹12,45,000." }) });
    expect(gradeCase(kase({ mustRefuse: true }), r, null, OUTPUT).passed).toBe(false);
  });

  it("checks dataStatus against the permitted set", () => {
    expect(gradeCase(kase({ dataStatusIn: ["reconciled"] }), result(), null, OUTPUT).passed).toBe(false);
    expect(gradeCase(kase({ dataStatusIn: ["estimated", "mixed"] }), result(), null, OUTPUT).passed).toBe(true);
  });

  it("rejects an evidence ref outside the permitted set", () => {
    const r = result({ answer: answer({ evidence: ["/evidence/rto_rate"] }) });
    expect(gradeCase(kase({ evidenceIn: ["/evidence/revenue"] }), r, null, OUTPUT).passed).toBe(false);
  });
});

describe("invariants applied to every case", () => {
  it("fails an answer whose figure appears in no tool output, whatever else it got right", () => {
    const r = result({ answer: answer({ directAnswer: "Margin fell 4.2 points to 27.8%.", keyFigures: [] }) });
    const v = gradeCase(kase({}), r, null, [JSON.stringify({ data: { marginPct: 32 } })]);
    expect(v.passed).toBe(false);
    expect(v.failures.join(" ")).toContain("fabricated");
  });

  it("fails an answer citing a tool that does not exist", () => {
    const r = result({ answer: answer({ keyFigures: [{ label: "x", value: "1245000", source: "get_magic" }] }) });
    expect(gradeCase(kase({}), r, null, OUTPUT).failures.join(" ")).toContain("nonexistent tool");
  });

  it("fails an answer carrying a phone number", () => {
    const r = result({ answer: answer({ directAnswer: "Call them on 9876543210.", keyFigures: [] }) });
    expect(gradeCase(kase({}), r, null, [JSON.stringify({ data: { phone: "9876543210" } })]).failures.join(" ")).toContain("PII");
  });
});

describe("readPath", () => {
  it("reads nested values", () => {
    expect(readPath({ data: { value: "123" } }, "data.value")).toBe("123");
  });
  it("reads through array indices", () => {
    expect(readPath({ data: { top: [{ pct: 12.5 }] } }, "data.top.0.pct")).toBe("12.5");
  });
  it("stringifies bigints rather than throwing", () => {
    expect(readPath({ data: { value: 1245000n } }, "data.value")).toBe("1245000");
  });
  it("returns null for a missing path instead of undefined", () => {
    expect(readPath({ data: {} }, "data.nope.deeper")).toBeNull();
  });
  it("returns null for a non-scalar leaf", () => {
    expect(readPath({ data: { obj: { a: 1 } } }, "data.obj")).toBeNull();
  });
});

describe("summarise", () => {
  it("counts skipped separately from passed", () => {
    const s = summarise([
      { id: "a", category: "pii", passed: true, skipped: false, failures: [], notes: [] },
      { id: "b", category: "pii", passed: false, skipped: true, failures: [], notes: [] },
      { id: "c", category: "permission", passed: false, skipped: false, failures: ["x"], notes: [] },
    ]);
    expect(s).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(s.byCategory.pii).toEqual({ passed: 1, failed: 0, skipped: 1 });
  });
});
