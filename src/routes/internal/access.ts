import { getAuth } from "@clerk/express";
import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { lookupUsers, findUserByEmail } from "../../lib/clerkDirectory.js";
import {
  activeOperatorCount,
  invalidateOperatorCache,
  isEnvOperator,
  listOperators,
} from "../../lib/internalOperators.js";

// WHO MAY SEE EVERY TENANT AT ONCE, editable from the console.
//
// THE FIRST WRITES ON THIS ROUTER, and the exception is narrow on purpose. The
// rule stated in ./index.ts — nothing here writes — was about the SIZE OF THE
// BLAST RADIUS: an operator console that can change customer data is a much
// bigger thing to secure than one that can only look. That reasoning is intact.
// These two writes touch no tenant data at all. They edit the console's own
// guest list, and the alternative was editing an environment variable and
// restarting the API, which is a worse operation performed by the same people
// with less of a record of who did it.
//
// FOUR GUARDS, none of them optional:
//
//   1. Environment operators cannot be revoked here. They are break glass; see
//      lib/internalOperators.ts. The console does not offer the control and the
//      server refuses it independently, because a UI-only guard is not a guard.
//   2. Nobody can revoke themselves. The realistic accident is an operator
//      tidying a list and removing the row they are sitting on.
//   3. The last active operator cannot be revoked. Checked against env plus
//      database, so "revoke everyone" cannot empty the console.
//   4. Nothing is deleted, ever. A revoke sets revokedAt, so who could read
//      cross-tenant data at any past moment stays answerable.
//
// The rows themselves are the audit trail. AuditLog is keyed by organizationId
// and these events belong to no organisation — writing them there would mean
// inventing a tenant or weakening every other row's guarantee. Every change is
// also logged to the process log with actor and target.

export const internalAccessRouter = Router();

/**
 * The current caller, for attribution.
 *
 * THE EMAIL IS RESOLVED FROM CLERK, NOT READ OFF THE SESSION. The obvious
 * version took `sessionClaims.email`, and a Clerk session JWT does not carry
 * one unless the instance's token template has been edited to add it — so every
 * row recorded `grantedByEmail: "unknown"`. An audit trail whose actor column
 * says "unknown" is not an audit trail, and the failure is silent: the write
 * succeeds, the page renders, and only the history is worthless.
 *
 * One extra lookup, on a write that happens a few times a year, and it is
 * cached. Falls back to the user id — which is at least an identifier — rather
 * than to the word "unknown".
 */
async function actor(req: Parameters<typeof getAuth>[0]): Promise<{ userId: string; email: string }> {
  const userId = getAuth(req).userId ?? "unknown";
  const entry = userId === "unknown" ? undefined : (await lookupUsers([userId])).get(userId);
  return { userId, email: entry?.email ?? userId };
}

/** Everyone who has, or has had, access — both sources, names filled in. */
internalAccessRouter.get("/", async (req, res) => {
  const entries = await listOperators();
  const directory = await lookupUsers(entries.map((e) => e.clerkUserId));
  const me = getAuth(req).userId;

  res.json({
    you: me,
    operators: entries.map((e) => {
      const d = directory.get(e.clerkUserId);
      return {
        ...e,
        name: d?.name ?? null,
        // The database copy is what the grant recorded; Clerk's is current. The
        // stored one wins for environment entries, which have none.
        email: d?.email ?? e.email,
        imageUrl: d?.imageUrl ?? null,
        banned: d?.banned ?? false,
        /** True for the caller's own row — the console disables revoke on it. */
        isYou: e.clerkUserId === me,
        /** Set when Clerk has no such account: a grant that authorises nobody. */
        unresolved: !directory.has(e.clerkUserId),
      };
    }),
    activeCount: await activeOperatorCount(),
  });
});

/**
 * Grant access, by email address or by Clerk user id.
 *
 * EMAIL IS RESOLVED THROUGH CLERK RATHER THAN TRUSTED. A typed address that
 * matches no account would otherwise be stored as a grant that authorises
 * nobody and looks exactly like one that works — the operator would believe
 * they had added their colleague, and find out otherwise when it mattered.
 */
