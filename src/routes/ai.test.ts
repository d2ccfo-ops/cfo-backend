import { describe, expect, it } from "vitest";
import { encodeSseFrame } from "./ai.js";

// The transport half of POST /ai/ask/stream. The loop's behaviour is asserted
// in modules/ai/stream.test.ts; what is left here is the framing, which is the
// part that can corrupt a correct answer on the way out.
describe("encodeSseFrame", () => {
  it("emits one terminated SSE data frame", () => {
    expect(encodeSseFrame({ type: "stage", stage: "resolving" })).toBe('data: {"type":"stage","stage":"resolving"}\n\n');
  });

  it("never lets an answer's newline end the frame early", () => {
    // The real failure: a directAnswer containing a line break, written raw,
    // terminates the event mid-object and the client parses half an answer as
    // the whole one — a truncated figure presented as complete.
    const frame = encodeSseFrame({
      type: "error",
      message: "line one\nline two\n\nline three",
    });
    // Exactly one frame terminator, at the end.
    expect(frame.split("\n\n")).toHaveLength(2);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.slice("data: ".length))).toEqual({
      type: "error",
      message: "line one\nline two\n\nline three",
    });
  });

  it("round-trips a done frame carrying the whole AskResult", () => {
    const result = {
      conversationId: "convo_1",
      runId: "run_1",
      status: "COMPLETED" as const,
      answer: {
        directAnswer: "Net revenue was ₹12,45,000.",
        keyFigures: [{ label: "Net revenue", value: "₹12,45,000", source: "get_revenue_summary" }],
        drivers: [],
        evidence: ["/evidence/revenue"],
        dataStatus: "reconciled",
        warnings: [],
        recommendedAction: null,
      },
      toolCalls: [{ name: "get_revenue_summary", ok: true, durationMs: 7 }],
      toolEvidence: { get_revenue_summary: "/evidence/revenue" },
      verification: { ok: true, figuresChecked: 1, unsupportedFigures: [], unknownSources: [], piiHits: [] },
      turns: 2,
    };

    const parsed = JSON.parse(encodeSseFrame({ type: "done", result }).slice("data: ".length));
    // Money survives the frame verbatim — it is a formatted string from a tool
    // result, and a lossy transport would be a wrong figure on screen.
    expect(parsed.result).toEqual(result);
  });
});
