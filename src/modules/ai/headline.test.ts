import { describe, expect, it } from "vitest";
import { parseStructuredAnswer } from "./orchestrator.js";
import { verifyFigures } from "./verify.js";

// The headline is the one new thing the model produces for the richer render,
// and it is LANGUAGE — a verdict sentence, no arithmetic. These tests pin the
// two properties that matter: an answer without one is still an answer, and a
// figure smuggled into one is still caught.

const answer = (over: Record<string, unknown>) =>
  JSON.stringify({ directAnswer: "Net revenue fell.", keyFigures: [], drivers: [], evidence: [], dataStatus: "provisional", warnings: [], recommendedAction: null, ...over });

describe("parseStructuredAnswer — headline", () => {
  it("keeps a verdict sentence", () => {
    const parsed = parseStructuredAnswer(answer({ headline: "July was a volume drop, not a price drop." }));
    expect(parsed!.headline).toBe("July was a volume drop, not a price drop.");
  });

  it("omits the key entirely when the model gave no headline", () => {
    // Not "" — a UI that renders on presence must not be handed an empty
    // verdict bar. An answer written before this field existed still parses.
    const parsed = parseStructuredAnswer(answer({}));
    expect(parsed).not.toBeNull();
    expect("headline" in parsed!).toBe(false);
  });

  it("omits a blank or non-string headline rather than carrying it through", () => {
    expect("headline" in parseStructuredAnswer(answer({ headline: "   " }))!).toBe(false);
    expect("headline" in parseStructuredAnswer(answer({ headline: 42 }))!).toBe(false);
  });

  it("still requires directAnswer — a headline alone is not an answer", () => {
    expect(parseStructuredAnswer(JSON.stringify({ headline: "Revenue fell." }))).toBeNull();
  });
});

describe("verifyFigures — the headline is checked too", () => {
  const base = {
    directAnswer: "Net revenue fell.",
    keyFigures: [],
    drivers: [],
    evidence: [],
    dataStatus: "provisional",
    warnings: [],
    recommendedAction: null,
  };

  it("catches a figure the model put in the verdict sentence", () => {
    // The prompt forbids this. The prompt is not the enforcement.
    const result = verifyFigures({ ...base, headline: "Revenue fell 8.4% in July." }, ['{"changePct":-3.2}']);
    expect(result.ok).toBe(false);
    expect(result.unsupported).toContain("8.4");
  });

  it("passes a figure-free verdict sentence", () => {
    const result = verifyFigures({ ...base, headline: "July was a volume drop, not a price drop." }, ["{}"]);
    expect(result.ok).toBe(true);
  });
});

describe("parseStructuredAnswer — followUps", () => {
  it("keeps the offered questions, capped at three", () => {
    const parsed = parseStructuredAnswer(
      answer({ followUps: ["Break this down by channel", "Which SKUs sold that day?", "  q3  ", "q4"] })
    );
    expect(parsed!.followUps).toEqual(["Break this down by channel", "Which SKUs sold that day?", "q3"]);
  });

  it("is [] when absent, malformed, or full of non-strings — never undefined", () => {
    expect(parseStructuredAnswer(answer({}))!.followUps).toEqual([]);
    expect(parseStructuredAnswer(answer({ followUps: "one" }))!.followUps).toEqual([]);
    expect(parseStructuredAnswer(answer({ followUps: [1, null, "", "real one"] }))!.followUps).toEqual(["real one"]);
  });
});
