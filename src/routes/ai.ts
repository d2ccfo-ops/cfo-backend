import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { generateDailyBrief, readDailyBrief } from "../modules/ai/dailyBrief.js";
import { logger } from "../lib/logger.js";
import { ask, isAiConfigured, type AskEvent } from "../modules/ai/orchestrator.js";
import { TOOLS } from "../modules/ai/tools.js";

// §18/§19 transport. No reasoning lives here — the orchestrator decides, the
// tools compute, and this only carries the request.

export const aiRouter = Router();

const askSchema = z
  .object({
    question: z.string().min(3).max(1000),
    conversationId: z.string().optional(),
  })
  .strict();

// Advertised so a client can render "not configured" rather than discovering
// it by posting a question and getting a 503 after the user has typed.
aiRouter.get("/status", ...requireAuth, async (_req, res) => {
  res.json({
    configured: isAiConfigured(),
    // `label` is the same ticker copy the stream emits, served from the same
    // place, so a client never has to keep its own copy of what a tool is
    // called in English.
    tools: TOOLS.map((t) => ({ name: t.name, label: t.label, description: t.description })),
    note: isAiConfigured()
      ? null
      : "ANTHROPIC_API_KEY is not set on the server, so the AI CFO cannot answer questions yet. Every figure it would quote is still available on the dashboard.",
  });
});

aiRouter.post("/ask", ...requireAuth, async (req, res, next) => {
  let parsed: z.infer<typeof askSchema>;
  try {
    // Parsed inside try/next(err): on Express 4 a throw from an async handler
    // never reaches the error middleware and hangs the request instead.
    parsed = askSchema.parse(req.body ?? {});
  } catch (err) {
    next(err);
    return;
  }

  if (!isAiConfigured()) {
    res.status(503).json({
      error: "ai_not_configured",
      message: "The AI CFO is not configured on this server (ANTHROPIC_API_KEY is unset).",
    });
    return;
  }

  const result = await ask(
    { organizationId: req.auth!.organizationId, timeZone: req.auth!.timezone, userId: req.auth!.userId },
    parsed.question,
    parsed.conversationId
  );
  // 200 even for EXHAUSTED and FAILED: the run happened, it is recorded, and
  // the body says what became of it. A 500 here would lose the runId a founder
  // or a support engineer needs to look at what the model actually did.
  res.json(result);
});

// ---------------------------------------------------------------------------
// The same question, streamed
// ---------------------------------------------------------------------------
// A run takes 20-30 seconds and POST /ai/ask says nothing until it is over.
// This route runs THE SAME ask() — same guards, same caps, same verification
// pass, same audit write — and reports what it is doing as it does it.
//
// It is not a second implementation, and must never become one: the only thing
// this handler adds is a callback that turns each event into an SSE frame. If a
// rule changes in the orchestrator it changes for both routes at once, because
// there is only one loop.
//
// Every frame corresponds to work that already happened (see AskEvent). This
// endpoint cannot invent a stage, because it does not know what the loop is
// doing except by being told.

/**
 * One SSE frame.
 *
 * Exported because the framing is the part that can silently corrupt a stream:
 * an answer containing a newline written raw would end the event early and the
 * client would parse half an object as the whole answer. JSON.stringify escapes
 * it, and this is the one place that has to stay true.
 */
