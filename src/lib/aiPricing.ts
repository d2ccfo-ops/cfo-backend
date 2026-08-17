// What a model call cost us, in money.
//
// WHY THIS IS COMPUTED AND NOT STORED. AgentRun records four token counters
// and the model name; it does not record a cost. That is deliberate. Rates
// change — Sonnet 5 is on introductory pricing that expires on 2026-08-31 and
// rises 50% the next morning — and a cost column written at run time would
// freeze whichever rate happened to be live that day. Recomputing from tokens
// against an effective-dated table means last quarter's bill still reads the
// way last quarter was actually billed, and a rate correction fixes history
// instead of only the future.
//
// WHY THE THREE INPUT COUNTERS STAY SEPARATE. Anthropic bills uncached input,
// cache reads and cache writes at three different rates. Summing them into one
// "input tokens" figure — which is the obvious simplification — makes it
// impossible to tell whether prompt caching is working, which is the single
// biggest lever on this bill. So the rate table carries four rates, not two.
//
// MONEY IS AN INTEGER. Same rule as paise everywhere else in this codebase:
// floating point is not allowed to touch a figure anybody reports. The unit
// here is MICRODOLLARS (1e-6 USD) as bigint, because a single cheap question
// costs a fraction of a cent and rounding to cents would report most of this
// system's traffic as free. Serialise as a string over JSON, like paise.

/** One-millionth of a US dollar. The unit every function here returns. */
export type MicroUsd = bigint;

/**
 * Rates are quoted per MILLION tokens, in microdollars.
 *
 * So $3.00 per million input tokens is 3_000_000 microdollars per million
 * tokens — which divides out to exactly 3 microdollars per token. Quoting them
 * this way keeps the table readable against Anthropic's published price list
 * (multiply the dollar figure by 1e6) and keeps the arithmetic exact in bigint.
 */
export interface ModelRates {
  inputPerMillion: bigint;
  outputPerMillion: bigint;
  /** Cache reads bill at ~0.1x the input rate. */
  cacheReadPerMillion: bigint;
  /** Cache writes bill at ~1.25x the input rate. */
  cacheWritePerMillion: bigint;
}

interface RateEntry extends ModelRates {
  model: string;
  /**
   * The first instant this rate applies, as an ISO date. A run is priced with
   * the newest entry whose effectiveFrom is at or before the run's start.
   *
   * Entries are dated from when WE started being able to bill at them, not
   * from the model's launch — the two differ and only the former is a fact we
   * can check.
   */
  effectiveFrom: string;
}

const M = 1_000_000n;

/**
 * The rate table.
 *
 * ORDER DOES NOT MATTER — lookup sorts. Add a new rate as a NEW ROW with a new
 * effectiveFrom; never edit an existing row's numbers, because that silently
 * rewrites what past months cost.
 *
 * Verify against https://claude.com/pricing before trusting a total. These are
 * transcribed by hand and a transcription error here is invisible: it produces
 * a plausible number, not an error.
 */
const RATES: RateEntry[] = [
  // Sonnet 5 launched on introductory pricing of $2/$10 per million. That
  // introductory rate ENDS 2026-08-31; from 2026-09-01 it is $3/$15, a 50%
  // increase on the model that answers almost every question this product
  // asks. Both rows exist so the month the change lands is priced correctly on
  // both sides of it rather than retroactively at whichever rate is current.
  {
    model: "claude-sonnet-5",
    effectiveFrom: "2000-01-01",
    inputPerMillion: 2n * M,
    outputPerMillion: 10n * M,
    cacheReadPerMillion: 200_000n, // 0.1 x 2.00
    cacheWritePerMillion: 2_500_000n, // 1.25 x 2.00
  },
  {
    model: "claude-sonnet-5",
    effectiveFrom: "2026-09-01",
    inputPerMillion: 3n * M,
    outputPerMillion: 15n * M,
    cacheReadPerMillion: 300_000n, // 0.1 x 3.00
    cacheWritePerMillion: 3_750_000n, // 1.25 x 3.00
  },
  {
    model: "claude-haiku-4-5",
    effectiveFrom: "2000-01-01",
    inputPerMillion: 1n * M,
    outputPerMillion: 5n * M,
    cacheReadPerMillion: 100_000n,
    cacheWritePerMillion: 1_250_000n,
  },
  {
    model: "claude-opus-5",
    effectiveFrom: "2000-01-01",
    inputPerMillion: 5n * M,
    outputPerMillion: 25n * M,
    cacheReadPerMillion: 500_000n,
    cacheWritePerMillion: 6_250_000n,
  },
  {
    model: "claude-sonnet-4-6",
    effectiveFrom: "2000-01-01",
    inputPerMillion: 3n * M,
    outputPerMillion: 15n * M,
    cacheReadPerMillion: 300_000n,
    cacheWritePerMillion: 3_750_000n,
  },
  {
    model: "claude-opus-4-8",
    effectiveFrom: "2000-01-01",
    inputPerMillion: 5n * M,
    outputPerMillion: 25n * M,
    cacheReadPerMillion: 500_000n,
    cacheWritePerMillion: 6_250_000n,
  },
];

