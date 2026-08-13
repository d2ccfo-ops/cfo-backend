import { Prisma } from "@prisma/client";

// ONE definition of "this payment actually moved money".
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// Payment.status is a free-text String — no enum, no constraint — written by
// whichever connector ingested the row, in whatever spelling that provider
// uses. Five call sites had grown three different opinions about it:
//
//   · calc/moneyMovement.ts   status: "CAPTURED"        ← matched NOTHING
//   · calc/reconciliation.ts  status: { in: [six spellings] }
//   · everywhere else         status: "captured"
//
// The uppercase one was not a style difference. Every writer in this codebase
// stores lowercase (Shopify inserts the literal 'captured'; Razorpay passes
// through its own lowercase value), and Prisma string equality is
// case-sensitive — so getPendingSettlements matched zero rows and reported
// "the gateway owes you ₹0" as a MEASURED fact, with hasSettlementLines true
// and no unavailableReason to hint otherwise. That answer is wired into the AI
// tool registry, so asking "what is the gateway still holding?" returned ₹0
// for an org with ₹2.6 Cr of captured payments.
//
// A single constant cannot be disagreed with by a sixth call site.
//
// ---------------------------------------------------------------------------
// WHY THESE SPELLINGS, AND NOT MORE
// ---------------------------------------------------------------------------
// The semantic is "the customer's money left their account". An AUTHORISED
// payment has moved nothing yet — the hold is reversible — and a FAILED one
// never will; counting either as received is how a dashboard shows cash that
// does not exist. So authorized/failed/refunded are deliberately absent, and
// this list must not grow to include them.
//
// The synonyms are real provider vocabulary, not defensive padding: Razorpay
// reports "captured", marketplace payout feeds report "paid", and some
// gateways report "processed" for the same event.
const CAPTURED_SPELLINGS = ["captured", "processed", "paid", "settled"] as const;

/**
 * Every casing of every spelling, for a Prisma `in` filter.
 *
 * Enumerated rather than using Prisma's `mode: "insensitive"` because that
 * mode forces a case-insensitive collation scan and cannot use the
 * (organizationId, status) index — on a table with 20k+ rows per org, on the
 * request path, that is a measurable regression for no benefit when the set of
 * real values is this small.
 */
export const CAPTURED_STATUSES: string[] = CAPTURED_SPELLINGS.flatMap((s) => [
  s,
  s.toUpperCase(),
  s.charAt(0).toUpperCase() + s.slice(1),
]);

/** Prisma filter fragment: `where: { ...capturedFilter() }`. */
export const capturedStatusFilter = () => ({ status: { in: CAPTURED_STATUSES } });

/**
 * The same predicate for raw SQL, where several reconciliation queries live.
 *
 * `lower(p.status) IN (...)` rather than the enumerated list: inside raw SQL
 * there is no Prisma query planner to protect, the row sets are already being
 * scanned, and the shorter form is far harder to get subtly wrong by hand.
 */
export function capturedStatusSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`lower(${column}) IN (${Prisma.join(CAPTURED_SPELLINGS.map((s) => Prisma.sql`${s}`))})`;
}

/** For in-memory checks over rows already fetched. */
export function isCapturedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return (CAPTURED_SPELLINGS as readonly string[]).includes(status.toLowerCase());
}
