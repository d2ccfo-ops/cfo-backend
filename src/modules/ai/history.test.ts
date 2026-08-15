import { describe, expect, it } from "vitest";
import { toAlternatingHistory } from "./orchestrator.js";

// The API rejects a messages array that has two consecutive same-role turns,
// does not start with a user turn, or contains an empty content string — and
// it rejects the WHOLE request, so one malformed stored row makes a thread
// permanently unusable rather than degrading it. agent_messages can hold all
// three shapes: a FAILED run leaves a USER row with no reply, and content is a
// plain String column with no non-empty constraint.

const u = (content: string) => ({ role: "USER" as const, content });
const a = (content: string) => ({ role: "ASSISTANT" as const, content });

describe("toAlternatingHistory", () => {
  it("passes a clean thread through in order", () => {
    expect(toAlternatingHistory([u("what was revenue?"), a("₹12.4L"), u("and margin?"), a("38%")])).toEqual([
      { role: "user", content: "what was revenue?" },
      { role: "assistant", content: "₹12.4L" },
      { role: "user", content: "and margin?" },
      { role: "assistant", content: "38%" },
    ]);
  });

  it("drops a question whose run failed, rather than sending two user turns", () => {
    // The realistic case: the founder asked, the run errored, they asked again.
    // Without this the thread is bricked — every later question 400s.
    const out = toAlternatingHistory([u("q1"), a("a1"), u("q2 that failed"), u("q3")]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("never ends on a user turn, because the new question is appended next", () => {
    const out = toAlternatingHistory([u("q1"), a("a1"), u("q2 unanswered")]);
    expect(out[out.length - 1]!.role).toBe("assistant");
  });

  it("never starts on an assistant turn", () => {
    // Happens whenever the message cap slices into the middle of a thread.
    const out = toAlternatingHistory([a("orphaned answer"), u("q"), a("a")]);
    expect(out[0]!.role).toBe("user");
    expect(out).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("skips empty and whitespace-only content without breaking alternation", () => {
    const out = toAlternatingHistory([u("q1"), a("   "), u("q2"), a("a2")]);
    // The blank answer is dropped, which would leave q1 and q2 adjacent — the
    // dedupe keeps the newer one, and the pair stays well formed.
    expect(out).toEqual([
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  it("truncates a long stored answer instead of replaying it whole", () => {
    const out = toAlternatingHistory([u("q"), a("x".repeat(5000))]);
    expect((out[1]!.content as string).length).toBe(1_500);
  });

  it("returns nothing for an empty or unusable thread", () => {
    expect(toAlternatingHistory([])).toEqual([]);
    expect(toAlternatingHistory([u("only a question")])).toEqual([]);
    expect(toAlternatingHistory([a("only an answer")])).toEqual([]);
  });
});
