import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";

// APPLICATION ERRORS, GROUPED BY WHAT THEY ARE RATHER THAN WHEN THEY HAPPENED.
//
// THE MASKING IS THE WHOLE TRICK. Real error messages carry the one thing that
// makes grouping fail: an id, a uuid, a row count, a timestamp. "Order
// cmst32isn000f not found" and "Order cmsvqn4rl0urc not found" are one fault
// and would fingerprint as two, and after a busy afternoon the errors page is a
// thousand groups of one — which is a log file with worse ergonomics and no
// grouping at all.
//
// So the message is normalised before hashing: anything that looks like an
// identifier becomes a placeholder. The verbatim text of the most recent
// occurrence is kept separately, because the masked form is right for grouping
// and useless for debugging.
//
// THE CLASSIFIER LESSON APPLIES DIRECTLY. syncErrorClass.ts originally matched
// on the words a person expects to see — "decrypt", "auth_tag" — and left 3,513
// of 4,342 real failures in "other", because Node's actual message
// ("Invalid authentication tag length: 0") contains neither. Rules written
// against imagined text are wrong in exactly the cases that matter. Nothing
// here matches on content: it masks structurally and hashes what is left.
//
// RECORDING NEVER THROWS. This runs inside an error handler. A failure here
// would replace a 500 the caller could act on with a crash they cannot.

/** Bounded so one enormous stack cannot bloat a row. */
const MAX_STACK = 4000;
const MAX_MESSAGE = 1000;

/**
 * Replace everything that varies between occurrences of the same fault.
 *
 * Order matters: the longest and most specific patterns run first, so a uuid is
 * not half-eaten by the hex rule before it is recognised.
 */
export function maskMessage(raw: string): string {
  return raw
    .slice(0, MAX_MESSAGE)
    // uuid
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    // ISO timestamps
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<time>")
    // cuid / cuid2, which is what every id in this schema is
    .replace(/\bc[a-z0-9]{20,32}\b/g, "<id>")
    // Clerk ids, which are prefixed and would otherwise survive
    .replace(/\b(user|org|sess|client)_[A-Za-z0-9]{10,}\b/g, "<$1_id>")
    // quoted strings — usually a value, rarely part of the fault's identity
    .replace(/'[^']{0,120}'/g, "'<v>'")
    .replace(/"[^"]{0,120}"/g, '"<v>"')
    // long hex blobs
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    // any remaining number of two digits or more
    .replace(/\b\d{2,}\b/g, "<n>")
    .trim();
}

/** The first frame that belongs to this application, not to node_modules. */
function topFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n").slice(1)) {
    const t = line.trim();
    if (!t.startsWith("at ")) continue;
    if (t.includes("node_modules") || t.includes("node:internal")) continue;
    // Strip line:column — a fault does not become a different fault because a
    // line was added above it.
    return t.replace(/:\d+:\d+\)?$/, ")").slice(0, 200);
  }
  return "";
}

export function fingerprintOf(name: string, message: string, stack: string | undefined, route: string | null): string {
  return createHash("sha1")
    .update([name, maskMessage(message), topFrame(stack), route ?? ""].join("|"))
    .digest("hex")
    .slice(0, 32);
}

export interface RecordErrorInput {
  error: unknown;
  route?: string | null;
  method?: string | null;
  /**
   * Where the fault happened. "browser" comes through /telemetry/errors and is
   * fingerprinted by the same rules on purpose — a fault that occurs on both
   * sides of the wire genuinely is one fault, and two error pages with two
   * masking rules would be two places to forget to look.
   */
  source?: "api" | "worker" | "browser";
  organizationId?: string | null;
}

/**
 * Record one occurrence. Fire-and-forget by design.
 *
 * `affectedOrgs` is incremented rather than computed from a list of tenant ids.
 * Storing which organisations hit an error would put tenant identity in a
 * cross-tenant table for a number that only needs to answer "how widespread" —
 * the count is the severity signal and the list is a support question answered
 * elsewhere. It over-counts a repeat visitor, and that is the accepted cost of
 * not holding the data.
 */
export async function recordError(input: RecordErrorInput): Promise<void> {
  try {
    const err = input.error;
    const name = err instanceof Error ? err.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const route = input.route ?? null;

    const fingerprint = fingerprintOf(name, message, stack, route);
    const now = new Date();

    await prisma.errorGroup.upsert({
      where: { fingerprint },
      create: {
        fingerprint,
        name,
        message: maskMessage(message),
        lastMessage: message.slice(0, MAX_MESSAGE),
        route,
        method: input.method ?? null,
        source: input.source ?? "api",
        lastStack: stack?.slice(0, MAX_STACK) ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        affectedOrgs: input.organizationId ? 1 : 0,
      },
      update: {
        count: { increment: 1 },
        lastSeenAt: now,
        lastMessage: message.slice(0, MAX_MESSAGE),
        lastStack: stack?.slice(0, MAX_STACK) ?? null,
        affectedOrgs: input.organizationId ? { increment: 1 } : undefined,
        // A fault that recurs after being resolved is NEW again. Leaving it
        // RESOLVED would hide a regression behind someone's earlier judgement.
        status: "NEW",
        resolvedAt: null,
      },
    });
  } catch (err) {
    // Never throws. This runs inside an error handler; a failure here would
    // turn a 500 the caller can act on into a crash they cannot.
    logger.warn({ err }, "error_group_record_failed");
  }
}
