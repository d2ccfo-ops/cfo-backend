import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
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
