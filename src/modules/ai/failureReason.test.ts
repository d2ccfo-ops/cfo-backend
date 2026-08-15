import { describe, expect, it } from "vitest";
import { failureReason } from "./orchestrator.js";

// A real FAILED row in this database reads: 1 turn, 6 output tokens, error
// "The model did not return a valid structured answer." Six tokens is not a
// truncated answer — it is the model stopping or declining — and nothing in
// that row could tell the two apart. These tests pin the distinction, because
// the wording IS the diagnostic: it is what a founder reads on the page and
// what the next person to open agent_runs has to work from.

describe("failureReason", () => {
  it("names the output limit when the answer was cut off", () => {
    const msg = failureReason("max_tokens", 16_000);
    expect(msg).toContain("cut off");
    // The actual number, so nobody has to go find the constant to know
    // whether raising it would help.
    expect(msg).toMatch(/\d/);
  });

  it("says the model declined, and points at the dashboard", () => {
    const msg = failureReason("refusal", 12);
    expect(msg).toContain("declined");
    // Never a dead end: every figure the answer would have quoted is on a
    // page the founder can already open.
    expect(msg.toLowerCase()).toContain("dashboard");
  });

  it("distinguishes a pause from a failure", () => {
    expect(failureReason("pause_turn", 40)).toContain("paused");
  });

  it("reports the output size for genuinely malformed answers", () => {
    // The case that motivated this: the size is the whole signal. Zero tokens
    // and three thousand unparseable tokens are different bugs.
    expect(failureReason("end_turn", 6)).toContain("6 output tokens");
    expect(failureReason("end_turn", 0)).toContain("0 output tokens");
    expect(failureReason("end_turn", 1)).toContain("1 output token");
    expect(failureReason("end_turn", 1)).not.toContain("1 output tokens");
  });

  it("carries the raw stop_reason through, including when there is none", () => {
    // Whatever the API called it, so an unrecognised value is still traceable
    // rather than being flattened into the default sentence.
    expect(failureReason("end_turn", 6)).toContain("end_turn");
    expect(failureReason(null, 6)).toContain("none");
  });

  it("never returns an empty or placeholder message", () => {
    for (const reason of ["max_tokens", "refusal", "pause_turn", "end_turn", "stop_sequence", null]) {
      const msg = failureReason(reason, 5);
      expect(msg.length, `stop_reason=${reason}`).toBeGreaterThan(20);
      expect(msg, `stop_reason=${reason}`).not.toContain("undefined");
    }
  });
});