internalAccessRouter.post("/", async (req, res) => {
  const body = req.body as { email?: unknown; clerkUserId?: unknown; note?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const givenId = typeof body.clerkUserId === "string" ? body.clerkUserId.trim() : "";
  const note = typeof body.note === "string" && body.note.trim().length > 0 ? body.note.trim() : null;

  if (!email && !givenId) {
    res.status(400).json({ error: "Provide an email address or a Clerk user id." });
    return;
  }

  let clerkUserId = givenId;
  let resolvedEmail = email;

  try {
    if (!clerkUserId) {
      const found = await findUserByEmail(email);
      if (!found) {
        res.status(404).json({ error: `No account with the email ${email}. They must sign in once first.` });
        return;
      }
      clerkUserId = found.clerkUserId;
      resolvedEmail = found.email ?? email;
    } else {
      const found = (await lookupUsers([clerkUserId])).get(clerkUserId);
      if (!found) {
        res.status(404).json({ error: `No account with the id ${clerkUserId}.` });
        return;
      }
      resolvedEmail = found.email ?? "";
    }
  } catch (err) {
    // Ambiguous email, or Clerk unreachable. Both are refusals rather than
    // guesses — see findUserByEmail on why picking a match is not acceptable.
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not reach the identity provider." });
    return;
  }

  if (isEnvOperator(clerkUserId)) {
    res.status(409).json({ error: "That account already has access from the deployment allowlist." });
    return;
  }

  const a = await actor(req);
  // Upsert, not create: re-granting someone previously revoked must revive the
  // same row rather than fail on the unique id or leave two conflicting
  // histories for one person.
  const row = await prisma.internalOperator.upsert({
    where: { clerkUserId },
    create: {
      clerkUserId,
      email: resolvedEmail,
      note,
      grantedByUserId: a.userId,
      grantedByEmail: a.email,
    },
    update: {
      email: resolvedEmail,
      note,
      grantedAt: new Date(),
      grantedByUserId: a.userId,
      grantedByEmail: a.email,
      revokedAt: null,
      revokedByUserId: null,
      revokedByEmail: null,
    },
  });

  invalidateOperatorCache();
  logger.warn(
    { actorUserId: a.userId, actorEmail: a.email, targetUserId: clerkUserId, targetEmail: resolvedEmail },
    "internal_console_access_granted",
  );
  res.status(201).json({ id: row.id, clerkUserId, email: resolvedEmail });
});

/** Revoke access. A timestamp, never a delete. */
internalAccessRouter.post("/:id/revoke", async (req, res) => {
  const id = req.params.id;
  const row = await prisma.internalOperator.findUnique({ where: { id } });

  if (!row) {
    res.status(404).json({ error: "No such grant." });
    return;
  }
  if (row.revokedAt !== null) {
    res.status(409).json({ error: "That grant was already revoked." });
    return;
  }

  const a = await actor(req);
  if (row.clerkUserId === a.userId) {
    // Guard 2. The realistic accident, not a hostile one.
    res.status(409).json({ error: "You cannot revoke your own access." });
    return;
  }
  if ((await activeOperatorCount()) <= 1) {
    // Guard 3. Unreachable while any environment operator exists, and that is
    // the point — it is the check that holds when none does.
    res.status(409).json({ error: "That is the last operator. Grant someone else first." });
    return;
  }

  await prisma.internalOperator.update({
    where: { id },
    data: { revokedAt: new Date(), revokedByUserId: a.userId, revokedByEmail: a.email },
  });

  invalidateOperatorCache();
  logger.warn(
    { actorUserId: a.userId, actorEmail: a.email, targetUserId: row.clerkUserId, targetEmail: row.email },
    "internal_console_access_revoked",
  );
  // Revocation is not instant everywhere: sibling API processes hold their own
  // 15-second cache. Reported rather than hidden, so the console can say so
  // instead of implying the door shut the moment the button was pressed.
  res.json({ id, revoked: true, effectiveWithinSeconds: 15 });
});
