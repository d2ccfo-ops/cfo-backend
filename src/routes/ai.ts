import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { ask, isAiConfigured } from "../modules/ai/orchestrator.js";
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
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
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
