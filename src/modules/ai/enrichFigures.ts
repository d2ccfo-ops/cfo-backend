// §19 answer enrichment — the SERVER's half of a rich answer.
//
// THE RULE THIS FILE EXISTS TO MAKE TESTABLE: only copy, never compute.
//
// The reference design renders each key figure with a delta, a comparison
// label and a freshness/status marker. The obvious way to produce those is to
// let the model write them, or to let this file subtract two figures it can
// see. Both are forbidden — §1 says the LLM never calculates money, and a
// server that derives "−8.4%" by dividing two tool outputs has simply moved
// the fabrication one layer down, into code nobody reads as arithmetic.
//
// So this module does exactly one thing: it looks inside the tool results the
// run already collected and, WHERE THE TOOL ITSELF ALREADY MEASURED A CHANGE,
// copies that measurement onto the figure verbatim. A tool with no changePct
// yields a figure with no delta, and the UI renders without one. There is no
// subtraction, no division and no fallback anywhere below.
//
// WHY MATCHING IS BY VALUE AND NOT BY TOOL NAME ALONE
//
// A tool name is not a metric. get_sales_summary returns gross sales, order
// count, AOV, discount rate and refund rate, each with its own changePct;
// get_revenue_summary returns net revenue's changePct next to an orderCount
// that it does not describe. Copying "the tool's changePct" onto every figure
// citing that tool would attach the order-count delta to AOV — a number that
// was measured, shown against something it does not describe. That is a
// fabricated claim assembled out of true parts.
//
// So a delta is attached only when the figure's own value can be located in
// the same object that carries the delta. If the figure cannot be located, or
// locates two nodes that disagree, NOTHING is attached. Both failure modes
// degrade to "no delta", which is the direction that cannot lie.

/** The model's half of a key figure — what parseStructuredAnswer produces. */
export interface KeyFigure {
  label: string;
  value: string;
  source: string;
}

export type DeltaDirection = "up" | "down" | "flat";

/** A key figure after the server has copied across what the tools measured. */
export interface EnrichedKeyFigure extends KeyFigure {
  /** The tool's own changePct, verbatim. Never derived here. */
  delta?: number | string;
  /** The sign of the tool's delta. Reading a sign, not computing a value. */
  deltaDirection?: DeltaDirection;
  /** The tool's own comparison label, e.g. "previous_month". */
  comparison?: string;
  /** The tool's own §28 status for this metric, verbatim ({status, reasons}). */
  dataStatus?: unknown;
}

/** One successful tool call: the name the model cites, and what it returned. */
export interface ToolResultRecord {
  name: string;
  result: unknown;
  /**
   * The arguments the model called the tool with.
   *
   * Optional because enrichFigures does not need them — a figure cites a tool
   * by name and that is enough. answerCharts DOES need them: the same tool
   * called with different arguments answers a different question, and
   * deduplicating on the name alone made a "day by day" answer carry a
   * six-month chart. See the note on answerCharts().
   */
  args?: unknown;
}

// The ONLY fields treated as a measured change.
//
// Deliberately a closed list of one rather than a pattern like /change|delta/.
// A pattern would sweep up changePctTotal, changedAt or a future field whose
// meaning nobody checked, and the cost of a wrong guess here is a delta shown
// against the wrong metric. Extending this list is a deliberate act with a
// test attached.
const DELTA_FIELDS = ["changePct"] as const;

// Which of a node's own fields may identify the figure the delta describes.
//
// Same asymmetry as above: a key omitted from here costs a delta that could
// have been shown (safe), while a key wrongly included attaches a real delta
// to the wrong number (not safe). So: the canonical money/rate fields the calc
// modules return, plus any *Pct rate — and never a count sitting beside them.
// get_revenue_summary's orderCount is exactly the trap this closes: it is a
// sibling of changePct, and changePct does not describe it.
const VALUE_FIELDS = new Set(["value", "valueMinor", "amount", "amountMinor"]);

function isAnchorField(key: string): boolean {
  if ((DELTA_FIELDS as readonly string[]).includes(key)) return false;
  // priorValue / priorRatePct describe the PREVIOUS period. A figure quoting
  // one is the prior number, and the delta does not describe it.
  if (/^prior/i.test(key)) return false;
  // changePctTotal and friends are other deltas, not values.
  if (/^change/i.test(key)) return false;
  return VALUE_FIELDS.has(key) || /Pct$/.test(key);
}

/**
 * A number as a single canonical string, so "₹12,45,000" and 1245000 compare
 * equal. Returns null for anything that is not plainly a number — an ISO date
 * or a formulaVersion must never look like a value.
 */
export function canonicalNumber(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[₹,\s]/g, "").replace(/%$/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? String(n) : null;
}

/**
 * The forms a founder-facing figure might take, for LOCATING it in a tool
 * result. Scaling here is a search key, never an output: nothing derived by
 * these multipliers is ever shown — they only decide which already-measured
 * delta belongs to which already-measured figure.
 *
 * "₹12.45 L" and 1245000 are the same number written two ways, and the answer
 * writes it the way a founder here would.
 */
function figureAnchors(value: string): Set<string> {
  const anchors = new Set<string>();
  // The first numeric token only. keyFigure.value is one figure by contract,
  // and a second token in the string is a parenthetical, not the subject.
  const token = value.match(/-?\d[\d,]*(?:\.\d+)?/)?.[0];
  if (!token) return anchors;
  const canon = canonicalNumber(token);
  if (canon === null) return anchors;
  anchors.add(canon);
  const n = Number(canon);
  if (!Number.isFinite(n)) return anchors;
  // Rupees quoted against a paise field, lakh and crore against the full
  // number. Rounded, because 12.45 * 1e5 is not exactly 1245000 in binary.
  for (const scale of [100, 100_000, 10_000_000]) {
    anchors.add(String(Math.round(n * scale)));
  }
  return anchors;
}

