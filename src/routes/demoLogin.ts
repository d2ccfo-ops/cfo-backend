import { Router } from "express";
import type { MembershipRole } from "@prisma/client";
import { createClerkClient } from "@clerk/backend";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { writeAudit } from "../lib/audit.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { normaliseRole } from "../middleware/rbac.js";

// One-click sign-in for the showcase account.
//
// WHY THIS EXISTS AT ALL. The demo login has a password, and typing it does
// not work: Clerk's Client Trust (now "Device Trust") fires on any password
// sign-in from a device it has not seen, and answers `needs_client_trust` —
// which emails a code to an inbox the person at the demo does not have. The
// alternative was turning Device Trust off, which removes credential-stuffing
// protection from EVERY account on the instance, including the owner's. A
// sign-in token skips first-factor verification entirely, so the demo works
// without weakening the real accounts.
//
// WHAT MAKES THIS SAFE ENOUGH TO BE PUBLIC. It is a deliberate decision to let
// anyone who loads the login page read one organisation's books, so the
// controls are about making sure it is ONLY that:
//
//   It is off unless DEMO_LOGIN_EMAIL is set. No flag to forget — the feature
//   cannot exist without naming the exact account it signs in.
//
//   The request body is ignored. There is no user, org or role parameter to
//   tamper with; the only account reachable is the one in the environment.
//
//   Tokens live 60 seconds and Clerk retires them on first use, so a link
//   copied out of a network tab is worthless by the time it is pasted.
//
//   The role is re-checked on every call, against the database, and OWNER or
//   ADMIN is refused. If that account is ever promoted — by a webhook, by a
//   console click, by a future migration — this endpoint stops working instead
//   of handing a stranger an owner session. That is the check that matters,
//   because the account is what changes over time, not this code.
//
// WHERE THE CEILING IS, AND WHY IT IS NOT "EVERYTHING". The demo runs as
// FINANCE_MANAGER, which is every day-to-day action a paying customer takes:
// entering and restamping costs, writing off exceptions, acknowledging
// anomalies, running what-if scenarios, triggering a resync, approvals,
// notifications, reports. Reads were never restricted for any role, so every
// page, figure and chart was always fully visible.
//
// The two things it stops short of are the two that end the demo rather than
// demonstrate it:
//
//   /connections/<provider>/connect and /install — every connector exposes
//   one, and each OVERWRITES the stored credential for that provider. A
//   visitor pasting a junk Shopify token replaces the working one for every
//   later visitor, and nothing in the product can undo it. Note this is the
//   whole risk: there is no disconnect route in this codebase and no delete
//   button in the UI, so "a visitor deletes a source" is not a thing that can
//   happen — the credential overwrite is.
//
//   /legal-entities — the company identity every page is labelled with.
//   (/organization has no member-write route today; the prefix policy covers
//   it anyway so one added later inherits the refusal.)
//
// Raising the ceiling is a one-line change (add "OWNER" to SHAREABLE_ROLES and
// set the membership role), and it is the owner's call — but it hands the
// first curious visitor the ability to overwrite a live credential, so it is
// not the default.
//
// WHAT IT STILL COSTS. This account can ask the AI CFO, and every question
// spends tokens on the owner's Anthropic key — a public demo login is a public
// spend endpoint. Point the demo at a budget-capped key. It can also write
// costs and exception decisions, which persist for later visitors; that is the
// deliberate trade for a demo where nothing a visitor clicks returns a
// permission error.

export const demoLoginRouter = Router();

/**
 * Roles this endpoint will hand to a stranger.
 *
 * Exported so the tests assert the real list rather than a copy of it — a
 * duplicated constant is how a widened permission passes a suite unchanged.
 * OWNER and ADMIN are the two omissions, and both for the same reason: they
 * can POST /connections/<provider>/connect, which overwrites the stored
 * credential for a live source. That breaks the demo for everyone who comes
 * after rather than showing them anything, and cannot be undone in-product.
 */
export const SHAREABLE_ROLES: MembershipRole[] = ["FINANCE_MANAGER", "ACCOUNTANT", "ANALYST", "VIEWER"];

// Deliberately far below the global write limit. Nothing legitimate needs to
// start more than a handful of demo sessions a minute from one address, and
// unauthenticated requests key on IP — the weak key is acceptable here only
// because the endpoint grants one fixed, pre-vetted identity rather than
// acting on a caller-supplied one.
const DEMO_LIMIT = { max: 10, windowSeconds: 60, bucket: "demo-login" };

// Long enough to survive the redirect and Clerk's handshake, short enough that
// a token seen in a log is already dead.
const TOKEN_TTL_SECONDS = 60;

demoLoginRouter.post("/auth/demo-login", rateLimit(DEMO_LIMIT), async (req, res) => {
  const email = env.DEMO_LOGIN_EMAIL;
  if (!email) {
    // Not an error — the deployment simply has no demo account.
    res.status(404).json({ error: "demo_login_disabled", message: "No demo account is configured on this server." });
    return;
  }

  try {
    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

    const found = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
    const user = found.data[0];
    if (!user) {
      logger.error({ email }, "demo_login_user_missing");
      res.status(500).json({ error: "demo_login_misconfigured", message: "The demo account does not exist." });
      return;
    }

    // The authorisation check, and the reason it reads the database rather
    // than trusting the environment variable: DEMO_LOGIN_EMAIL says which
    // account to sign in, not what that account may do. Roles change; this
    // refuses rather than escalates when they do.
    const memberships = await prisma.membership.findMany({
      where: { clerkUserId: user.id },
      select: { role: true, organizationId: true },
    });
    if (memberships.length === 0) {
      logger.error({ userId: user.id }, "demo_login_no_membership");
      res.status(500).json({ error: "demo_login_misconfigured", message: "The demo account belongs to no organisation." });
      return;
    }
    const tooPowerful = memberships.filter((m) => !SHAREABLE_ROLES.includes(normaliseRole(m.role)));
    if (tooPowerful.length > 0) {
      // Loud, because this means the account drifted into something that must
      // never be handed out, and the demo silently continuing would be worse
      // than the demo being broken.
      logger.error(
        { userId: user.id, roles: tooPowerful.map((m) => m.role) },
        "demo_login_refused_account_can_rotate_credentials"
      );
      res.status(403).json({
        error: "demo_login_unsafe",
        message:
          "The demo account can overwrite data-source credentials and will not be shared. Lower its role to FINANCE_MANAGER or below.",
      });
      return;
    }

    const token = await clerk.signInTokens.createSignInToken({
      userId: user.id,
      expiresInSeconds: TOKEN_TTL_SECONDS,
    });

    // §29. Every issuance is recorded — this is the one door into the system
    // that no human account vouched for, so the log is the only account of who
    // came through it. Fire-and-forget: failing to write history must not
    // break the sign-in that already succeeded.
    void writeAudit({
      organizationId: memberships[0]!.organizationId,
      actorType: "SYSTEM",
      actorId: user.id,
      action: "demo.signin_token_issued",
      entityType: "USER",
      entityId: user.id,
      metadata: { ip: req.ip ?? null, userAgent: req.get("user-agent")?.slice(0, 200) ?? null },
    }).catch(() => {});

    logger.info({ userId: user.id, ip: req.ip }, "demo_login_issued");
    res.json({ ticket: token.token });
  } catch (err) {
    logger.error({ err }, "demo_login_failed");
    res.status(500).json({ error: "demo_login_failed", message: "Could not start a demo session." });
  }
});
