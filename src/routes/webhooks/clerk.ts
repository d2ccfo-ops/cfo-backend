import { Router } from "express";
import { Webhook } from "svix";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import type { MembershipRole } from "@prisma/client";

export const clerkWebhookRouter = Router();

// Clerk is the source of truth for who exists and which org they belong to.
// This endpoint is the ONLY place that writes Organization/Membership rows —
// nothing else should create them, so this table never drifts from Clerk.
// Must be mounted with express.raw() (see app.ts) — svix verifies the raw body.
clerkWebhookRouter.post("/", async (req, res) => {
  const payload = req.body as Buffer;
  const headers = {
    "svix-id": req.header("svix-id") ?? "",
    "svix-timestamp": req.header("svix-timestamp") ?? "",
    "svix-signature": req.header("svix-signature") ?? "",
  };

  let event: { type: string; data: Record<string, unknown> };
  try {
    const wh = new Webhook(env.CLERK_WEBHOOK_SECRET);
    event = wh.verify(payload, headers) as typeof event;
  } catch (err) {
    logger.warn({ err }, "clerk_webhook_signature_invalid");
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  try {
    switch (event.type) {
      case "organization.created":
      case "organization.updated": {
        const data = event.data as { id: string; name: string };
        await prisma.organization.upsert({
          where: { clerkOrgId: data.id },
          create: { clerkOrgId: data.id, name: data.name },
          update: { name: data.name },
        });
        break;
      }

      case "organizationMembership.created":
      case "organizationMembership.updated": {
        const data = event.data as {
          organization: { id: string; name: string };
          public_user_data: { user_id: string; identifier: string };
          role: string;
        };
        // Clerk fires organization.created and organizationMembership.created
        // for the same org essentially simultaneously (creating an org always
        // creates the creator's membership too), so this event can genuinely
        // arrive and finish processing before organization.created does — this
        // is not a rare edge case, it's the common case. Rather than depend on
        // arrival order, upsert the org here too: the membership payload
        // already embeds the full organization object.
        const organization = await prisma.organization.upsert({
          where: { clerkOrgId: data.organization.id },
          create: { clerkOrgId: data.organization.id, name: data.organization.name },
          update: { name: data.organization.name },
          select: { id: true },
        });
        await prisma.membership.upsert({
          where: {
            organizationId_clerkUserId: {
              organizationId: organization.id,
              clerkUserId: data.public_user_data.user_id,
            },
          },
          create: {
            organizationId: organization.id,
            clerkUserId: data.public_user_data.user_id,
            email: data.public_user_data.identifier,
            role: mapClerkRole(data.role),
          },
          update: { role: mapClerkRole(data.role) },
        });
        break;
      }

      case "organizationMembership.deleted": {
        const data = event.data as {
          organization: { id: string };
          public_user_data: { user_id: string };
        };
        const organization = await prisma.organization.findUnique({
          where: { clerkOrgId: data.organization.id },
          select: { id: true },
        });
        if (organization) {
          await prisma.membership.deleteMany({
            where: { organizationId: organization.id, clerkUserId: data.public_user_data.user_id },
          });
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    logger.error({ err, eventType: event.type }, "clerk_webhook_processing_failed");
    res.status(500).json({ error: "processing_failed" });
    return;
  }

  res.json({ received: true });
});

function mapClerkRole(clerkRole: string): MembershipRole {
  if (clerkRole === "org:admin") return "ADMIN";
  if (clerkRole === "org:owner") return "OWNER";
  return "MEMBER";
}
