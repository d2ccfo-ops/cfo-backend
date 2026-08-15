import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";
import { writeAudit } from "../../lib/audit.js";
import { DEFAULT_TIMEZONE, zonedDayKey } from "../../lib/dateRange.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { getDailySnapshotDiff, type DailyMetricMove } from "../calc/dailySnapshot.js";
import { formatInr } from "../calc/money.js";
import { verifyFigures, verifyNoPii } from "./verify.js";
import type { StructuredAnswer } from "./orchestrator.js";

// P4.5. The narrative half of the daily brief: "what changed, and why".
//
// THE LINE THIS FILE DOES NOT CROSS. The daily brief page is deterministic —
// its metric tiles, its alerts and its recommended actions all come from calc
// modules, and they stay that way. This adds ONE clearly-labelled section that
// explains what those numbers mean, and it is built so that it cannot quietly
// become a second source of figures:
//
//   * The model gets the snapshot diff as PRE-FORMATTED TEXT. Every number in
//     that text was produced by modules/calc/dailySnapshot.ts and formatted by
//     formatInr. The model is not handed raw values to render.
//   * It has no tools here. A brief is a summary of a fixed input, and giving
//     it lookup ability would let the narrative describe a period the tiles
//     beside it are not showing.
//   * Every figure it writes is verified against that same text before the
//     brief is stored. An unsupported figure is not shown — the narrative is
//     rejected, because unlike an answer to a question, nobody asked for this
//     and there is no user waiting who would rather have a flawed version.
//
// One brief per org per day, generated once and reused. Regenerating on each
// page load would mean two people reading the same morning's brief could see
// different explanations of the same numbers.

export const DAILY_BRIEF_VERSION = "v1";

const MAX_OUTPUT_TOKENS = 1200;

const SYSTEM_PROMPT = `You write the morning brief for the founder of an Indian D2C brand, inside CFOOS.

You are given a table of metrics that a deterministic engine computed overnight,
each with yesterday's value and the move since the previous snapshot. Your job
is to say what a finance person would say about it in four sentences.

THE RULE THAT OVERRIDES EVERYTHING: every number you write must appear
literally in the input you were given. You may not add, subtract, average or
convert. If you want to say "margin fell four points" and the input does not
contain the number four, say "margin fell" and quote the two values it gives
you. Every figure you write is checked against the input, and a number you
computed yourself will cause this brief to be discarded.

Other rules:
- Lead with what a founder should act on, not with the largest number.
- If a metric did not move, do not manufacture a story about it.
- If the input says a comparison is not against the adjacent day, say so —
  "over three days", not "overnight".
- Never describe an estimated figure as reconciled or verified.
- Do not speculate about causes the input does not support. "Ad spend rose and
  revenue did not" is supported. "Because the Meta campaign underperformed" is
  not, unless the input says it.
- Amounts are Indian rupees, written as the input writes them.

Answer in this exact JSON shape and nothing else — no prose before or after,
no markdown fence:

{
  "headline": "one sentence, the thing that matters most this morning",
  "whatChanged": ["one item per metric worth mentioning, quoting its figures"],
  "whyItMatters": ["what each change implies, in the founder's terms"],
  "watchFor": ["what to keep an eye on, or an empty array"],
  "caveats": ["anything that makes this less trustworthy than it looks"]
}`;

export interface BriefNarrative {
  headline: string;
  whatChanged: string[];
  whyItMatters: string[];
  watchFor: string[];
  caveats: string[];
}

export interface DailyBriefResult {
  day: string;
  /** Null when nothing could be written and why is in `reason`. */
  narrative: BriefNarrative | null;
  reason: string | null;
  generatedAt: string | null;
  /** Reported so the UI can say the figures were checked, not assert it blindly. */
  figuresChecked: number;
  model: string | null;
}

/**
 * The deterministic input, rendered as the text the model sees.
 *
 * Exported and pure so a test can assert exactly what a model would be told
 * without an API key, and so the verifier can check figures against the same
 * bytes rather than a re-derivation of them.
 */