export function encodeSseFrame(event: AskEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Thrown into the orchestrator when the founder's connection has gone. */
class ClientDisconnected extends Error {
  constructor() {
    super("The client disconnected before the answer was finished.");
    this.name = "ClientDisconnected";
  }
}

aiRouter.post("/ask/stream", ...requireAuth, async (req, res, next) => {
  let parsed: z.infer<typeof askSchema>;
  try {
    // Parsed and rejected BEFORE any header is written: once the response is
    // an event stream it can no longer become a 400, so validation has to
    // happen while a normal error response is still possible.
    parsed = askSchema.parse(req.body ?? {});
  } catch (err) {
    next(err);
    return;
  }

  if (!isAiConfigured()) {
    res.status(503).json({
      error: "ai_not_configured",
      message: "The AI CFO is not configured on this server (ANTHROPIC_API_KEY is unset).",
    });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  // no-transform as well as no-store: a proxy that "helpfully" gzips or
  // rewrites this response buffers it, and a buffered progress stream arrives
  // in one lump at the end — which is the exact problem this route exists to
  // fix. X-Accel-Buffering is the nginx-specific instruction for the same
  // thing.
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let disconnected = false;
  // A founder closing the tab must not leave a run charging tokens, and must
  // not leave an AgentRun row in RUNNING. Flipping this makes the next emit
  // throw, which lands in the orchestrator's catch, which closes the run out
  // with a stated reason.
  req.on("close", () => {
    disconnected = true;
  });

  const send = (event: AskEvent): void => {
    if (disconnected) throw new ClientDisconnected();
    res.write(encodeSseFrame(event));
  };

  try {
    await ask(
      { organizationId: req.auth!.organizationId, timeZone: req.auth!.timezone, userId: req.auth!.userId },
      parsed.question,
      parsed.conversationId,
      send
    );
  } catch (err) {
    // ask() only reaches here if it threw before a run row existed — there is
    // no runId and no AskResult to send, which is exactly what `error` is for.
    // A run that started and then failed comes back as a `done` carrying a
    // FAILED result instead.
    //
    // The real error is logged, not streamed: errorHandler answers an
    // unexpected failure with "internal_error" and no detail, and an event
    // stream must not become the one place a stack-shaped message reaches a
    // browser.
    logger.error({ err, organizationId: req.auth!.organizationId }, "ai_stream_failed");
    if (!disconnected) {
      try {
        res.write(
          encodeSseFrame({
            type: "error",
            message: "The AI CFO could not start this run. Nothing was answered — every figure it would have quoted is on the dashboard.",
          })
        );
      } catch (writeErr) {
        logger.warn({ err: writeErr }, "ai_stream_error_write_failed");
      }
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

aiRouter.get("/conversations", ...requireAuth, async (req, res) => {
  const rows = await prisma.agentConversation.findMany({
    // Scoped by user as well as org: two people advising the same brand should
    // not read each other's threads.
    where: { organizationId: req.auth!.organizationId, userId: req.auth!.userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, createdAt: true, updatedAt: true, _count: { select: { messages: true } } },
  });
  res.json({
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title,
      messageCount: c._count.messages,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
  });
});

aiRouter.get("/conversations/:id", ...requireAuth, async (req, res) => {
  const convo = await prisma.agentConversation.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId, userId: req.auth!.userId },
    select: {
      id: true,
      title: true,
      createdAt: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, structured: true, createdAt: true },
      },
      runs: {
        orderBy: { startedAt: "asc" },
        select: {
          id: true, status: true, turns: true, error: true, verification: true, startedAt: true, finishedAt: true,
          // The tool trail, because §19's promise is that every figure came
          // from one of these. An answer nobody can trace back is not
          // auditable, and this is what makes it traceable from the UI.
          // `result` is selected only to lift evidenceRef back out — see the
          // map built below. The payload itself never leaves this handler; it
          // is the masked tool output and belongs in the audit table, not in
          // a thread render.
          toolCalls: { orderBy: { createdAt: "asc" }, select: { toolName: true, ok: true, error: true, durationMs: true, result: true } },
        },
      },
    },
  });
  if (!convo) {
    // 404, not 403: a valid id from another tenant must not confirm that it
    // exists.
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    id: convo.id,
    title: convo.title,
    createdAt: convo.createdAt.toISOString(),
    messages: convo.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      structured: m.structured,
      createdAt: m.createdAt.toISOString(),
    })),
    runs: convo.runs.map((r) => ({
      id: r.id,
      status: r.status,
      turns: r.turns,
      error: r.error,
      // Carried into the thread read, not just the live ask: a re-opened
      // conversation must show the same "this figure is unverified" caveat it
      // showed when it was answered.
      verification: r.verification,
      // Rebuilt from what the tools in this run actually returned, so a
      // re-opened thread resolves a figure's source to the same destination
      // the live answer did.
      toolEvidence: Object.fromEntries(
        r.toolCalls
          .map((c) => [c.toolName, (c.result as { evidenceRef?: string } | null)?.evidenceRef])
          .filter((e): e is [string, string] => typeof e[1] === "string")
      ),
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      toolCalls: r.toolCalls.map((c) => ({
        toolName: c.toolName,
        ok: c.ok,
        error: c.error,
        durationMs: c.durationMs,
      })),
    })),
  });
});

// ---------------------------------------------------------------------------
// P4.5 daily brief narrative
// ---------------------------------------------------------------------------
// GET reads what the nightly sweep wrote. It never generates: a page load that
// could trigger a model call would mean the first person in each morning waits
// for one, and two people opening the brief before it was stored could read
// two different explanations of the same numbers.
aiRouter.get("/daily-brief", ...requireAuth, async (req, res) => {
  res.json(await readDailyBrief(req.auth!.organizationId));
});

// The explicit "write it now" path, for the morning the sweep did not run.
// POST, not GET, because it costs a model call and mutates a stored artefact.
aiRouter.post("/daily-brief/generate", ...requireAuth, async (req, res, next) => {
  let force = false;
  try {
    force = z.object({ force: z.boolean().optional() }).strict().parse(req.body ?? {}).force ?? false;
  } catch (err) {
    next(err);
    return;
  }
  res.json(await generateDailyBrief(req.auth!.organizationId, new Date(), force));
});
