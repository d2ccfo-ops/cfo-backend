import { getAuth } from "@clerk/express";
import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { lookupUsers } from "../../lib/clerkDirectory.js";
import { collectFindings } from "../../modules/observability/alerts.js";

// WHAT IS WRONG RIGHT NOW, without being asked.
//
// The rows are written by the evaluator in the worker (modules/observability/
// alerts.ts) once a minute. This router only reads them, plus one write:
// acknowledgement, which is a note from a human and cannot be derived.
//
// ACKNOWLEDGEMENT DOES NOT RESOLVE. A resolved alert is one whose condition
// stopped being true, and only the evaluator may decide that. Acknowledging
// means "seen, not news" — it stops re-notification and greys the row, and the
// condition stays visibly true underneath. Conflating the two gives you a
// console where the way to make a problem disappear is to click a button, which
// is how monitoring systems come to be trusted less than the people using them.

export const internalAlertsRouter = Router();

const SEVERITY_ORDER = { PAGE: 0, WARN: 1, INFO: 2 } as const;

/** Everything open, worst first, plus recent history. */
internalAlertsRouter.get("/", async (req, res) => {
  const historyLimit = Math.min(Number(req.query.history) > 0 ? Math.trunc(Number(req.query.history)) : 30, 200);

  const [open, resolved] = await Promise.all([
    prisma.alert.findMany({ where: { resolvedAt: null }, orderBy: [{ severity: "asc" }, { firstSeenAt: "asc" }] }),
    prisma.alert.findMany({ where: { resolvedAt: { not: null } }, orderBy: { resolvedAt: "desc" }, take: historyLimit }),
  ]);

  const shape = (a: (typeof open)[number]) => ({
    id: a.id,
    key: a.key,
    rule: a.rule,
    severity: a.severity,
    title: a.title,
    detail: a.detail,
    firstSeenAt: a.firstSeenAt.toISOString(),
    lastSeenAt: a.lastSeenAt.toISOString(),
    seenCount: a.seenCount,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: a.acknowledgedBy,
    acknowledgedReason: a.acknowledgedReason,
    /** Whether anything was actually pushed to a human, as opposed to stored. */
    notifiedAt: a.notifiedAt?.toISOString() ?? null,
  });

  const openShaped = [...open].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]).map(shape);

  res.json({
    open: openShaped,
    resolved: resolved.map(shape),
    counts: {
      page: openShaped.filter((a) => a.severity === "PAGE" && a.acknowledgedAt === null).length,
      warn: openShaped.filter((a) => a.severity === "WARN" && a.acknowledgedAt === null).length,
      info: openShaped.filter((a) => a.severity === "INFO" && a.acknowledgedAt === null).length,
      acknowledged: openShaped.filter((a) => a.acknowledgedAt !== null).length,
    },
    /**
     * Whether anything would actually reach a person. Reported so the console
     * can say "3 alerts, nobody is being told" — which is a materially different
     * state from "3 alerts" and the one worth surfacing loudly.
     */
    delivery: {
      webhook: Boolean(process.env.INTERNAL_ALERT_WEBHOOK),
      email: Boolean(process.env.RESEND_API_KEY && process.env.INTERNAL_ALERT_EMAIL),
    },
  });
});

/**
 * Evaluate the rules right now and return what they find, WITHOUT writing.
 *
 * For confirming a rule behaves before trusting it, and for checking after a
 * fix that the condition really has cleared rather than waiting up to a minute
 * to find out. Read-only by construction — it calls the collector, not the
 * reconciler.
 */
internalAlertsRouter.get("/preview", async (_req, res) => {
  const findings = await collectFindings();
  res.json({ evaluatedAt: new Date().toISOString(), findings });
});

/** Mark as seen. Does not resolve — only the evaluator resolves. */
internalAlertsRouter.post("/:id/acknowledge", async (req, res) => {
  const id = req.params.id;
  const reasonRaw = (req.body as { reason?: unknown } | undefined)?.reason;
  const reason = typeof reasonRaw === "string" && reasonRaw.trim().length > 0 ? reasonRaw.trim() : null;

  const alert = await prisma.alert.findUnique({ where: { id } });
  if (!alert) {
    res.status(404).json({ error: "No such alert." });
    return;
  }
  if (alert.resolvedAt !== null) {
    res.status(409).json({ error: "That alert already resolved on its own." });
    return;
  }

  const userId = getAuth(req).userId ?? "unknown";
  const email = (await lookupUsers([userId])).get(userId)?.email ?? userId;

  await prisma.alert.update({
    where: { id },
    data: { acknowledgedAt: new Date(), acknowledgedBy: email, acknowledgedReason: reason },
  });

  logger.warn({ actorEmail: email, alertKey: alert.key, reason }, "internal_console_alert_acknowledged");
  res.json({ id, acknowledgedBy: email });
});
