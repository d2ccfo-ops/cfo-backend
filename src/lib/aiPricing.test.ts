import { describe, expect, it } from "vitest";
import { costOf, costWithoutCaching, formatUsd, ratesFor } from "./aiPricing.js";

// A cost figure has a failure mode that a latency figure does not: it is always
// plausible. Nobody looks at "$4.12" and knows it is wrong, so these tests pin
// the arithmetic rather than the shape.

const M = 1_000_000;
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("rate lookup", () => {
  it("prices a million input tokens of Sonnet 5 at $2 during the introductory period", () => {
    const cost = costOf({ ...zero, inputTokens: M }, "claude-sonnet-5", new Date("2026-08-17T00:00:00Z"));
    expect(cost?.total).toBe(2_000_000n); // $2.00 in microdollars
  });

  // THE REASON EFFECTIVE DATING EXISTS. Sonnet 5's introductory pricing ends
  // 2026-08-31; from the next morning the same traffic costs 50% more. A single
  // current-rate table would silently reprice every past month the day this
  // lands, and nobody would notice because the new numbers look just as
  // reasonable as the old ones.
  it("switches to $3 on 2026-09-01 and leaves August priced at $2", () => {
    const august = costOf({ ...zero, inputTokens: M }, "claude-sonnet-5", new Date("2026-08-31T23:59:00Z"));
    const september = costOf({ ...zero, inputTokens: M }, "claude-sonnet-5", new Date("2026-09-01T00:00:00Z"));
    expect(august?.total).toBe(2_000_000n);
    expect(september?.total).toBe(3_000_000n);
  });

  it("returns null for a model it has no rate for, rather than zero", () => {
    expect(ratesFor("claude-something-unreleased", new Date())).toBeNull();
    expect(costOf({ ...zero, inputTokens: M }, "claude-something-unreleased", new Date())).toBeNull();
  });
});

describe("the four rate classes", () => {
  const at = new Date("2026-08-17T00:00:00Z"); // Sonnet 5 at $2 / $10

  it("bills output at five times input", () => {
    const cost = costOf({ ...zero, outputTokens: M }, "claude-sonnet-5", at);
    expect(cost?.total).toBe(10_000_000n);
  });

  it("bills a cache read at a tenth of input", () => {
    const cost = costOf({ ...zero, cacheReadTokens: M }, "claude-sonnet-5", at);
    expect(cost?.total).toBe(200_000n); // 0.1 x $2.00
  });

  it("bills a cache write at 1.25x input", () => {
    const cost = costOf({ ...zero, cacheWriteTokens: M }, "claude-sonnet-5", at);
    expect(cost?.total).toBe(2_500_000n); // 1.25 x $2.00
  });

  it("keeps the classes separate in the breakdown", () => {
    const cost = costOf(
      { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: M },
      "claude-sonnet-5",
      at,
    );
    expect(cost).toEqual({
      input: 2_000_000n,
      output: 10_000_000n,
      cacheRead: 200_000n,
      cacheWrite: 2_500_000n,
      total: 14_700_000n,
    });
  });
});

describe("the caching counterfactual", () => {
  const at = new Date("2026-08-17T00:00:00Z");

  // The claim on the console is "caching saved us $X". That claim is only
  // honest if the comparison is against the same tokens billed as ordinary
  // input — not against zero, which would credit caching for tokens that would
  // never have been sent in the first place.
  it("reprices cached tokens at the full input rate", () => {
    const counts = { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 900_000, cacheWriteTokens: 0 };
    const actual = costOf(counts, "claude-sonnet-5", at);
    const uncached = costWithoutCaching(counts, "claude-sonnet-5", at);

    // 100k at $2/M = 200_000; 900k at $0.20/M = 180_000
    expect(actual?.total).toBe(380_000n);
    // All 1M billed at $2/M
    expect(uncached).toBe(2_000_000n);
    expect((uncached ?? 0n) - (actual?.total ?? 0n)).toBe(1_620_000n); // $1.62 saved
  });

  it("is null for an unpriceable model, so a saving is never invented", () => {
    expect(costWithoutCaching({ ...zero, inputTokens: M }, "nope", at)).toBeNull();
  });
});

describe("edge cases", () => {
  const at = new Date("2026-08-17T00:00:00Z");

  it("treats zero tokens as zero cost, not as unknown", () => {
    expect(costOf(zero, "claude-sonnet-5", at)?.total).toBe(0n);
  });

  it("ignores negative counts rather than crediting them", () => {
    const cost = costOf({ ...zero, inputTokens: -5_000 }, "claude-sonnet-5", at);
    expect(cost?.total).toBe(0n);
  });

  it("stays exact on counts that would lose precision as floats", () => {
    // 12,345,678 tokens at $2/M is exactly 24,691,356 microdollars. Computed in
    // floating point this is the kind of figure that comes back as
    // 24691355.999999996 and then rounds the wrong way.
    const cost = costOf({ ...zero, inputTokens: 12_345_678 }, "claude-sonnet-5", at);
    expect(cost?.total).toBe(24_691_356n);
  });
});

describe("formatting", () => {
  it("renders microdollars without floating point", () => {
    expect(formatUsd(2_000_000n)).toBe("2.0000");
    expect(formatUsd(380_000n)).toBe("0.3800");
    expect(formatUsd(1n)).toBe("0.0000"); // sub-precision, not rounded up to a cent
    expect(formatUsd(14_700_000n, 2)).toBe("14.70");
  });
});