export function renderDiffForModel(moves: DailyMetricMove[], warnings: string[]): string {
  const lines: string[] = [];
  for (const m of moves) {
    const value =
      m.current.valueMinor !== null
        ? formatInr(BigInt(m.current.valueMinor))
        : m.current.valueNumeric === null
          ? "—"
          : m.metric.unit === "pct"
            ? `${m.current.valueNumeric}%`
            : m.metric.unit === "months"
              ? `${m.current.valueNumeric} months`
              : String(m.current.valueNumeric);

    const move =
      m.direction === null
        ? "no earlier snapshot to compare against"
        : m.direction === "flat"
          ? "unchanged"
          : m.deltaMinor !== null
            ? `${m.direction} by ${formatInr(BigInt(m.deltaMinor) < 0n ? -BigInt(m.deltaMinor) : BigInt(m.deltaMinor))}`
            : m.deltaNumeric !== null
              ? `${m.direction} by ${Math.abs(m.deltaNumeric)}${m.metric.unit === "pct" ? " points" : ""}`
              : String(m.direction);

    // Adjacency is stated per metric, not once at the top: snapshots are
    // captured per metric and one can have a gap the others do not.
    const adjacency =
      m.direction === null || m.previousIsAdjacent ? "" : " (NOT the adjacent day — this move spans a gap)";
    const better =
      m.metric.betterWhen === null ? "" : ` [higher is ${m.metric.betterWhen === "higher" ? "better" : "worse"}]`;

    lines.push(`- ${m.metric.label}: ${value}, ${move}${adjacency}${better}`);
  }
  if (warnings.length > 0) {
    lines.push("", "Warnings from the snapshot engine:");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

export function parseBriefNarrative(text: string): BriefNarrative | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.headline !== "string" || o.headline.trim().length === 0) return null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    headline: o.headline,
    whatChanged: strings(o.whatChanged),
    whyItMatters: strings(o.whyItMatters),
    watchFor: strings(o.watchFor),
    caveats: strings(o.caveats),
  };
}

/** Shape the verifier expects. The brief is not a §19 answer, so it is adapted. */
function asAnswer(n: BriefNarrative): StructuredAnswer {
  return {
    directAnswer: n.headline,
    keyFigures: [],
    drivers: [...n.whatChanged, ...n.whyItMatters, ...n.watchFor],
    evidence: [],
    dataStatus: "estimated",
    warnings: n.caveats,
    recommendedAction: null,
    followUps: [],
  };
}

export async function readDailyBrief(organizationId: string, now: Date = new Date()): Promise<DailyBriefResult> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } });
  const day = zonedDayKey(now, org?.timezone ?? DEFAULT_TIMEZONE);
  const row = await prisma.aiDailyBrief.findUnique({ where: { organizationId_day: { organizationId, day } } });
  if (!row) {
    return {
      day,
      narrative: null,
      reason: "No narrative has been generated for today yet.",
      generatedAt: null,
      figuresChecked: 0,
      model: null,
    };
  }
  return {
    day: row.day,
    narrative: row.narrative as unknown as BriefNarrative | null,
    reason: row.reason,
    generatedAt: row.createdAt.toISOString(),
    figuresChecked: row.figuresChecked,
    model: row.model,
  };
}

/**
 * Generate today's narrative for one organisation.
 *
 * Idempotent per day unless `force` is set: the second call returns the stored
 * brief rather than a second opinion on the same numbers.
 */
