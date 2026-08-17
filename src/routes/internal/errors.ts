import { getAuth } from "@clerk/express";
import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { lookupUsers } from "../../lib/clerkDirectory.js";

// APPLICATION ERROR GROUPS — the largest read gap this console had.
//
// Written by middleware/errorHandler.ts through modules/observability/
// errorGroups.ts, which fingerprints a fault by its SHAPE rather than its text.
// Read here, plus one write: a status a person sets.
//
// STATUS IS NOT A DELETE. Resolving records a judgement; the row and its counts
// stay. A fault that recurs after being resolved is reset to NEW by the
// recorder, so somebody's earlier "fixed" cannot hide today's regression behind
// itself.

export const internalErrorsRouter = Router();

const STATUSES = ["NEW", "ACKNOWLEDGED", "RESOLVED"] as const;
type Status = (typeof STATUSES)[number];

internalErrorsRouter.get("/groups", async (req, res) => {
  const days = Math.min(Number(req.query.days) > 0 ? Math.trunc(Number(req.query.days)) : 7, 90);
  const requested = typeof req.query.status === "string" ? req.query.status.toUpperCase() : null;
  const status = STATUSES.find((s) => s === requested) ?? null;
  const from = new Date(Date.now() - days * 86_400_000);

  const [groups, first] = await Promise.all([
    prisma.errorGroup.findMany({
      where: { lastSeenAt: { gte: from }, ...(status ? { status } : {}) },
      orderBy: [{ status: "asc" }, { count: "desc" }],
      take: 200,
    }),
    prisma.errorGroup.findFirst({ orderBy: { firstSeenAt: "asc" }, select: { firstSeenAt: true } }),
  ]);

  res.json({
    windowDays: days,
    // Stated, so an empty page reads as "nothing has broken since this shipped"
    // rather than "errors are not recorded". Two very different things, and
    // this table only started collecting the day it was deployed.
    recordingSince: first?.firstSeenAt.toISOString() ?? null,
    groups: groups.map((g) => ({
      id: g.id,
      fingerprint: g.fingerprint,
      name: g.name,
      /** Masked — ids and timestamps replaced, which is what makes grouping work. */
      message: g.message,
      /** Verbatim, most recent. The masked form groups; this one debugs. */
      lastMessage: g.lastMessage,
      route: g.route,
      method: g.method,
      source: g.source,
      lastStack: g.lastStack,
      count: g.count,
      affectedOrgs: g.affectedOrgs,
      status: g.status,
      firstSeenAt: g.firstSeenAt.toISOString(),
      lastSeenAt: g.lastSeenAt.toISOString(),
      notes: g.notes,
    })),
    totals: {
      groups: groups.length,
      occurrences: groups.reduce((a, g) => a + g.count, 0),
      unresolved: groups.filter((g) => g.status !== "RESOLVED").length,
    },
  });
});

internalErrorsRouter.post("/groups/:id/status", async (req, res) => {
  const id = req.params.id;
  const body = req.body as { status?: unknown; notes?: unknown };
  const requested = typeof body.status === "string" ? body.status.toUpperCase() : "";
  const status = STATUSES.find((s) => s === requested);
  const notes = typeof body.notes === "string" && body.notes.trim().length > 0 ? body.notes.trim() : null;

  if (!status) {
    res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}.` });
    return;
  }

  const group = await prisma.errorGroup.findUnique({ where: { id } });
  if (!group) {
    res.status(404).json({ error: "No such error group." });
    return;
  }

  const userId = getAuth(req).userId ?? "unknown";
  const email = (await lookupUsers([userId])).get(userId)?.email ?? userId;

  await prisma.errorGroup.update({
    where: { id },
    data: {
      status,
      resolvedAt: status === "RESOLVED" ? new Date() : null,
      notes: notes ?? group.notes,
    },
  });

  logger.info({ actorEmail: email, fingerprint: group.fingerprint, status }, "internal_console_error_status_set");
  res.json({ id, status, by: email });
});