/** Every model this table can price. Used to report coverage honestly. */
export function pricedModels(): string[] {
  return [...new Set(RATES.map((r) => r.model))].sort();
}

/**
 * The rate in force for `model` at instant `at`, or null if we cannot price it.
 *
 * NULL IS A REAL ANSWER AND MUST NOT BE COERCED TO ZERO. An unknown model —
 * one swapped in via AI_MODEL without a rate being added here — would
 * otherwise report as free, and "free" is the one wrong answer that nobody
 * investigates. Callers surface unpriced runs as their own count.
 */
export function ratesFor(model: string, at: Date): ModelRates | null {
  const applicable = RATES.filter((r) => r.model === model && new Date(r.effectiveFrom) <= at);
  if (applicable.length === 0) return null;
  // Newest effectiveFrom wins.
  applicable.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  const winner = applicable[0];
  if (!winner) return null;
  const { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion } = winner;
  return { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion };
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CostBreakdown {
  input: MicroUsd;
  output: MicroUsd;
  cacheRead: MicroUsd;
  cacheWrite: MicroUsd;
  total: MicroUsd;
}

/** tokens x (microdollars per million) / one million, in exact integer maths. */
function line(tokens: number, perMillion: bigint): MicroUsd {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0n;
  return (BigInt(Math.trunc(tokens)) * perMillion) / M;
}

/**
 * What one run cost, split by rate class. Null when the model has no rate.
 *
 * Truncation is at the microdollar, i.e. one ten-thousandth of a cent, and is
 * always downward. Over a month of traffic that is a rounding error measured in
 * millionths of a dollar, and it errs toward understating rather than inventing.
 */
export function costOf(counts: TokenCounts, model: string, at: Date): CostBreakdown | null {
  const rates = ratesFor(model, at);
  if (!rates) return null;

  const input = line(counts.inputTokens, rates.inputPerMillion);
  const output = line(counts.outputTokens, rates.outputPerMillion);
  const cacheRead = line(counts.cacheReadTokens, rates.cacheReadPerMillion);
  const cacheWrite = line(counts.cacheWriteTokens, rates.cacheWritePerMillion);

  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * What the same traffic WOULD have cost with prompt caching switched off.
 *
 * The counterfactual, not the saving: every token that was read from cache or
 * written to it would instead have been billed as ordinary input. This is the
 * only honest way to state what caching is worth — comparing the cache-read
 * line against zero would credit caching for tokens that would never have been
 * sent at all.
 */
export function costWithoutCaching(counts: TokenCounts, model: string, at: Date): MicroUsd | null {
  const rates = ratesFor(model, at);
  if (!rates) return null;

  const allInput = counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens;
  return line(allInput, rates.inputPerMillion) + line(counts.outputTokens, rates.outputPerMillion);
}

/** Microdollars as a decimal USD string, for display. Never a float. */
export function formatUsd(micro: MicroUsd, decimals = 4): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / M;
  const frac = abs % M;
  const fracStr = frac.toString().padStart(6, "0").slice(0, decimals);
  return `${negative ? "-" : ""}${whole}${decimals > 0 ? "." + fracStr : ""}`;
}
