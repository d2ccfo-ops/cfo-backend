import { TOOLS_BY_NAME } from "./tools.js";
import type { StructuredAnswer } from "./orchestrator.js";

// P4.7's core check, extracted so both the eval runner and the restriction
// script use ONE implementation of "did the model make this number up".
//
// The rule the whole AI design rests on: every figure in an answer must appear
// in a tool result. This is the harness that enforces it, and it is deliberately
// a string match rather than anything cleverer — a semantic check would have to
// understand the arithmetic, and the entire point is that no arithmetic was
// supposed to happen.

/** Every number-looking token in a piece of text, normalised for comparison. */
export function extractFigures(text: string): string[] {
  // Indian-grouped and plain numbers, with or without a currency mark and
  // decimals. Percentages are included: "margin is 11.5%" is as much a claim
  // as a rupee figure, and as fabricable.
  const matches = text.match(/₹?\s?-?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
  return matches
    .map((m) => m.replace(/[₹\s,]/g, "").replace(/%$/, ""))
    .filter((m) => m.length > 0 && m !== "-")
    // Single digits are noise: "1 of 6 legs", "top 3 SKUs", a §-reference. A
    // fabricated figure that matters is never one character long, and
    // including them makes every answer fail on ordinary English.
    .filter((m) => m.replace(/[.\-]/g, "").length > 1);
}

export interface FigureVerdict {
  figure: string;
  found: boolean;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  unsupported: string[];
  verdicts: FigureVerdict[];
}

/**
 * Check every figure in an answer against the concatenated tool results.
 *
 * Tolerances, and why each is not a loophole:
 *  - Trailing ".0" — a model writing 12 for 12.0 has not invented anything.
 *  - Rupee/paise pairing — tools return both "124050" and 1240.5, so an answer
 *    quoting either is quoting the tool.
 *  - Lakh/crore rendering — "₹12.45 L" for 1245000. Checked by matching the
 *    digits, so 12.46 still fails.
 */
export function verifyFigures(answer: StructuredAnswer, toolOutputs: string[]): VerifyResult {
  const haystack = toolOutputs.join(" ").replace(/[₹\s,]/g, "");
  const text = [
    answer.directAnswer,
    ...answer.keyFigures.map((f) => `${f.label} ${f.value}`),
    ...answer.drivers,
  ].join(" ");

  const verdicts: FigureVerdict[] = [];
  for (const figure of new Set(extractFigures(text))) {
    const candidates = new Set<string>([figure]);
    if (figure.endsWith(".0")) candidates.add(figure.slice(0, -2));
    if (!figure.includes(".")) candidates.add(`${figure}.0`);
    // A rupee figure quoted from a paise field, and vice versa.
    const asNumber = Number(figure);
    if (Number.isFinite(asNumber)) {
      candidates.add(String(Math.round(asNumber * 100)));
      if (Number.isInteger(asNumber / 100)) candidates.add(String(asNumber / 100));
      // Lakh and crore, as a founder would write them.
      candidates.add(String(Math.round(asNumber * 100000)));
      candidates.add(String(Math.round(asNumber * 10000000)));
    }
    const found = [...candidates].some((c) => haystack.includes(c));
    verdicts.push({ figure, found });
  }

  const unsupported = verdicts.filter((v) => !v.found).map((v) => v.figure);
  return { ok: unsupported.length === 0, checked: verdicts.length, unsupported, verdicts };
}

/** Every source named in keyFigures must be a tool that exists. */
export function verifySources(answer: StructuredAnswer): { ok: boolean; unknown: string[] } {
  const unknown = answer.keyFigures
    .map((f) => f.source)
    .filter((s) => s.length > 0 && !TOOLS_BY_NAME.has(s));
  return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
}

// §27: no raw PII may appear in an answer. Masking happens on tool output, so
// anything matching here got there by the model inventing it or by a masking
// gap — both worth failing over.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}\b/;

export function verifyNoPii(answer: StructuredAnswer): { ok: boolean; hits: string[] } {
  const text = JSON.stringify(answer);
  const hits: string[] = [];
  if (EMAIL_RE.test(text)) hits.push("email");
  if (PHONE_RE.test(text)) hits.push("phone");
  return { ok: hits.length === 0, hits };
}