interface DeltaNode {
  delta: number | string;
  deltaDirection: DeltaDirection;
  comparison?: string;
  dataStatus?: unknown;
  /** Canonical forms of this node's OWN value fields. */
  anchors: Set<string>;
}

interface Scope {
  comparison?: string;
  dataStatus?: unknown;
}

/** Direction is the SIGN of the number the tool gave. No magnitude is derived. */
function directionOf(delta: number | string): DeltaDirection | null {
  const n = typeof delta === "number" ? delta : Number(delta);
  if (!Number.isFinite(n)) return null;
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

/** The delta a node carries, or null. Null changePct means "no comparison". */
function deltaOf(node: Record<string, unknown>): number | string | null {
  for (const field of DELTA_FIELDS) {
    const raw = node[field];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    // A numeric string is copied through as the tool wrote it.
    if (typeof raw === "string" && canonicalNumber(raw) !== null) return raw;
  }
  return null;
}

// A tool result is a small envelope; this bound only stops a pathological or
// cyclic payload from walking forever.
const MAX_DEPTH = 8;

function scopeOf(node: Record<string, unknown>, inherited: Scope): Scope {
  return {
    comparison: typeof node.comparison === "string" ? node.comparison : inherited.comparison,
    dataStatus: node.dataStatus !== undefined ? node.dataStatus : inherited.dataStatus,
  };
}

/** Every node in one tool result that carries a measured change. */
function collectDeltaNodes(value: unknown, inherited: Scope, out: DeltaNode[], depth = 0): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectDeltaNodes(item, inherited, out, depth + 1);
    return;
  }

  const node = value as Record<string, unknown>;
  const scope = scopeOf(node, inherited);
  const delta = deltaOf(node);
  if (delta !== null) {
    const direction = directionOf(delta);
    if (direction) {
      const anchors = new Set<string>();
      for (const [key, raw] of Object.entries(node)) {
        if (!isAnchorField(key)) continue;
        const canon = canonicalNumber(raw);
        if (canon !== null) anchors.add(canon);
      }
      // A node whose only numeric field IS the delta describes nothing we can
      // identify, so it can never be matched — recorded with empty anchors and
      // therefore never selected.
      out.push({ delta, deltaDirection: direction, comparison: scope.comparison, dataStatus: scope.dataStatus, anchors });
    }
  }

  for (const child of Object.values(node)) collectDeltaNodes(child, scope, out, depth + 1);
}

/** Stable identity of an enrichment, for deciding whether two matches agree. */
function enrichmentKey(node: DeltaNode): string {
  return JSON.stringify([node.delta, node.deltaDirection, node.comparison ?? null, node.dataStatus ?? null]);
}

/**
 * Attach what the tools already measured to each key figure.
 *
 * Pure and synchronous: given the same figures and the same tool results it
 * returns the same objects, which is what makes "only copy, never compute"
 * something a test can assert rather than something a comment claims. Input
 * figures are never mutated.
 */
export function enrichFigures(figures: KeyFigure[], results: ToolResultRecord[]): EnrichedKeyFigure[] {
  // One pass over the run's tool results, indexed by the name a figure cites.
  const byName = new Map<string, { nodes: DeltaNode[]; statuses: unknown[] }>();
  for (const record of results) {
    if (!record.name) continue;
    let entry = byName.get(record.name);
    if (!entry) {
      entry = { nodes: [], statuses: [] };
      byName.set(record.name, entry);
    }
    const root = record.result && typeof record.result === "object" && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : null;
    const rootScope = root ? scopeOf(root, {}) : {};
    if (rootScope.dataStatus !== undefined) entry.statuses.push(rootScope.dataStatus);
    collectDeltaNodes(record.result, {}, entry.nodes);
  }

  return figures.map((figure) => {
    const entry = byName.get(figure.source);
    if (!entry) return { ...figure };

    const enriched: EnrichedKeyFigure = { ...figure };

    // dataStatus is a property of the fetch, not of the delta: it is the
    // tool's own §28 label for the data it returned, so it is copied whenever
    // the run's calls for that tool agree on one. Two calls disagreeing means
    // the answer mixes two states, and labelling it as either would be a
    // claim nothing measured.
    if (entry.statuses.length > 0) {
      const distinct = new Set(entry.statuses.map((s) => JSON.stringify(s)));
      if (distinct.size === 1) enriched.dataStatus = entry.statuses[0];
    }

    const anchors = figureAnchors(figure.value);
    if (anchors.size === 0) return enriched;

    const matches = entry.nodes.filter((node) => {
      for (const anchor of anchors) if (node.anchors.has(anchor)) return true;
      return false;
    });
    if (matches.length === 0) return enriched;

    // Two nodes matched and they disagree — e.g. the same tool called for two
    // periods, or two metrics that happen to share a value. Which delta
    // describes this figure is unknown, and a guess is a fabrication.
    const distinct = new Set(matches.map(enrichmentKey));
    if (distinct.size !== 1) return enriched;

    const match = matches[0]!;
    enriched.delta = match.delta;
    enriched.deltaDirection = match.deltaDirection;
    // The comparison LABELS the delta ("vs previous_month"). Without a delta
    // it is a caption over nothing, so the two travel together.
    if (match.comparison !== undefined) enriched.comparison = match.comparison;
    if (match.dataStatus !== undefined) enriched.dataStatus = match.dataStatus;
    return enriched;
  });
}
