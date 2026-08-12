import { Router } from "express";
import type { ActorType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

// §29 audit trail read side. UI lands in Phase 5; this exists now so the
// coverage added in P0.4a is verifiable and queryable from day one rather
// than write-only.

export const auditRouter = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

auditRouter.get("/", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;

  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;

  const action = typeof req.query.action === "string" ? req.query.action : undefined;
  const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;
  const actorType = typeof req.query.actorType === "string" ? (req.query.actorType as ActorType) : undefined;
  // Cursor is the id of the last row from the previous page — createdAt alone
  // isn't unique enough at bulk-import volume (many rows share a millisecond).
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  const rows = await prisma.auditLog.findMany({
    where: {
      organizationId,
      ...(action ? { action } : {}),
      ...(entityType ? { entityType } : {}),
      ...(actorType ? { actorType } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  res.json({
    entries: page.map((r) => ({
      id: r.id,
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  });
});

// Lets the UI populate filter dropdowns from what actually exists for this
// org, rather than a hardcoded list that drifts from the real action set.
auditRouter.get("/actions", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const rows = await prisma.auditLog.findMany({
    where: { organizationId },
    select: { action: true },
    distinct: ["action"],
    orderBy: { action: "asc" },
  });
  res.json({ actions: rows.map((r) => r.action) });
});