export async function generateDailyBrief(
  organizationId: string,
  now: Date = new Date(),
  force = false
): Promise<DailyBriefResult> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } });
  const timeZone = org?.timezone ?? DEFAULT_TIMEZONE;
  const day = zonedDayKey(now, timeZone);

  if (!force) {
    const existing = await prisma.aiDailyBrief.findUnique({ where: { organizationId_day: { organizationId, day } } });
    if (existing) return readDailyBrief(organizationId, now);
  }

  const store = async (narrative: BriefNarrative | null, reason: string | null, figuresChecked: number) => {
    // The row's OWN createdAt is returned, not `new Date()`. Reading a brief
    // back must produce the identical object the write produced, or the two
    // paths disagree by however many milliseconds the upsert took — and
    // "generated at" is exactly the field a UI uses to decide whether it is
    // looking at this morning's brief or yesterday's.
    const row = await prisma.aiDailyBrief.upsert({
      where: { organizationId_day: { organizationId, day } },
      create: {
        organizationId,
        day,
        narrative: (narrative ?? undefined) as never,
        reason,
        figuresChecked,
        model: env.AI_BRIEF_MODEL,
        version: DAILY_BRIEF_VERSION,
      },
      update: {
        narrative: (narrative ?? undefined) as never,
        reason,
        figuresChecked,
        model: env.AI_BRIEF_MODEL,
        version: DAILY_BRIEF_VERSION,
      },
    });
    return { day, narrative, reason, generatedAt: row.createdAt.toISOString(), figuresChecked, model: env.AI_BRIEF_MODEL };
  };

  if (!env.ANTHROPIC_API_KEY) {
    return store(null, "The AI narrative is off on this server (ANTHROPIC_API_KEY is unset). Every figure the brief would describe is on this page already.", 0);
  }

  const diff = await getDailySnapshotDiff(organizationId, now);
  const moved = diff.metrics.filter((m) => m.direction !== null && m.direction !== "flat");

  if (diff.metrics.length === 0) {
    return store(
      null,
      "No snapshot history exists yet, so there is nothing to compare this morning against. The nightly capture runs after midnight and needs two days before it can describe a change.",
      0
    );
  }
  if (moved.length === 0) {
    // A real answer, not a failure. A brief that invents significance on a
    // quiet day is how a founder learns to stop reading it.
    return store(null, "Nothing moved since the last snapshot.", 0);
  }

  const input = renderDiffForModel(diff.metrics, diff.warnings);

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: env.AI_BRIEF_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Metrics as of ${day} (${timeZone}):\n\n${input}` }],
    });
    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const narrative = parseBriefNarrative(text);
    if (!narrative) return store(null, "The model did not return a usable narrative this morning.", 0);

    // Verified against the SAME text the model was given. No tools ran, so
    // that text is the complete set of figures it was entitled to use.
    const figures = verifyFigures(asAnswer(narrative), [input]);
    const pii = verifyNoPii(asAnswer(narrative));

    if (!figures.ok) {
      logger.warn({ organizationId, unsupported: figures.unsupported }, "daily_brief_unsupported_figures");
      return store(
        null,
        `The narrative was discarded: it contained ${figures.unsupported.length} figure${figures.unsupported.length === 1 ? "" : "s"} (${figures.unsupported.join(", ")}) that the overnight snapshot did not produce. The metrics on this page are unaffected — they are computed, not written.`,
        figures.checked
      );
    }
    if (!pii.ok) {
      logger.error({ organizationId, hits: pii.hits }, "daily_brief_contains_pii");
      return store(null, "The narrative was discarded because it contained personal data.", figures.checked);
    }

    await writeAudit({
      organizationId,
      actorType: "AI",
      actorId: "system",
      action: "ai.daily_brief_generated",
      entityType: "AI_DAILY_BRIEF",
      entityId: day,
      metadata: { day, figuresChecked: figures.checked, metricsMoved: moved.length, model: env.AI_BRIEF_MODEL },
    });

    return store(narrative, null, figures.checked);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, organizationId }, "daily_brief_failed");
    return store(null, `The narrative could not be generated this morning: ${message}`, 0);
  }
}

export interface DailyBriefSweepResult {
  organizations: number;
  generated: number;
  skipped: number;
  failed: Array<{ organizationId: string; error: string }>;
}

/**
 * Nightly sweep. Lives here, not in the scheduler, for the reason documented
 * at length in syncCadence.ts: a module that imports the queue opens a Redis
 * connection at import time and keeps any importing process alive forever.
 */
export async function runDailyBriefSweep(now: Date = new Date()): Promise<DailyBriefSweepResult> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const result: DailyBriefSweepResult = { organizations: orgs.length, generated: 0, skipped: 0, failed: [] };

  for (const org of orgs) {
    try {
      const brief = await generateDailyBrief(org.id, now);
      if (brief.narrative) result.generated += 1;
      else result.skipped += 1;
    } catch (err) {
      result.failed.push({ organizationId: org.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
