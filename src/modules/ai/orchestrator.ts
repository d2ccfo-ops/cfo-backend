import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";
import { writeAudit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { enrichFigures, type EnrichedKeyFigure, type ToolResultRecord } from "./enrichFigures.js";
import { answerCharts, type AnswerChart } from "./answerCharts.js";
import { TOOLS, TOOLS_BY_NAME, executeTool, type ToolContext } from "./tools.js";
import { verifyFigures, verifyNoPii, verifySources } from "./verify.js";

// §18/§19 orchestrator (P4.3).
//
// Three caps, and each exists because of a specific way an agent loop goes
// wrong rather than as a generic safety blanket:
//
//   MAX_TURNS      — a model that keeps calling tools without concluding.
//                    Without this the loop is unbounded.
//   MAX_TOOL_CALLS — a model that calls the same tool repeatedly with slightly
//                    different arguments. Turn-capping alone does not stop it,
//                    because one turn can carry many calls.
//   MAX_OUTPUT     — bounds the cost of a single answer.
//
// Hitting a cap is EXHAUSTED, not FAILED. Nothing broke; the question was
// bigger than the budget, and a founder deserves to be told that rather than
// shown "something went wrong".

const MAX_TURNS = 8;
const MAX_TOOL_CALLS = 20;

/**
 * Why a run produced no usable answer, in words a founder can act on.
 *
 * Every one of these used to be stored as "The model did not return a valid
 * structured answer", which names the symptom and hides the cause. A real
 * FAILED run in this database — 1 turn, SIX output tokens — is what made that
 * unacceptable: six tokens is not a truncated answer, it is the model
 * declining or stopping, and nothing in the stored row could tell the two
 * apart. stop_reason is the field that already knew.
 */
export function failureReason(stopReason: string | null, outputTokens: number): string {
  switch (stopReason) {
    case "max_tokens":
      return `The answer was cut off at the ${MAX_OUTPUT_TOKENS}-token output limit before it finished. Ask about one metric or one period at a time.`;
    case "refusal":
      return "The model declined to answer this question. Rephrasing usually resolves it; the dashboard has every figure the answer would have quoted.";
    case "pause_turn":
      return "The model paused mid-answer and the run did not resume. Ask again.";
    default:
      // Genuinely malformed output. Include the size, because "0 output
      // tokens" and "3,000 output tokens that would not parse" are different
      // bugs and the next person to read this row needs to know which.
      return `The model returned ${outputTokens} output token${outputTokens === 1 ? "" : "s"} that did not parse as a structured answer (stop_reason: ${stopReason ?? "none"}).`;
  }
}

// max_tokens caps THINKING PLUS ANSWER, not the answer alone.
//
// Both claude-opus-5 and claude-sonnet-5 run adaptive thinking when the
// `thinking` parameter is omitted, which it is here. So this budget has always
// been shared, and 4096 was tight enough that a hard question could spend most
// of it reasoning and then truncate mid-JSON. parseStructuredAnswer would
// return null and the run would be stored as FAILED with "the model did not
// return a valid structured answer" — a message that describes the symptom and
// hides the cause.
//
// The answer itself is a bounded object (§19's contract: a sentence, a handful
// of figures, a few strings), so the extra headroom is spent on reasoning, not
// on prose, and it is a ceiling rather than a target — an easy question still
// bills only what it uses.
//
// WHY NOT THE MODEL'S ACTUAL CEILING (128,000)
//
// Three reasons, and the first is the one that costs money. This budget is
// PER TURN and MAX_TURNS is 8, so the cap is really eight times whatever is
// written here: at 128k that is a million output tokens for one question,
// which at Sonnet's rate is about fifteen dollars — for a question that has
// so far never needed more than 911 output tokens in a turn.
//
// Second, a cap is not only a limit, it is a tripwire. §19's answer is a
// bounded object; a model generating 100k tokens against that contract is not
// writing a long answer, it is looping. A tight cap turns that into a fast
// failure with a stated reason. A huge one turns it into an expensive failure.
//
// Third, this call is not streamed, and non-streaming requests above roughly
// 16k risk an HTTP timeout — the answer would be lost after being paid for.
//
// 16,000 is the largest value that stays inside that non-streaming limit, and
// is ~17x the largest turn this system has actually produced.
const MAX_OUTPUT_TOKENS = 16_000;

// Effort is stated rather than defaulted, because the default is `high` and
// this is not a high-effort job. §1 forbids the model from calculating money:
// every figure it reports is read out of a tool result that calc/ already
// computed and answers.ts verifies. What is left is choosing among TOOLS and
// turning "in july" into a date range. `medium` covers that, and the sweep to
// confirm it is `npm run eval`.
const EFFORT: "low" | "medium" | "high" | "xhigh" | "max" = "medium";

// ---------------------------------------------------------------------------
// PROMPT CACHING
// ---------------------------------------------------------------------------
// This loop is agentic, so ONE question is several API calls, and every call
// resends everything the previous ones already sent: the system prompt, all
// TOOLS schemas, and every tool result so far. Measured on two real questions,
// that was 55,667 input tokens against 3,778 output — input was 94% of the
// tokens and 75% of the bill, and almost all of it was bytes the API had
// already been shown seconds earlier.
//
// Two breakpoints fix it, and no more than two, because the API allows four
// and MAX_TURNS is 8 — an accumulating breakpoint per turn would start
// erroring on turn five.
//
//   1. STATIC — on the system block. The cacheable prefix is ordered
//      tools → system → messages, so one breakpoint on system covers the tool
//      schemas as well. This prefix is byte-identical for every question by
//      every user in every org, so after the first call of a busy period it is
//      a cache read forever.
//
//   2. ROLLING — on the newest tool result, moved forward each turn by
//      moveCacheBreakpoint. Turn N+1 then reads turns 1..N instead of paying
//      for them, which is where the multi-turn cost actually lives.
//
// The default 5-minute TTL is deliberate over the 1-hour option: a question
// finishes in 20-30s, so the within-question win is fully captured, and a 1h
// write costs 2x against 1.25x for the 5m one. Revisit only with traffic data
// showing questions arriving in a steady stream.
const CACHE_CONTROL = { type: "ephemeral" } as const;

// A tool result is not paid for once. It is resent on every remaining turn of
// the question, so one fat result costs its own size times the turns left —
// and it crowds the context that the actual answer has to be written from.
//
// Most tools already bound themselves (list_products slices to `limit`), but
// that is per-tool discipline rather than a guarantee, and a tool added later
// inherits no such bound. This is the backstop.
//
// 12,000 characters is roughly 3,000 tokens: comfortably more than any current
// tool returns for a normal period, and small enough that a pathological one
// cannot swallow the turn. Truncation is ANNOUNCED rather than silent — a
// model shown a quietly-cut list will summarise it as though it were complete,
// which is the same failure as a fabricated figure wearing better clothes.
const MAX_TOOL_RESULT_CHARS = 12_000;

/** Bound one tool result, telling the model plainly when it was cut. */
export function capToolResult(serialised: string, toolName: string): string {
  if (serialised.length <= MAX_TOOL_RESULT_CHARS) return serialised;
  return (
    serialised.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[TRUNCATED. ${toolName} returned ${serialised.length} characters; you have been shown the first ${MAX_TOOL_RESULT_CHARS}. ` +
    `The remainder is NOT available to you — do not describe this result as complete. ` +
    `Call ${toolName} again with a shorter period or a smaller limit if you need the rest.]`
  );
}

/**
 * Keep exactly one rolling breakpoint, at the end of the conversation.
 *
 * Every earlier one is removed first. This is not tidiness — the API caps
 * breakpoints at four, and leaving one behind per turn would make a long
 * question fail outright on the turn that added the fifth.
 */
export function moveCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      delete (block as { cache_control?: unknown }).cache_control;
    }
  }

  const last = messages[messages.length - 1];
  // The opening message is the bare question as a string, which cannot carry a
  // breakpoint. Nothing to do until the first tool results arrive, and the
  // static breakpoint is already covering the expensive part by then.
  if (!last || typeof last.content === "string" || last.content.length === 0) return;
  const block = last.content[last.content.length - 1] as { cache_control?: unknown };
  block.cache_control = CACHE_CONTROL;
}

// §19's response contract. The model is told to emit exactly this and nothing
// else, and answer() validates it before storing — a free-text answer that
// merely mentions numbers is not auditable, and the point of the contract is
// that every figure is attributable to a tool result.
export interface StructuredAnswer {
  /**
   * A verdict sentence — "July was a volume drop, not a price drop."
   *
   * The ONLY new thing the model produces for the richer render, and it is
   * language rather than measurement: everything numeric on the answer comes
   * from a tool result, either quoted by the model into keyFigures or copied
   * across by enrichFigures. The prompt forbids figures here, and verifyFigures
   * checks it anyway — a rule stated in a prompt and not enforced is a wish.
   *
   * Optional, because an answer written before this field existed, or by a
   * model that skipped it, is still a complete answer. The UI renders without
   * one rather than showing an empty verdict bar.
   */
  headline?: string;
  directAnswer: string;
  keyFigures: EnrichedKeyFigure[];
  drivers: string[];
  evidence: string[];
  dataStatus: string;
  warnings: string[];
  recommendedAction: string | null;
  /**
   * Questions the model offers to ask next. Language, not measurement — each
   * one is a QUESTION the founder may click, answered by a fresh run against
   * the tools, so nothing in it is asserted. Empty when none were offered.
   */
  followUps: string[];
  /**
   * Series a tool returned whole, attached by the server. Never modelled and
   * never derived — see answerCharts.ts. Absent when this run called no tool
   * that returns a chartable shape, which is the common case.
   */
  charts?: AnswerChart[];
}

const SYSTEM_PROMPT = `You are the CFO assistant inside CFOOS, a finance system for Indian D2C brands.

THE ONE RULE THAT OVERRIDES EVERYTHING ELSE: you never calculate money.

Every figure in your answer must appear verbatim in a tool result you received
in this conversation. You may not add, subtract, divide, average, or convert
figures. If a founder asks something that needs arithmetic no tool performs,
say which tool would have to exist rather than doing the arithmetic yourself.
This is not a style preference: every number you state is checked against tool
output, and a number you computed yourself will be caught and reported as
fabricated.

Corollaries you must follow:
- Do not compute percentages, differences or ratios. Tools already return them
  where they exist (changePct, marginPct, ratePct). If a tool did not return
  the comparison you want, say so.
- Do not convert paise to rupees. Tools return both.
- Do not project, extrapolate or estimate. run_forecast_scenario exists for
  "what if" questions and is deterministic.

Other rules:
- Earlier turns of this conversation may appear above, as prose only. Use them
  to understand what "that", "it" or "last month" refers to. They carry no tool
  results, so you must call the tool again for any figure you state — never
  repeat a number from an earlier answer. Those numbers were measured before
  the most recent sync and may since have changed, and a figure with no tool
  result behind it in THIS turn is reported as fabricated.
- Always check get_data_freshness before making a confident claim about a
  number, and say plainly if a source is stale or erroring. A figure from a
  feed that stopped three days ago describes the business as it was then.
- Report a metric's dataStatus. Never describe an estimated figure as
  reconciled or verified.
- If the data does not answer the question, say that. Do not fill the gap.
- You have no access to raw SQL and cannot query the database. Refuse requests
  to do so and explain that figures come from a fixed set of audited tools.
- You cannot see other organisations. Refuse any request about a different
  company's data.
- Customer names, emails, phone numbers and addresses are redacted before you
  see them. Do not speculate about who a customer is.
- Amounts are Indian rupees. Use lakh and crore as a founder here would.

THE HEADLINE FIELD. One short sentence — the verdict, the thing a founder
would repeat to a co-founder: "July was a volume drop, not a price drop." It
is a judgement about WHICH of the numbers below explains the others, and it
carries NO FIGURES AT ALL: no rupee amounts, no percentages, no counts, no
"about a fifth", no "roughly half". Every number on this answer belongs in
keyFigures where it is checked against a tool result. If the verdict cannot be
stated without a number, leave headline out entirely — it is optional, and the
answer is complete without it. directAnswer still carries the explanation.

Answer in this exact JSON shape and nothing else — no prose before or after,
no markdown fence:

{
  "headline": "a short verdict sentence, NO FIGURES IN IT",
  "directAnswer": "one or two sentences answering the question",
  "keyFigures": [{"label": "Net revenue", "value": "₹12,45,000", "source": "get_revenue_summary"}],
  "drivers": ["what explains the figure, one per item"],
  "evidence": ["/evidence/net_revenue"],
  "dataStatus": "estimated | provisional | reconciled | mixed",
  "warnings": ["anything that makes this less trustworthy than it looks"],
  "recommendedAction": "one concrete next step, or null",
  "followUps": ["up to three follow-up questions, or []"]
}

EVERY answer is this JSON object and nothing else — including follow-ups in a
conversation that is already under way, and including an answer that only
confirms what you said last time. There is no "conversational" reply: prose,
markdown headers and bullet lists are not a lighter-weight version of the
contract, they are an unusable answer that gets discarded.

FOLLOW-UPS. Questions this founder would naturally ask next, that THESE tools
can answer — you have just seen which tools exist and what they return, so do
not offer a question that would need a tool this list does not have (no
day-by-day sales series, no cohort analysis, no per-city split). Carry no
figures in them. Offer none rather than padding to three.`;

/**
 * Sent when the answer turn came back as something other than the contract.
 *
 * Phrased as "restate what you just wrote" rather than "answer again": the
 * analysis was already done against real tool results, and inviting a fresh
 * answer invites fresh numbers. Re-stating cannot introduce a figure the tools
 * did not return — and verifyFigures checks the result anyway.
 */
const REFORMAT_INSTRUCTION =
  "That reply was not in the required format, so it cannot be shown to the founder. " +
  "Restate the SAME answer — same figures, same sources, nothing added and nothing " +
  "recalculated — as the JSON object described in your instructions. Output only that " +
  "JSON: no prose before or after it, no markdown fence, no bullet lists.";

/**
 * P4.7, applied to every live answer rather than only in the eval suite.
 *
 * The check that matters is `figures`: every number in the answer had to
 * appear in a tool result. Running it here, at answer time, is the difference
 * between a rule the tests assert and a rule the product enforces — a
 * fabricated figure that only the eval suite would catch still reached a
 * founder's screen in production.
 */
export interface AnswerVerification {
  ok: boolean;
  figuresChecked: number;
  /** Figures found in no tool result. Non-empty means the model did arithmetic. */
  unsupportedFigures: string[];
  /** keyFigures citing a tool that does not exist. */
  unknownSources: string[];
  /** Raw PII that survived masking. Should always be empty. */
  piiHits: string[];
}

export interface AskResult {
  conversationId: string;
  runId: string;
  status: "COMPLETED" | "FAILED" | "EXHAUSTED";
  answer: StructuredAnswer | null;
  toolCalls: Array<{ name: string; ok: boolean; durationMs: number }>;
  /**
   * Which evidence destination each tool used in THIS run actually returned,
   * so a figure's "source" (a tool name) maps to somewhere a human can go.
   * Built from real tool results rather than a second copy of the registry —
   * a hardcoded map would drift from what the tools returned.
   */
  toolEvidence: Record<string, string>;
  verification: AnswerVerification | null;
  turns: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// LIVE PROGRESS
// ---------------------------------------------------------------------------
// A run takes 20-30 seconds, and until now the client learned nothing until it
// finished. These events are what a founder is shown while they wait.
//
// THE RULE THEY ARE BUILT UNDER: a progress step is evidence. An animation that
// implies the system knows something it does not is the same defect as a
// fabricated figure — so every event here corresponds to something that
// actually happened in this loop, and a `tool` event is emitted only AFTER that
// tool returned, carrying its real name and its real measured duration. There
// are no invented stages for work the loop does not do, no predicted list of
// tools it is "about to" call, and no synthetic percentage.
//
// `resolving` and `writing` are the only two stages because they are the only
// two phases this loop actually has: the model choosing tools and reading their
// results, and then the model writing the answer once it stops calling them.
export type AskEvent =
  /** A phase of the loop the run has genuinely entered. */
  | { type: "stage"; stage: "resolving" | "writing" }
  /**
   * One tool call that has ALREADY RETURNED. `durationMs` is measured by
   * executeTool, not estimated, and `label` is the tool's own ticker copy from
   * tools.ts — null only when the model named a tool that does not exist, which
   * is a real event with no label to give.
   */
  | { type: "tool"; name: string; label: string | null; ok: boolean; durationMs: number }
  /** The run finished and this is the same AskResult POST /ai/ask would return. */
  | { type: "done"; result: AskResult }
  /** The run could not be completed and there is no AskResult to give. */
  | { type: "error"; message: string };

export type AskEventSink = (event: AskEvent) => void;

export function isAiConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Parse the model's answer into the §19 shape.
 *
 * Tolerant of a markdown fence, because models add them despite instructions
 * and rejecting a good answer over three backticks helps nobody. NOT tolerant
 * of a missing directAnswer: an object that does not answer the question is
 * not an answer in a different format, it is a failure.
 */
export function parseStructuredAnswer(text: string): StructuredAnswer | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Last resort: the first balanced-looking object in the text.
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
  if (typeof o.directAnswer !== "string" || o.directAnswer.trim().length === 0) return null;

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  // Absent, blank or the wrong type all mean the same thing: no verdict was
  // given. The key is then omitted rather than set to "" — a UI checking for
  // presence must not be handed an empty verdict bar to render.
  const headline = typeof o.headline === "string" ? o.headline.trim() : "";

  return {
    ...(headline ? { headline } : {}),
    directAnswer: o.directAnswer,
    keyFigures: Array.isArray(o.keyFigures)
      ? o.keyFigures
          .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
          .map((f) => ({
            label: String(f.label ?? ""),
            value: String(f.value ?? ""),
            source: String(f.source ?? ""),
          }))
      : [],
    drivers: strings(o.drivers),
    evidence: strings(o.evidence),
    dataStatus: typeof o.dataStatus === "string" ? o.dataStatus : "estimated",
    warnings: strings(o.warnings),
    recommendedAction: typeof o.recommendedAction === "string" ? o.recommendedAction : null,
    // Capped rather than validated for figure-freedom: a follow-up is a
    // QUESTION, so a number inside one asserts nothing — "was the 26th really
    // our best day?" quotes a claim, it does not make one. Three is the
    // reference design's row, and a fourth chip wraps into clutter.
    followUps: strings(o.followUps).map((s) => s.trim()).filter(Boolean).slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// CONVERSATION MEMORY
// ---------------------------------------------------------------------------
// ask() has always accepted a conversationId, resolved it, and written every
// message to agent_messages — and then started the model from the bare
// question with none of it. The UI shows threads; the model was answering each
// one cold. "What about last month?" had no referent.
//
// WHAT IS REPLAYED, AND WHAT DELIBERATELY IS NOT
//
// Only the prose: the founder's question and the directAnswer that came back.
// NOT the tool_use/tool_result traffic, and NOT the keyFigures, for a reason
// that is about correctness rather than cost.
//
// Every figure in an answer is checked by verifyFigures against the tool
// results of THIS run. Replaying a previous turn's figures would put numbers
// in front of the model that this run cannot verify, and it would restate them
// — earning a "could not be found in any tool result" warning on an answer
// that was, in a sense, right. Worse, it would be quoting a number measured
// twenty minutes and one sync ago as though it were current.
//
// So history carries what was DISCUSSED, not what was MEASURED. The model gets
// its referent and has to call the tool again for the number, which is also
// the only way the answer reflects data that moved in between. The system
// prompt states this rule explicitly.
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 1_500;
// Budget for one echoed assistant turn (see historyEcho). Sized to sit under
// MAX_HISTORY_CHARS once the JSON scaffolding and figures are added, so the
// blanket slice in toAlternatingHistory never has to cut a JSON string.
const ECHO_MAX_ANSWER_CHARS = 700;
const ECHO_MAX_FIGURES = 4;

/**
 * Prior turns of a conversation, as alternating user/assistant prose.
 *
 * Returns pairs only. A USER message with no ASSISTANT reply after it — which
 * is what a FAILED or EXHAUSTED run leaves behind — is dropped rather than
 * sent, because the API rejects two consecutive user messages and a founder
 * whose last question errored would otherwise be unable to ask anything else
 * in that thread.
 */
async function loadHistory(conversationId: string): Promise<Anthropic.MessageParam[]> {
  const rows = await prisma.agentMessage.findMany({
    where: { conversationId },
    // Newest-first with a take, then reversed: the cap has to keep the most
    // RECENT turns, and ordering ascending would take the oldest and drop the
    // context the follow-up actually refers to.
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY_MESSAGES,
    select: { role: true, content: true, structured: true },
  });
  rows.reverse();
  return toAlternatingHistory(
    rows.map((r) => ({
      role: r.role,
      content: r.role === "ASSISTANT" ? historyEcho(r.content, r.structured) : r.content,
    }))
  );
}

/**
 * An assistant turn, rewritten into the shape the model must REPLY in.
 *
 * THE BUG THIS FIXES, because it cost nearly a third of all runs.
 *
 * agent_messages.content stores `answer.directAnswer` — prose, deliberately,
 * because that column is also what a human reads. Replaying it verbatim as the
 * assistant's prior turn put a prose assistant message in the context window,
 * and a model reads its own apparent last reply as the format it is expected
 * to keep using. The system prompt asks for bare JSON; the transcript showed
 * markdown. The transcript won.
 *
 * Observed, not theorised: three consecutive runs came back as markdown bullet
 * lists with bold headers and no JSON anywhere, 580–865 output tokens each,
 * every one discarded. One of them opened "Confirmed with fresh data — same
 * answer holds" and re-answered the PREVIOUS question, because a prose
 * transcript reads as a chat rather than as a series of independent structured
 * answers.
 *
 * So the echo is JSON, matching what the next turn must produce. It is
 * deliberately a SUBSET — headline, directAnswer, a few figures — because this
 * is context, not a record: drivers, warnings and charts would triple the
 * token cost of every follow-up to restate what the founder already read.
 *
 * Falls back to the prose when there is no stored structure, which is what a
 * pre-contract row or a salvaged FAILED run leaves behind.
 */
export function historyEcho(content: string, structured: unknown): string {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return content;
  const a = structured as Record<string, unknown>;
  if (typeof a.directAnswer !== "string" || a.directAnswer.trim().length === 0) return content;

  const figures = (Array.isArray(a.keyFigures) ? a.keyFigures : [])
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
    .slice(0, ECHO_MAX_FIGURES)
    .map((f) => ({ label: String(f.label ?? ""), value: String(f.value ?? ""), source: String(f.source ?? "") }));

  // Trimmed HERE rather than by the blanket slice in toAlternatingHistory: that
  // one cuts at a byte offset, which on a JSON string lands mid-token and shows
  // the model malformed JSON as its own last reply — teaching exactly the habit
  // this function exists to prevent.
  const headline = typeof a.headline === "string" ? a.headline.trim() : "";
  return JSON.stringify({
    ...(headline ? { headline } : {}),
    directAnswer: a.directAnswer.slice(0, ECHO_MAX_ANSWER_CHARS),
    keyFigures: figures,
  });
}

/**
 * The shaping rules, split out from the query so they can be tested without a
 * database — every branch here exists because of a row the API would reject,
 * and an untested version of this function fails in production or nowhere.
 */
export function toAlternatingHistory(
  rows: Array<{ role: "USER" | "ASSISTANT"; content: string }>
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const row of rows) {
    const role = row.role === "USER" ? "user" : "assistant";
    // An empty string is a valid column value and an API error. Skip it before
    // it can affect alternation.
    const content = row.content.slice(0, MAX_HISTORY_CHARS).trim();
    if (!content) continue;
    // Consecutive same-role rows mean a turn did not complete — a FAILED or
    // EXHAUSTED run leaves a USER row with no reply. Keep the newest, which is
    // the one the next turn actually follows from.
    if (out.length > 0 && out[out.length - 1]!.role === role) out.pop();
    out.push({ role, content });
  }

  // Must open with a user message, and must not end on one — the new question
  // is appended next and would otherwise be the second user turn in a row.
  while (out.length > 0 && out[0]!.role !== "user") out.shift();
  while (out.length > 0 && out[out.length - 1]!.role !== "assistant") out.pop();
  return out;
}

/**
 * Run one question.
 *
 * `onEvent` is the ONLY difference between the streaming route and the
 * non-streaming one. There is deliberately no second loop: two copies of an
 * agentic loop drift, and the copy nobody looks at is the one that stops
 * enforcing a cap. With onEvent absent, every emit below is a no-op and this
 * function behaves exactly as it did before streaming existed.
 *
 * onEvent MAY THROW, and that is load-bearing. It is how a disconnected client
 * stops a run: the throw lands in the catch below, which marks the AgentRun
 * FAILED with a reason and returns — so a founder closing the tab cannot leave
 * a row stuck in RUNNING forever.
 */
export async function ask(
  ctx: ToolContext,
  question: string,
  conversationId?: string,
  onEvent?: AskEventSink
): Promise<AskResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("ANTHROPIC_API_KEY is not set — the AI CFO is not configured."), { status: 503 });
  }

  const conversation = conversationId
    ? await prisma.agentConversation.findFirst({
        // Scoped by org AND user: a conversation belongs to a person, and a
        // valid id from another tenant must not be resumable.
        where: { id: conversationId, organizationId: ctx.organizationId, userId: ctx.userId },
      })
    : null;

  const convo =
    conversation ??
    (await prisma.agentConversation.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        // The question, trimmed, as the title. Asking the model to name the
        // thread would cost a round trip before the founder sees anything.
        title: question.slice(0, 80),
      },
    }));

  // Loaded BEFORE this question is written to agent_messages below, or the new
  // question would come back as history and be asked twice.
  const history = conversation ? await loadHistory(convo.id) : [];

  const run = await prisma.agentRun.create({
    data: {
      conversationId: convo.id,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      question,
      model: env.AI_MODEL,
      status: "RUNNING",
    },
  });

  await prisma.agentMessage.create({
    data: { conversationId: convo.id, organizationId: ctx.organizationId, role: "USER", content: question },
  });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: question }];
  const toolCalls: AskResult["toolCalls"] = [];
  // Kept verbatim so verifyFigures can search the exact bytes the model was
  // shown. Reconstructing them later from AgentToolCall would introduce a
  // second serialisation and a second chance to disagree.
  const toolOutputs: string[] = [];
  // The same results as objects, for enrichFigures. Separate from toolOutputs
  // because the two answer different questions: toolOutputs is the exact TEXT
  // the model was shown, capped, and is what a fabricated figure is checked
  // against; this is what the tools actually MEASURED, uncapped, and nothing
  // read from it is ever attributed to the model.
  const toolResults: ToolResultRecord[] = [];
  const toolEvidence: Record<string, string> = {};
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalToolCalls = 0;
  // Guards the single reformat retry below. Once only — see the note there.
  let reformatAsked = false;

  // Progress emit. Throws are NOT caught here: an emit that fails means the
  // listener is gone, and the run should stop rather than keep spending tokens
  // on an answer nobody will read. The catch below turns it into a recorded
  // FAILED run.
  const emit = (event: AskEvent): void => {
    if (onEvent) onEvent(event);
  };
  // Terminal emit. Swallows, because by this point the work is done and
  // recorded — a listener that vanished on the last byte must not turn a
  // COMPLETED run into a FAILED one.
  const emitFinal = (event: AskEvent): void => {
    try {
      if (onEvent) onEvent(event);
    } catch (err) {
      logger.warn({ err, runId: run.id }, "ai_stream_final_emit_failed");
    }
  };

  try {
    // The loop's first phase, and the only stage that can honestly be announced
    // before it completes: from here until the model stops calling tools, it is
    // resolving the question against TOOLS.
    emit({ type: "stage", stage: "resolving" });

    while (turns < MAX_TURNS) {
      turns += 1;
      const response = await client.messages.create({
        model: env.AI_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        output_config: { effort: EFFORT },
        // Array form so the block can carry a cache breakpoint; the text is
        // unchanged from the string form.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: CACHE_CONTROL }],
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        messages,
      });

      // input_tokens counts ONLY what was billed at the full input rate —
      // cache reads and cache writes are reported separately and are NOT
      // included in it. Kept as three separate counters rather than summed,
      // because the whole point is being able to see the split; a total would
      // hide whether caching is working.
      inputTokens += response.usage.input_tokens;
      cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
      outputTokens += response.usage.output_tokens;
      messages.push({ role: "assistant", content: response.content });

      const uses = response.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
      if (uses.length === 0) {
        // A turn with no tool calls IS the answer turn — the model has stopped
        // looking things up and is writing. Nothing is guessed here: this
        // branch has already been entered.
        emit({ type: "stage", stage: "writing" });

        const text = response.content
          .filter((c): c is Anthropic.TextBlock => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        const answer = parseStructuredAnswer(text);

        // One reformat attempt before giving up on a full answer.
        //
        // The runs this exists for had already done the work — every tool had
        // returned, the analysis was correct and complete — and were thrown
        // away for writing it as markdown. Discarding 865 output tokens of
        // right answer over its punctuation is the wrong trade, and telling a
        // founder "that run failed" when the model in fact answered them is
        // worse.
        //
        // This asks the model to restate ITS OWN last message as JSON, and it
        // is not a second opinion: whatever comes back goes through
        // verifyFigures exactly as a first-pass answer does, so a figure
        // invented during the rewrite is caught by the same check that catches
        // one invented in the first pass.
        //
        // The model MAY still call a tool on the turn after this — the loop
        // offers the same tools every iteration, and pulling them out for one
        // turn would invalidate the cached prefix (tools sit ahead of system in
        // the cache order) to prevent something harmless: the tools are
        // read-only, and a re-read cannot change what may be quoted.
        //
        // Once only. A model that cannot produce the contract on the second ask
        // will not produce it on the third, and the loop has to terminate.
        //
        // No moveCacheBreakpoint call here on purpose: this pushes a plain
        // string, so the breakpoint stays on the last tool result and every
        // token before it is still read from cache. The retry costs the
        // instruction and the rewrite, not the conversation.
        if (!answer && !reformatAsked) {
          reformatAsked = true;
          logger.warn({ runId: run.id, outputTokens }, "ai_answer_unparsed_retrying_as_json");
          messages.push({ role: "user", content: REFORMAT_INSTRUCTION });
          continue;
        }

        // P4.7 applied before the answer is stored or returned.
        //
        // An unsupported figure does NOT fail the run: the rest of the answer
        // is still the tool results, and discarding it would leave a founder
        // with nothing when the flaw is one sentence. It becomes a warning ON
        // the answer, in the answer's own warnings array, so it travels with
        // the text — including into the stored message a screenshot is taken
        // from three weeks later.
        let verification: AnswerVerification | null = null;
        if (answer) {
          const figures = verifyFigures(answer, toolOutputs);
          const sources = verifySources(answer);
          const pii = verifyNoPii(answer);
          verification = {
            ok: figures.ok && sources.ok && pii.ok,
            figuresChecked: figures.checked,
            unsupportedFigures: figures.unsupported,
            unknownSources: sources.unknown,
            piiHits: pii.hits,
          };
          if (!figures.ok) {
            answer.warnings = [
              `${figures.unsupported.length} figure${figures.unsupported.length === 1 ? "" : "s"} in this answer (${figures.unsupported.join(", ")}) could not be found in any tool result. Treat ${figures.unsupported.length === 1 ? "it" : "them"} as unverified and check the dashboard.`,
              ...answer.warnings,
            ];
          }
          if (!sources.ok) {
            answer.warnings = [
              `This answer cites ${sources.unknown.join(", ")} as a source, which is not a tool that exists.`,
              ...answer.warnings,
            ];
          }
          if (!pii.ok) {
            // Never shown to the founder as a warning — the leak is the
            // problem, and repeating it in the UI would spread it. Logged and
            // recorded instead.
            logger.error({ runId: run.id, hits: pii.hits }, "ai_answer_contains_pii");
          }

          // AFTER verification, deliberately.
          //
          // verifyFigures asks "did the MODEL state a number no tool produced".
          // The fields enrichFigures adds are copied out of tool results by the
          // server, so running it first would put numbers into the answer that
          // the check was never meant to police, and a delta the tool itself
          // measured would be graded as though the model had written it.
          //
          // What this adds is only ever a copy: a tool that measured no change
          // yields a figure with no delta, and the UI renders without one. See
          // enrichFigures.ts — the "only copy, never compute" rule lives there
          // with its own tests, not in this loop.
          answer.keyFigures = enrichFigures(answer.keyFigures, toolResults);

          // Charts, same discipline and the same reason for the ordering:
          // every point is copied out of a series a tool returned whole, so
          // verifyFigures must have finished policing the MODEL's numbers
          // before any of them are attached. A run whose tools returned no
          // chartable shape gets no charts key at all.
          const charts = answerCharts(toolResults);
          if (charts.length > 0) answer.charts = charts;
        }

        await prisma.agentMessage.create({
          data: {
            conversationId: convo.id,
            organizationId: ctx.organizationId,
            role: "ASSISTANT",
            content: answer?.directAnswer ?? text,
            structured: (answer ?? undefined) as never,
          },
        });
        await prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: answer ? "COMPLETED" : "FAILED",
            turns,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            finishedAt: new Date(),
            error: answer ? null : failureReason(response.stop_reason, outputTokens),
            verification: (verification ?? undefined) as never,
          },
        });
        await prisma.agentConversation.update({ where: { id: convo.id }, data: { updatedAt: new Date() } });

        // §29: an AI action that touched money data is auditable. The tool
        // NAMES are logged, not their results — the results are already on
        // AgentToolCall, and duplicating them here would double the retention
        // of the same masked data.
        await writeAudit({
          organizationId: ctx.organizationId,
          actorType: "AI",
          actorId: ctx.userId,
          action: "ai.answered",
          entityType: "AGENT_RUN",
          entityId: run.id,
          metadata: {
            question,
            turns,
            tools: toolCalls.map((t) => t.name),
            status: answer ? "COMPLETED" : "FAILED",
            // Recorded in the audit log too, because "the AI stated a figure
            // nobody computed" is a finance event, not a debugging detail.
            verified: verification?.ok ?? null,
            unsupportedFigures: verification?.unsupportedFigures ?? [],
          },
        });

        const result: AskResult = {
          conversationId: convo.id,
          runId: run.id,
          status: answer ? "COMPLETED" : "FAILED",
          answer,
          toolCalls,
          toolEvidence,
          verification,
          turns,
          // The same sentence the run is stored with. Two wordings for one
          // event is how a support conversation and a database row stop
          // agreeing about what happened.
          ...(answer ? {} : { error: failureReason(response.stop_reason, outputTokens) }),
        };
        // The streamed `done` carries the SAME object the non-streaming route
        // returns, rather than a summary of it — a client that reads one and a
        // client that reads the other must see the same answer.
        emitFinal({ type: "done", result });
        return result;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        if (totalToolCalls >= MAX_TOOL_CALLS) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: `Tool-call budget exhausted (${MAX_TOOL_CALLS}). Answer with what you already have, and say in warnings that the answer is incomplete.`,
          });
          continue;
        }
        totalToolCalls += 1;

        const exec = await executeTool(ctx, use.name, use.input);
        toolCalls.push({ name: use.name, ok: exec.ok, durationMs: exec.durationMs });
        const serialised = capToolResult(JSON.stringify(exec.result), use.name);
        if (exec.ok) {
          // The capped text, not the full one. The invariant this array exists
          // for is "the exact bytes the model was shown" — verifying against
          // bytes that were dropped before sending would let a figure the model
          // could not possibly have read pass as supported.
          toolOutputs.push(serialised);
          // Failed calls are excluded: an error envelope has no measurement in
          // it, and a delta copied out of one would describe nothing.
          toolResults.push({ name: use.name, result: exec.result });
          const ref = (exec.result as { evidenceRef?: string }).evidenceRef;
          if (ref) toolEvidence[use.name] = ref;
        }

        await prisma.agentToolCall.create({
          data: {
            runId: run.id,
            toolName: use.name,
            arguments: (use.input ?? {}) as never,
            // Post-mask only — see the note in pii.ts. Storing the raw result
            // would make this table the one place customer identities are kept
            // forever, defeating §27's minimisation.
            result: exec.ok ? (exec.result as never) : undefined,
            ok: exec.ok,
            error: exec.ok ? null : (exec.result as { error: string }).error,
            durationMs: exec.durationMs,
          },
        });

        // AFTER the call returned AND after it is on the record, never before:
        // the founder is being told what happened, not what is about to be
        // attempted, and a listener that disappears mid-run cannot leave a tool
        // call that ran but was never written down. Failures are emitted too —
        // "that lookup errored" is information, and hiding it would make the
        // ticker a list of successes the run did not have.
        emit({
          type: "tool",
          name: use.name,
          label: TOOLS_BY_NAME.get(use.name)?.label ?? null,
          ok: exec.ok,
          durationMs: exec.durationMs,
        });

        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: !exec.ok,
          content: serialised,
        });
      }
      messages.push({ role: "user", content: results });
      // After the push, so the breakpoint lands on the newest tool result and
      // the next turn reads everything before it from cache.
      moveCacheBreakpoint(messages);
    }

    // Ran out of turns. Reported as EXHAUSTED with a real explanation rather
    // than an empty answer.
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "EXHAUSTED", turns, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, finishedAt: new Date(), error: `Reached the ${MAX_TURNS}-turn cap.` },
    });
    const exhausted: AskResult = {
      conversationId: convo.id,
      runId: run.id,
      status: "EXHAUSTED",
      answer: null,
      toolCalls,
      toolEvidence,
      verification: null,
      turns,
      error: `The question needed more than ${MAX_TURNS} rounds of lookups. Try asking about one metric or one period at a time.`,
    };
    emitFinal({ type: "done", result: exhausted });
    return exhausted;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, runId: run.id, organizationId: ctx.organizationId }, "ai_run_failed");
    // Reached by a genuine failure AND by a listener that threw — a client that
    // hung up. Either way the run is closed out here, which is what keeps a
    // disconnected request from leaving an AgentRun in RUNNING forever.
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", turns, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, finishedAt: new Date(), error: message },
    });
    const failed: AskResult = { conversationId: convo.id, runId: run.id, status: "FAILED", answer: null, toolCalls, toolEvidence, verification: null, turns, error: message };
    // Still a `done`, not an `error`: the run happened, it has a runId, and the
    // result says what became of it. `error` is reserved for the case where
    // there is no AskResult to hand over at all.
    emitFinal({ type: "done", result: failed });
    return failed;
  }
}
