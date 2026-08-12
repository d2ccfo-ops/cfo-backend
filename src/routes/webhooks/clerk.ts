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
        // The role has to be RECONCILED, not overwritten. Clerk knows two
        // roles; §12.2 has seven. Writing mapClerkRole(data.role) on every
        // update — which is what this did — would silently flatten an
        // in-app FINANCE_MANAGER or EXTERNAL_CA back to the default the next
        // time Clerk fired an unrelated membership event, and nothing would
        // say so. See reconcileRole below.
        const existing = await prisma.membership.findUnique({
          where: {
            organizationId_clerkUserId: {
              organizationId: organization.id,
              clerkUserId: data.public_user_data.user_id,
            },
          },
          select: { role: true },
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
            role: reconcileRole(data.role, null),
          },
          update: {
            email: data.public_user_data.identifier,
            role: reconcileRole(data.role, existing?.role ?? null),
          },
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

      // ---------------------------------------------------------------------
      // §12.1 auth events (P5.4)
      // ---------------------------------------------------------------------
      // Sign-ins, sign-outs, revoked sessions and 2FA changes, recorded in the
      // SAME audit log as every money decision. That is the point: "who saw
      // this figure" and "who changed it" are the same question when the
      // answer is a person, and splitting authentication into a separate log
      // means nobody correlates a strange write with the session that made it.
      //
      // These events name a USER, not an organisation, so they are written
      // against every organisation that user belongs to. An admin auditing
      // their own org must be able to see a session event for one of their
      // members without being handed every other tenant's.
      case "session.created":
      case "session.ended":
      case "session.removed":
      case "session.revoked": {
        const data = event.data as {
          id: string;
          user_id: string;
          client_id?: string;
          last_active_at?: number;
        };
        await auditAuthEvent(data.user_id, event.type, {
          sessionId: data.id,
          clientId: data.client_id ?? null,
        });
        break;
      }

      case "user.updated": {
        // Clerk does not fire a dedicated event when someone turns 2FA on or
        // off; it arrives as a user.updated with the flag flipped. Recorded
        // explicitly because "MFA was disabled at 03:12" is exactly the line
        // an incident review needs, and it is invisible otherwise.
        const data = event.data as { id: string; two_factor_enabled?: boolean; banned?: boolean };
        await auditAuthEvent(data.id, "user.updated", {
          twoFactorEnabled: data.two_factor_enabled ?? null,
          banned: data.banned ?? null,
        });
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

/**
 * Reconcile Clerk's two-role model with §12.2's seven.
 *
 * Clerk is the authority on ADMINISTRATIVE standing — who can manage the
 * organisation itself. CFOOS is the authority on FUNCTIONAL role — who signs
 * off on money, who enters costs, who is a read-only guest. Neither can
 * express the other's distinctions, so the merge rules are:
 *
 *   org:owner  → OWNER, always. Ownership is Clerk's to assert.
 *   org:admin  → ADMIN, unless the stored role is already OWNER (Clerk lists
 *                the owner as an admin too, and demoting them here would let
 *                an org lose its only owner to a webhook replay).
 *   org:member → keep whatever functional role was assigned in-app. Only when
 *                the stored role is an ADMINISTRATIVE one does this become a
 *                real demotion, and then it lands on ANALYST — the read-and-
 *                analyse default that MEMBER always meant.
 *
 * New members default to ANALYST rather than MEMBER. MEMBER remains a valid
 * enum value for the rows that already carry it; nothing writes it any more.
 */
export function reconcileRole(clerkRole: string, existing: MembershipRole | null): MembershipRole {
  if (clerkRole === "org:owner") return "OWNER";
  if (clerkRole === "org:admin") return existing === "OWNER" ? "OWNER" : "ADMIN";
  // Clerk says plain member.
  if (existing === null) return "ANALYST";
  if (existing === "OWNER" || existing === "ADMIN") return "ANALYST";
  return existing;
}

/**
 * Write an auth event to the audit log of every organisation the user belongs
 * to.
 *
 * Fanned out rather than stored once against a null organisation, because
 * every read path in this system is org-scoped by construction (§12.2) and an
 * unscoped row would be either invisible or visible to everyone. Duplicating
 * a handful of session rows across the two or three orgs a person belongs to
 * is the cheap side of that trade.
 */
async function auditAuthEvent(clerkUserId: string, action: string, metadata: Record<string, unknown>) {
  const memberships = await prisma.membership.findMany({
    where: { clerkUserId },
    select: { organizationId: true, email: true },
  });
  if (memberships.length === 0) {
    // A session for someone who belongs to no organisation yet — signing up.
    // Nothing to scope it to, and inventing a home for it would put it
    // somewhere it does not belong.
    logger.info({ clerkUserId, action }, "clerk_auth_event_unscoped");
    return;
  }
  await prisma.auditLog.createMany({
    data: memberships.map((m) => ({
      organizationId: m.organizationId,
      actorType: "USER" as const,
      actorId: clerkUserId,
      action: `auth.${action.replace(".", "_")}`,
      entityType: "SESSION",
      entityId: (metadata.sessionId as string) ?? clerkUserId,
      metadata: { ...metadata, email: m.email } as never,
    })),
  });
}
