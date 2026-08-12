import { describe, expect, it } from "vitest";
import { buildDigest, type DigestInputs } from "./digest.js";
import type { DailyMetricMove } from "../calc/dailySnapshot.js";

// P3.3. What an email SAYS is testable without sending one, so it is tested
// here — buildDigest is pure by construction for exactly that reason.

function move(over: Partial<DailyMetricMove> = {}): DailyMetricMove {
  return {
    metric: { key: "available_cash", label: "Available cash", sources: { label: "bank", providers: ["BANK"] }, kind: "position", unit: "paise", betterWhen: "higher" },
    current: { day: "2026-08-11", valueMinor: "5000000", value: 50000, valueNumeric: null, confidence: "PROVISIONAL", computedAt: "" },
    previous: { day: "2026-08-10", valueMinor: "4000000", value: 40000, valueNumeric: null, confidence: "PROVISIONAL", computedAt: "" },
    deltaMinor: "1000000", delta: 10000, deltaNumeric: null, changePct: 25, direction: "up", previousIsAdjacent: true,
    ...over,
  } as DailyMetricMove;
}

function inputs(over: Partial<DigestInputs> = {}): DigestInputs {
  return { orgName: "Acme", kind: "daily", day: "2026-08-11", moves: [move()], notifications: [], ...over };
}

describe("buildDigest", () => {
  it("refuses to send an empty email", () => {
    // A daily digest that arrives every morning saying nothing is how a founder
    // learns to filter the sender — and after that the one that mattered is
    // unread too.
    const d = buildDigest(inputs({ moves: [], notifications: [] }));
    expect(d.worthSending).toBe(false);
    expect(d.reason).toBeTruthy();
  });

  it("refuses when everything is flat", () => {
    const flat = move({ direction: "flat", deltaMinor: "0", delta: 0 });
    expect(buildDigest(inputs({ moves: [flat] })).worthSending).toBe(false);
  });

  it("distinguishes 'no history' from 'nothing changed'", () => {
    expect(buildDigest(inputs({ moves: [] })).reason).toMatch(/no snapshot history/i);
    expect(buildDigest(inputs({ moves: [move({ direction: "flat" })] })).reason).toMatch(/nothing changed/i);
  });

  it("puts the most important fact in the subject", () => {
    const d = buildDigest(inputs({ notifications: [{ severity: "CRITICAL", title: "Cash below threshold", body: "x" }] }));
    expect(d.subject).toMatch(/1 critical/);
    expect(d.subject).toMatch(/Acme/);
  });

  it("formats every money figure as rupees, never as a raw number", () => {
    const d = buildDigest(inputs());
    expect(d.text).toMatch(/₹/);
    // The regression this guards is the one that shipped in P2.2e: a paise
    // figure rendered through a Number and landing in prose as "638333.1".
    expect(d.text).not.toMatch(/(?<![₹\d])\d+\.\d+(?!\s*%)/);
  });

  it("marks a move good or bad by the metric's own direction, not by its sign", () => {
    // Cash going up is good; RTO going up is not. A digest that renders both
    // as a green arrow is worse than one with no arrows at all.
    const cashUp = buildDigest(inputs()).text;
    expect(cashUp).toMatch(/up .*✓/);
    const rtoUp = buildDigest(
      inputs({
        moves: [
          move({
            metric: { key: "rto_rate_28d", label: "RTO rate", sources: { label: "courier", providers: ["SHIPROCKET"] }, kind: "rate", unit: "pct", betterWhen: "lower" } as never,
            current: { day: "2026-08-11", valueMinor: null, value: null, valueNumeric: 12.5, confidence: "ESTIMATED", computedAt: "" },
            previous: { day: "2026-08-10", valueMinor: null, value: null, valueNumeric: 10, confidence: "ESTIMATED", computedAt: "" },
            deltaMinor: null, delta: null, deltaNumeric: 2.5, direction: "up",
          }),
        ],
      })
    ).text;
    expect(rtoUp).toMatch(/up .*✗/);
  });

  it("orders critical above everything else", () => {
    const d = buildDigest(
      inputs({
        notifications: [
          { severity: "WARNING", title: "Stale bank feed", body: "b" },
          { severity: "CRITICAL", title: "Shopify sync failing", body: "b" },
        ],
      })
    );
    expect(d.text.indexOf("NEEDS ATTENTION")).toBeLessThan(d.text.indexOf("WORTH KNOWING"));
    expect(d.text.indexOf("Shopify sync failing")).toBeLessThan(d.text.indexOf("Stale bank feed"));
  });

  it("always says where the numbers came from", () => {
    // The email is a transcription of the deterministic engine's output. If it
    // ever disagrees with the dashboard, the dashboard is right, and that has
    // to be stated in the message rather than assumed.
    expect(buildDigest(inputs()).text).toMatch(/overnight snapshot/i);
    expect(buildDigest(inputs()).html).toMatch(/overnight snapshot/i);
  });

  it("escapes user-controlled text in the HTML part", () => {
    // Organisation names and notification bodies reach this. An unescaped
    // angle bracket in a mail client is a broken email at best.
    const d = buildDigest(inputs({ orgName: '<script>alert(1)</script>' }));
    expect(d.html).not.toMatch(/<script>/);
    expect(d.html).toMatch(/&lt;script&gt;/);
  });

  it("weekly and daily are labelled differently", () => {
    expect(buildDigest(inputs({ kind: "weekly" })).subject).toMatch(/Weekly summary/);
    expect(buildDigest(inputs({ kind: "daily" })).subject).toMatch(/Daily brief/);
  });
});
