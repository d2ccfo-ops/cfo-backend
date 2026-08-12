import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { requireAuth } from "../middleware/auth.js";
import { ROLE_ORDER, normaliseRole, requireRole } from "../middleware/rbac.js";
import { prisma } from "../lib/prisma.js";

export const organizationRouter = Router();

// Who the caller's organisation is, as THIS system knows it — deliberately not
// as Clerk knows it.
//
// The one field that matters here is `isDemo`. Synthetic data written by
// scripts/seedDemoData.ts is, by construction, indistinguishable from measured
// data once it is in the tables — that is what makes it useful and what makes
// it dangerous. The frontend has spent this whole project refusing to render a
// number it cannot stand behind; that discipline is worth nothing if the
// database itself is fabricated and nobody says so.
//
// So the seeder marks its work in two places, and this endpoint reports both:
// the organisation name carries a "DEMO — " prefix, and every connection it
// created carries a `demo-seed:` credentials reference. The name alone would be
// too easy to undo by accident; the connections are the load-bearing marker.
organizationRouter.get("/", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const [org, demoConnections] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, timezone: true, createdAt: true },
    }),
    prisma.connection.count({ where: { organizationId, credentialsRef: { startsWith: "demo-seed:" } } }),
  ]);
  if (!org) return res.status(404).json({ error: "organization_not_found" });

  res.json({
    ...org,
    isDemo: demoConnections > 0,
    demoConnectionCount: demoConnections,
    // Said once, here, so every surface that shows the banner words it the same.
    demoNote:
      demoConnections > 0
        ? "Every figure in this organisation is generated, not measured. It is shaped to look like a real Indian D2C brand — including its RTO rate, COD mix and failed payments — which is exactly why it must never be read as one."
        : null,
  });
});

// ---------------------------------------------------------------------------
// §12.2 team management (P5.1)
// ---------------------------------------------------------------------------
// The Team page was decorative: roles were stored by the Clerk webhook and
// read by nothing, so every member of an organisation had every permission.
// These two endpoints, plus middleware/rbac.ts, make the page mean something.

organizationRouter.get("/members", ...requireAuth, async (req, res) => {
  const members = await prisma.membership.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, clerkUserId: true, email: true, role: true, createdAt: true },
  });
  res.json({
    members: members.map((m) => ({
      ...m,
      // The stored value AND what it resolves to. A row still carrying the
      // legacy MEMBER should show as MEMBER and be explained, not silently
      // relabelled — someone auditing permissions needs to see what is in the
      // database.
      role: m.role,
      effectiveRole: normaliseRole(m.role),
      isYou: m.clerkUserId === req.auth!.userId,
      createdAt: m.createdAt.toISOString(),
    })),
    roles: ROLE_ORDER,
    yourRole: req.auth!.role,
    // Whether the caller may change anything here, so the UI can render
    // read-only rather than offer a control that 403s.
    canManage: req.auth!.role === "OWNER" || req.auth!.role === "ADMIN",
  });
});

const roleSchema = z.object({ role: z.enum(ROLE_ORDER as [string, ...string[]]) }).strict();

organizationRouter.patch(
  "/members/:id/role",
  ...requireAuth,
  // enforceRbac already restricts /organization writes to OWNER and ADMIN.
  // This states it again at the one endpoint that changes who can do what,
  // because a permission change is the wrong place to rely on a path prefix
  // continuing to mean what it means today.
  requireRole("OWNER", "ADMIN"),
  async (req, res, next) => {
    let parsed: { role: string };
    try {
      parsed = roleSchema.parse(req.body ?? {});
    } catch (err) {
      next(err);
      return;
    }

    const target = await prisma.membership.findFirst({
      where: { id: req.params.id, organizationId: req.auth!.organizationId },
      select: { id: true, clerkUserId: true, email: true, role: true },
    });
    // 404, not 403: a valid id from another organisation must not be confirmed
    // to exist.
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Nobody demotes themselves out of the ability to undo it. Without this an
    // organisation's only admin can lock everyone out of connections and
    // member management with one click and no way back.
    if (target.clerkUserId === req.auth!.userId && parsed.role !== req.auth!.role) {
      res.status(409).json({
        error: "cannot_change_own_role",
        message: "You cannot change your own role. Ask another owner or admin to do it.",
      });
      return;
    }

    // An organisation must always have at least one OWNER.
    if (target.role === "OWNER" && parsed.role !== "OWNER") {
      const owners = await prisma.membership.count({
        where: { organizationId: req.auth!.organizationId, role: "OWNER" },
      });
      if (owners <= 1) {
        res.status(409).json({
          error: "last_owner",
          message: "This is the organisation's only owner. Promote someone else to owner first.",
        });
        return;
      }
    }

    // Only an OWNER creates another OWNER. An ADMIN promoting themselves a
    // deputy who can then remove them is not a hierarchy.
    if (parsed.role === "OWNER" && req.auth!.role !== "OWNER") {
      res.status(403).json({
        error: "owner_only",
        message: "Only an owner can make someone else an owner.",
      });
      return;
    }

    const updated = await prisma.membership.update({
      where: { id: target.id },
      data: { role: parsed.role as never },
      select: { id: true, email: true, role: true },
    });

    await writeAudit({
      organizationId: req.auth!.organizationId,
      actorType: "USER",
      actorId: req.auth!.userId,
      action: "membership.role_changed",
      entityType: "MEMBERSHIP",
      entityId: target.id,
      metadata: { email: target.email, from: target.role, to: parsed.role },
    });

    res.json({ ...updated, effectiveRole: normaliseRole(updated.role) });
  }
);
