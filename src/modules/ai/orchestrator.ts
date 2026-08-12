import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";
import { writeAudit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { TOOLS, executeTool, type ToolContext } from "./tools.js";

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
const MAX_OUTPUT_TOKENS = 4096;

// §19's response contract. The model is told to emit exactly this and nothing
// else, and answer() validates it before storing — a free-text answer that
// merely mentions numbers is not auditable, and the point of the contract is
// that every figure is attributable to a tool result.
export interface StructuredAnswer {
  directAnswer: string;
  keyFigures: Array<{ label: string; value: string; source: string }>;
  drivers: string[];
  evidence: string[];
  dataStatus: string;
  warnings: string[];
  recommendedAction: string | null;
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

Answer in this exact JSON shape and nothing else — no prose before or after,
no markdown fence:

{
  "directAnswer": "one or two sentences answering the question",
  "keyFigures": [{"label": "Net revenue", "value": "₹12,45,000", "source": "get_revenue_summary"}],
  "drivers": ["what explains the figure, one per item"],
  "evidence": ["/evidence/net_revenue"],
  "dataStatus": "estimated | provisional | reconciled | mixed",
  "warnings": ["anything that makes this less trustworthy than it looks"],
  "recommendedAction": "one concrete next step, or null"
}`;

export interface AskResult {
  conversationId: string;
  runId: string;
  status: "COMPLETED" | "FAILED" | "EXHAUSTED";
  answer: StructuredAnswer | null;
  toolCalls: Array<{ name: string; ok: boolean; durationMs: number }>;
  turns: number;
  error?: string;
}

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

  return {
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
  };
}

export async function ask(
  ctx: ToolContext,
  question: string,
  conversationId?: string
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
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const toolCalls: AskResult["toolCalls"] = [];
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalToolCalls = 0;

  try {
    while (turns < MAX_TURNS) {
      turns += 1;
      const response = await client.messages.create({
        model: env.AI_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        messages,
      });

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      messages.push({ role: "assistant", content: response.content });

      const uses = response.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
      if (uses.length === 0) {
        const text = response.content
          .filter((c): c is Anthropic.TextBlock => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        const answer = parseStructuredAnswer(text);

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
            finishedAt: new Date(),
            error: answer ? null : "The model did not return a valid structured answer.",
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
          metadata: { question, turns, tools: toolCalls.map((t) => t.name), status: answer ? "COMPLETED" : "FAILED" },
        });

        return {
          conversationId: convo.id,
          runId: run.id,
          status: answer ? "COMPLETED" : "FAILED",
          answer,
          toolCalls,
          turns,
          ...(answer ? {} : { error: "The model did not return a valid structured answer." }),
        };
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

        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: !exec.ok,
          content: JSON.stringify(exec.result),
        });
      }
      messages.push({ role: "user", content: results });
    }

    // Ran out of turns. Reported as EXHAUSTED with a real explanation rather
    // than an empty answer.
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "EXHAUSTED", turns, inputTokens, outputTokens, finishedAt: new Date(), error: `Reached the ${MAX_TURNS}-turn cap.` },
    });
    return {
      conversationId: convo.id,
      runId: run.id,
      status: "EXHAUSTED",
      answer: null,
      toolCalls,
      turns,
      error: `The question needed more than ${MAX_TURNS} rounds of lookups. Try asking about one metric or one period at a time.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, runId: run.id, organizationId: ctx.organizationId }, "ai_run_failed");
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", turns, inputTokens, outputTokens, finishedAt: new Date(), error: message },
    });
    return { conversationId: convo.id, runId: run.id, status: "FAILED", answer: null, toolCalls, turns, error: message };
  }
}
