import { Router } from "express";
import type { NotificationSeverity, NotificationType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { runNotificationRules } from "../modules/notifications/notifications.js";

// §23 read/write side. Nothing here decides what is worth notifying about —
// that lives in modules/notifications, the same separation every other route
// in this codebase keeps between the engine and the transport.

export const notificationsRouter = Router();

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export function serializeNotification(n: {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  resourceType: string | null;
  resourceId: string | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: n.id,
    type: n.type,
    severity: n.severity,
    title: n.title,
    body: n.body,
    resourceType: n.resourceType,
    resourceId: n.resourceId,
    readAt: n.readAt?.toISOString() ?? null,
    read: n.readAt !== null,
    createdAt: n.createdAt.toISOString(),
  };
}

// ?unread=true  ?limit=1..100
//
// Returns the unread COUNT alongside the rows, always. The bell needs a badge
// and the dropdown needs a list, and letting the client derive the count from
// a truncated list would under-report the moment there were more than `limit`
// — which is exactly when the badge matters.
notificationsRouter.get("/", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const unreadOnly = String(req.query.unread ?? "") === "true";

  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { organizationId, ...(unreadOnly ? { readAt: null } : {}) },
      // Unread first, then newest. A founder opening the bell wants what they
      // have not seen, not a reverse-chronological mix in which yesterday's
      // unread critical sits below three things they already dismissed.
      orderBy: [{ readAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
      take: limit,
      select: {
        id: true, type: true, severity: true, title: true, body: true,
        resourceType: true, resourceId: true, readAt: true, createdAt: true,
      },
    }),
    prisma.notification.count({ where: { organizationId, readAt: null } }),
  ]);

  res.json({ notifications: rows.map(serializeNotification), unreadCount, limit });
});

// Marking read is the ONLY mutation. There is no delete: a notification is a
// record that someone was told, and removing it would make the trail lie about
// what was communicated.
notificationsRouter.post("/:id/read", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  // findFirst scoped by organizationId, not findUnique by id — otherwise a
  // valid id from another tenant would be updatable. Cross-org access 404s.
  const existing = await prisma.notification.findFirst({
    where: { id: req.params.id, organizationId },
    select: { id: true, readAt: true },
  });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Idempotent: re-reading something already read must not move its timestamp,
  // or "when did they first see this" becomes unanswerable.
  const updated = existing.readAt
    ? existing
    : await prisma.notification.update({ where: { id: existing.id }, data: { readAt: new Date() } });
  res.json({ id: updated.id, readAt: (updated.readAt ?? new Date()).toISOString(), read: true });
});

notificationsRouter.post("/read-all", ...requireAuth, async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { organizationId: req.auth!.organizationId, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ marked: result.count });
});

// Manual run, same reasoning as POST /anomalies/run: waiting until 02:45
// tomorrow to find out whether the emitters produce sane rows is not a
// workable feedback loop.
notificationsRouter.post("/run", ...requireAuth, async (req, res) => {
  const result = await runNotificationRules(req.auth!.organizationId);
  res.json(result);
});
