import { Router } from "express";
import { Prisma, MatchType } from "@prisma/client";
import { z } from "zod";
import { buildCodDataStatus, buildSettlementDataStatus } from "../modules/calc/dataStatus.js";
import { prisma } from "../lib/prisma.js";
import { describeRange, withDateRange, type ResolvedRange } from "../lib/dateRange.js";
import { requireAuth } from "../middleware/auth.js";
import { createApprovalRequest, getMaterialityThreshold, needsApproval } from "../modules/approvals/approvals.js";
import {
  AMOUNT_TOLERANCE_PAISE,
  getCodExposure,
  readFreightSummary,
  readReconciliationLegs,
  runReconciliation,
  RECONCILIATION_VERSION,
} from "../modules/calc/reconciliation.js";
import { getPairCandidates, pairOrderToPayment, unpairOrder } from "../modules/reconciliation/manualMatch.js";

export const reconciliationRouter = Router();

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

// P6.3. The note is bounded and optional — a pairing that carries a reason is
// worth more six months later than one that does not, but requiring it would
// train people to type "ok".
const pairSchema = z.object({
  paymentId: z.string().min(1).max(64),
  note: z.string().trim().max(500).optional().nullable().transform((v) => v || null),
});

// Every row status the list can return. Filtering happens in SQL against the
// same CASE expression that produces the value, so a filter can never disagree
// with the label the row carries.
const ROW_STATUSES = ["matched", "review", "unmatched", "cod_pending", "invoiced", "written_off", "cancelled"] as const;
type RowStatus = (typeof ROW_STATUSES)[number];
const VALID_ROW_STATUSES = new Set<string>(ROW_STATUSES);

function stringParam(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

// Keyset pagination on (placedAt DESC, id DESC), for the same reason
// routes/inventory.ts uses it: an offset re-scans and skips N rows per page,
// and a sync landing mid-scroll shifts every later page so rows silently
// duplicate or vanish. 49,617 orders is well past where that starts to matter.
interface Cursor {
  placedAt: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.placedAt !== "string" || typeof parsed?.id !== "string") return null;
    if (Number.isNaN(Date.parse(parsed.placedAt))) return null;
    return { placedAt: parsed.placedAt, id: parsed.id };
  } catch {
    return null;
  }
}

// The one definition of what an order's reconciliation state IS. Written once,
// as SQL, so the list, the filter and the counts cannot drift apart.
//
// Order of the branches is the whole logic:
//  - a human decision outranks anything derived
//  - a cancelled order was never owed money (§16), so it is not a failure
//  - an amount-and-date match without a shared key is a suggestion, not a fact
//  - a COD order has no gateway payment BY DESIGN — calling it "unmatched"
//    would make 72% of this store look broken
//  - an order raised on PAYMENT TERMS is an invoice, not a checkout. No
//    gateway payment was ever expected at order time, so "no payment found"
//    describes a failure that did not happen. Measured on this store: 145 of
//    145 "unmatched" orders (₹15.19 L) were draft orders with payment terms —
//    every single one, and not one a real payment failure.
//
// The terms test uses payment_terms rather than source_name because that is
// the actual business fact. source_name says who keyed the order in; the
// presence of terms says when the money is owed. (Verified: payment_terms
// appears on no other order source in this store.)
const HAS_PAYMENT_TERMS = Prisma.sql`(o.raw->'payment_terms' IS NOT NULL AND o.raw->'payment_terms' <> 'null'::jsonb)`;

const STATUS_CASE = Prisma.sql`
  CASE
    WHEN m.id IS NOT NULL AND m.status = 'RESOLVED' THEN 'written_off'
    WHEN o."cancelledAt" IS NOT NULL AND m.id IS NULL THEN 'cancelled'
    WHEN m.id IS NOT NULL AND m."amountDeltaAbs" > ${AMOUNT_TOLERANCE_PAISE} THEN 'review'
    WHEN m.id IS NOT NULL AND m.confidence IN ('MEDIUM', 'LOW') THEN 'review'
    WHEN m.id IS NOT NULL THEN 'matched'
    WHEN o."paymentMode" = 'COD' THEN 'cod_pending'
    WHEN ${HAS_PAYMENT_TERMS} THEN 'invoiced'
    ELSE 'unmatched'
  END`;

// The context that turns an alarming row into an understood one: who raised the
// invoice, for whom, on what terms, and what the customer was sent. All of it
// already sits in Order.raw — it was simply never read.
const INVOICE_CONTEXT = Prisma.sql`
  o.raw->'payment_terms'->>'payment_terms_name'  AS terms_name,
  o.raw->'payment_terms'->>'payment_terms_type'  AS terms_type,
  o.raw->'payment_terms'->>'due_in_days'         AS terms_due_in_days,
  o.raw->>'source_name'                          AS source_name,
  o.raw->>'user_id'                              AS staff_user_id,
  o.raw->>'email'                                AS customer_email,
  o.raw->>'confirmation_number'                  AS confirmation_number,
  o.raw->>'total_outstanding'                    AS total_outstanding,
  o.raw->>'tags'                                 AS order_tags,
  trim(concat(o.raw->'customer'->>'first_name', ' ', o.raw->'customer'->>'last_name')) AS customer_name`;

interface InvoiceContextRow {
  terms_name: string | null;
  terms_type: string | null;
  terms_due_in_days: string | null;
  source_name: string | null;
  staff_user_id: string | null;
  customer_email: string | null;
  confirmation_number: string | null;
  total_outstanding: string | null;
  order_tags: string | null;
  customer_name: string | null;
}

// Null for every row that isn't an invoice, so the frontend can branch on its
// presence rather than on a status string it would have to keep in sync.
function invoiceContext(status: RowStatus, r: InvoiceContextRow) {
  if (status !== "invoiced") return null;
  const dueDays = r.terms_due_in_days ? Number(r.terms_due_in_days) : null;
  return {
    termsName: r.terms_name,
    // "Due on receipt" with due_in_days null is Shopify's way of saying
    // payable now — stated explicitly so nobody reads null as "no due date".
    dueDescription:
      dueDays != null
        ? `Payable ${dueDays} days after the invoice date`
        : r.terms_type === "receipt"
          ? "Payable as soon as the invoice is sent"
          : "Payment terms set, no fixed due date",
    // Shopify's order payload carries the staff member's numeric id and no
    // name — the name is NOT in this data, so it is reported as an id rather
    // than guessed from the order tags, which are a merchant convention and
    // not an author record.
    staffUserId: r.staff_user_id,
    raisedInAdmin: r.source_name === "shopify_draft_order",
    sourceName: r.source_name,
    customerName: r.customer_name || null,
    customerEmail: r.customer_email,
    confirmationNumber: r.confirmation_number,
    outstanding: r.total_outstanding,
    tags: r.order_tags ? r.order_tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
  };
}

// LATERAL … LIMIT 1 rather than a plain LEFT JOIN. The engine guarantees at
// most one ORDER_PAYMENT match per order, but a plain join would fan out into
// duplicate rows if that guarantee ever broke — and duplicated rows do not just
// look wrong, they break keyset pagination outright, because two rows sharing a
// (placedAt, id) cursor make the next page skip real records. Enforcing
// one-row-per-order here means the page boundary cannot be corrupted by a bug
// somewhere else.
const BASE_FROM = Prisma.sql`
  FROM orders o
  LEFT JOIN LATERAL (
    SELECT rm.id, rm.status, rm.confidence, rm."amountDeltaAbs", rm."targetId", rm.note
    FROM reconciliation_matches rm
    WHERE rm."sourceType" = 'ORDER'
      AND rm."sourceId" = o.id
      AND rm."matchType" = 'ORDER_PAYMENT'
    -- P6.3. A HUMAN DECISION OUTRANKS A DERIVATION, always. Ordering by
    -- createdAt alone was fine while every row came from the engine, but a
    -- manual pairing is a claim someone is accountable for, and the next
    -- nightly run creating a row for a different payment would silently
    -- overrule it. Whoever paired this would see their decision quietly
    -- undone, with nothing to indicate it had happened.
    ORDER BY (rm.confidence = 'MANUAL') DESC, rm."createdAt" DESC
    LIMIT 1
  ) m ON true
  LEFT JOIN payments p ON p.id = m."targetId"`;

// Did a provider actually pay us for this order, and in which transfer?
//
// The status column next to this answers a narrower question than readers
// assume: "matched" means the order total agrees with a payment record, and
// BOTH of those come from the same source system. This lateral supplies the
// independent half — a settlement line from the gateway's own statement,
// carrying the UTR and date of the transfer it arrived in.
//
// Reached through payment→line and shipment→line, because a checkout funnel
// settles prepaid captures and COD cash in the same payout. Aggregated rather
// than taken as one row: an order can be split across payouts, and showing the
// first one found would understate what arrived.
const SETTLED_LATERAL = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT sum(sl."netAmount")::bigint   AS net,
           sum(sl."grossAmount")::bigint AS gross,
           sum(sl."feeAmount")::bigint   AS fee,
           -- The transfer a reader can look up in their bank. When an order
           -- spans payouts this names the latest, and the caller is told the
           -- line count so "one of two" is never read as "all of it".
           (array_agg(st.utr ORDER BY st."settledAt" DESC NULLS LAST))[1]         AS utr,
           (array_agg(st."settledAt" ORDER BY st."settledAt" DESC NULLS LAST))[1] AS settled_at
    FROM settlement_lines sl
    JOIN settlements st ON st.id = sl."settlementId"
    LEFT JOIN payments  sp ON sp.id = sl."paymentId"
    LEFT JOIN shipments ss ON ss.id = sl."shipmentId"
    WHERE sl."organizationId" = o."organizationId"
      AND (sp."orderId" = o.id OR ss."orderId" = o.id)
  ) settled ON true`;

// The period filter, applied to the order's PLACED date — the column the table
// shows and the only date every row is guaranteed to have. Payment/delivery
// dates were the alternative and are worse: an order would appear or vanish
// depending on when its money happened to arrive, so the same order could sit
// in two different periods on two different cards.
//
// Cut on the organisation's calendar, not UTC (§3) — resolveDateRange has
// already done that by the time this reads req.dateRange.
function placedAtCondition(range: ResolvedRange): Prisma.Sql {
  return Prisma.sql`o."placedAt" >= ${range.from} AND o."placedAt" <= ${range.to}`;
}

// ---------------------------------------------------------------------------
// GET /reconciliation/summary
// ---------------------------------------------------------------------------
// Deliberately does NOT run the engine. Reading a dashboard must not mutate
// anything, and a page load that silently rewrites match rows makes the
// numbers depend on who looked at them last.
// One serializer for both the period-scoped and all-time COD blocks, so the
// two can never drift in shape.
function serializeCod(c: Awaited<ReturnType<typeof getCodExposure>>) {
  return {
    inFlightCount: c.inFlightCount,
    inFlightValue: c.inFlightValue.toString(),
    deliveredCount: c.deliveredCount,
    deliveredValue: c.deliveredValue.toString(),
    rtoCount: c.rtoCount,
    rtoValue: c.rtoValue.toString(),
    // Parcels the courier stopped reporting on. Its own field because the
    // page must be able to say "we cannot see this" rather than filing it
    // under money still on its way.
    unknownCount: c.unknownCount,
    unknownValue: c.unknownValue.toString(),
    unknownOldestDays: c.unknownOldestDays,
    onlineDepositsValue: c.onlineDepositsValue.toString(),
    hasCourierData: c.hasCourierData,
  };
}

reconciliationRouter.get("/summary", ...requireAuth, withDateRange, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const range = req.dateRange!;

  const [statusRows, cod, codPosition, lastMatch, channelRows, legs, statementCoverage, freight] = await Promise.all([
    // sum() over a bigint column returns NUMERIC in Postgres, which Prisma
    // hands back as a Decimal — casting to ::bigint here keeps the whole
    // money path in exact integers rather than routing it through a decimal
    // type on the way out.
    prisma.$queryRaw<{ status: RowStatus; count: bigint; value: bigint }[]>(Prisma.sql`
      SELECT status, count(*) AS count, sum(expected)::bigint AS value FROM (
        SELECT ${STATUS_CASE} AS status, o."grossAmount" AS expected
        ${BASE_FROM}
        WHERE o."organizationId" = ${organizationId} AND ${placedAtCondition(range)}
      ) t
      GROUP BY status`),
    getCodExposure(organizationId, { from: range.from, to: range.to }),
    // The same exposure UN-ranged. COD held by a courier is a POSITION (what
    // exists right now), not a period flow — scoping it to the picker made the
    // settlements page report ₹0 unknown-COD on the default month-to-date view
    // while ₹72.2L of parcels sat silent, because none of those orders were
    // PLACED this month. Pages showing "where is the money now" read this one.
    getCodExposure(organizationId),
    prisma.reconciliationMatch.findFirst({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    // Populates the channel dropdown. Served with the summary rather than the
    // item pages so a DISTINCT scan doesn't re-run on every scroll tick.
    // Deliberately NOT period-scoped: this is the list of channels the store
    // has ever sold through, and scoping it would make the option a reader had
    // already selected disappear from the dropdown the moment they narrowed
    // the window — leaving a filter active with no visible way to clear it.
    prisma.order.findMany({
      where: { organizationId },
      distinct: ["channel"],
      select: { channel: true },
      orderBy: { channel: "asc" },
    }),
    // Read, not run (§ the engine writes; a page load must not). All-time by
    // design — a payment can settle in a period after its order was placed, so
    // scoping the chain to the picker above would report a break that is only
    // a window boundary.
    readReconciliationLegs(organizationId),
    // The window imported provider statements actually cover. The table needs
    // it to tell "this order was not paid" from "no statement reaches this
    // date yet" — without it, 24,000 orders placed after the last payout would
    // all read as missing money.
    prisma.settlement.aggregate({
      where: { organizationId },
      _min: { settledAt: true },
      _max: { settledAt: true },
      _count: { _all: true },
    }),
    // Freight coverage. Also all-time: an invoice arrives weeks after the
    // parcels it bills for, so scoping it to the picker would report a gap that
    // is only a billing cycle.
    readFreightSummary(organizationId),
  ]);

  const byStatus = Object.fromEntries(
    ROW_STATUSES.map((s) => [s, { count: 0, value: "0" }])
  ) as Record<RowStatus, { count: number | string; value: string }>;
  for (const row of statusRows) {
    byStatus[row.status] = { count: Number(row.count), value: (row.value ?? 0n).toString() };
  }

  // §53: coverage stated by VALUE as well as by count, because a store can
  // match 95% of its orders and still have the unmatched 5% carry most of the
  // money. Neither number alone is the truth.
  //
  // "invoiced" is excluded for the same reason COD is: the denominator is
  // orders that were SUPPOSED to produce a gateway payment at order time, and
  // an order raised on payment terms never was. Counting them as unmatched
  // would report a matching failure for 145 orders where nothing failed.
  const eligibleStatuses: RowStatus[] = ["matched", "review", "unmatched"];
  const eligibleCount = eligibleStatuses.reduce((n, s) => n + Number(byStatus[s].count), 0);
  const eligibleValue = eligibleStatuses.reduce((n, s) => n + BigInt(byStatus[s].value), 0n);
  const matchedCount = Number(byStatus.matched.count);
  const matchedValue = BigInt(byStatus.matched.value);

  res.json({
    version: RECONCILIATION_VERSION,
    lastRunAt: lastMatch?.createdAt ?? null,
    // Echoed back so the page states the window it is actually showing rather
    // than trusting what the picker last said — the two drifting apart is the
    // whole failure mode a period filter introduces.
    period: { from: range.from.toISOString(), to: range.to.toISOString(), isDefault: range.isDefault },
    window: describeRange(range),
    byStatus,
    // The headline. Denominator is orders that were SUPPOSED to have a gateway
    // payment — prepaid, not cancelled. COD is excluded on purpose and
    // reported separately below.
    autoMatched: {
      count: matchedCount,
      eligibleCount,
      pctByCount: eligibleCount > 0 ? (matchedCount / eligibleCount) * 100 : null,
      value: matchedValue.toString(),
      eligibleValue: eligibleValue.toString(),
      pctByValue: eligibleValue > 0n ? Number((matchedValue * 10000n) / eligibleValue) / 100 : null,
      basis:
        "Prepaid checkout orders, excluding cancelled. COD settles through courier remittance and invoiced orders settle on payment terms — neither produces a gateway payment at order time, so both are reported separately rather than counted as unmatched.",
    },
    cod: serializeCod(cod),
    // All-time COD position — see the getCodExposure call above for why this
    // exists alongside the period-scoped block.
    codPosition: serializeCod(codPosition),
    // The chain, always present rather than only after a run.
    legs: legs.map((leg) => ({
      ...leg,
      matchedValue: leg.matchedValue.toString(),
      unmatchedValue: leg.unmatchedValue.toString(),
    })),
    channels: channelRows.map((r) => r.channel),
    statementCoverage: {
      payoutCount: statementCoverage._count._all,
      earliest: statementCoverage._min.settledAt?.toISOString() ?? null,
      latest: statementCoverage._max.settledAt?.toISOString() ?? null,
    },
    // §28 status labels for the two figure families this summary carries.
    // Derived from the legs already loaded above — no extra queries.
    codDataStatus: buildCodDataStatus(legs.find((l) => l.matchType === MatchType.COD_REMITTANCE)),
    settlementDataStatus: buildSettlementDataStatus(legs.find((l) => l.matchType === MatchType.SETTLEMENT_BANK)),
    // What the imported freight invoices cover, including the part the leg
    // cannot express: lines billed for waybills that match no shipment at all.
    freight: {
      invoices: freight.invoices,
      lines: freight.lines,
      billedPaise: freight.billedPaise.toString(),
      linesWithoutShipment: freight.linesWithoutShipment,
      valueWithoutShipmentPaise: freight.valueWithoutShipmentPaise.toString(),
      returnLegCount: freight.returnLegCount,
      returnLegPaise: freight.returnLegPaise.toString(),
      creditCount: freight.creditCount,
      creditPaise: freight.creditPaise.toString(),
      carriers: freight.carriers,
      earliestShipDate: freight.earliestShipDate?.toISOString() ?? null,
      latestShipDate: freight.latestShipDate?.toISOString() ?? null,
    },
    tolerancePaise: AMOUNT_TOLERANCE_PAISE.toString(),
  });
});

// ---------------------------------------------------------------------------
// POST /reconciliation/run
// ---------------------------------------------------------------------------
// Runs inline rather than through the BullMQ sync queue. That queue exists to
// keep OUTBOUND provider API calls off the request thread; this touches
// nothing but our own Postgres, so queueing it would add a process hop and a
// polling UI for no benefit. If a store's order count ever makes this slow
// enough to notice, enqueueing it is a two-line change.
reconciliationRouter.post("/run", ...requireAuth, async (req, res) => {
  const result = await runReconciliation(req.auth!.organizationId);
  res.json({
    ...result,
    ranAt: result.ranAt.toISOString(),
    legs: result.legs.map((leg) => ({
      ...leg,
      matchedValue: leg.matchedValue.toString(),
      unmatchedValue: leg.unmatchedValue.toString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /reconciliation/items
// ---------------------------------------------------------------------------
//   ?status=<row status>   ?channel=<exact>   ?paymentMode=PREPAID|COD|UNKNOWN
//   ?search=<order number>   ?limit=1..200    ?cursor=<opaque>
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   (both or neither; org calendar, §3)
//
// Every filter is applied in SQL, before the page is cut. The alternative —
// shipping 49,617 rows and filtering in the browser — is the exact waste this
// endpoint is shaped to avoid.
reconciliationRouter.get("/items", ...requireAuth, withDateRange, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const range = req.dateRange!;

  const statusParam = stringParam(req.query.status);
  const status = statusParam && VALID_ROW_STATUSES.has(statusParam) ? statusParam : undefined;
  const channel = stringParam(req.query.channel);
  const paymentMode = stringParam(req.query.paymentMode);
  const search = stringParam(req.query.search);

  const rawLimit = Number.parseInt(stringParam(req.query.limit) ?? "", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const cursor = decodeCursor(stringParam(req.query.cursor));

  const conditions: Prisma.Sql[] = [
    Prisma.sql`o."organizationId" = ${organizationId}`,
    // Same window the summary cards were computed on, so the table below them
    // is a list OF those cards rather than a different question.
    placedAtCondition(range),
  ];
  if (channel) conditions.push(Prisma.sql`o.channel = ${channel}`);
  if (paymentMode) conditions.push(Prisma.sql`o."paymentMode" = ${paymentMode}`);
  if (search) conditions.push(Prisma.sql`o."orderNumber" ILIKE ${`%${search}%`}`);
  if (cursor) {
    conditions.push(
      Prisma.sql`(o."placedAt", o.id) < (${new Date(cursor.placedAt)}::timestamp, ${cursor.id})`
    );
  }
  // Status is derived, so it cannot be referenced by name in WHERE — the CASE
  // is repeated instead of being filtered in an outer query over a LIMITed
  // subquery. That subquery shape looks tidier and is wrong: it would take the
  // first N rows and THEN filter, returning short pages and a `hasMore` that
  // lies. Repeating one shared Prisma.sql constant costs nothing and keeps the
  // filter, the label and the page boundary describing the same set.
  if (status) conditions.push(Prisma.sql`${STATUS_CASE} = ${status}`);

  const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;

  // "Received" is the sum of CAPTURED payments on the order — not the matched
  // payment. The two differ exactly where it matters: a PPCOD order has a
  // real ₹21–51 deposit captured online but never has an ORDER_PAYMENT match
  // (COD settles via courier), so reading received off the match join showed
  // "—" for money that genuinely arrived. An aggregate is also more truthful
  // for multi-payment orders. Needs the payments("orderId") index.
  const rows = await prisma.$queryRaw<
    ({
      id: string;
      order_number: string;
      channel: string;
      payment_mode: string | null;
      placed_at: Date;
      expected: bigint;
      received: bigint | null;
      delta: bigint | null;
      confidence: string | null;
      status: RowStatus;
      note: string | null;
      settled_net: bigint | null;
      settled_gross: bigint | null;
      settled_fee: bigint | null;
      settled_utr: string | null;
      settled_at: Date | null;
    } & InvoiceContextRow)[]
  >(Prisma.sql`
    SELECT o.id,
           o."orderNumber"    AS order_number,
           o.channel,
           o."paymentMode"    AS payment_mode,
           o."placedAt"       AS placed_at,
           o."grossAmount"    AS expected,
           paid.amount        AS received,
           m."amountDeltaAbs" AS delta,
           m.confidence::text AS confidence,
           m.note,
           settled.net        AS settled_net,
           settled.gross      AS settled_gross,
           settled.fee        AS settled_fee,
           settled.utr        AS settled_utr,
           settled.settled_at AS settled_at,
           ${INVOICE_CONTEXT},
           ${STATUS_CASE} AS status
    ${BASE_FROM}
    LEFT JOIN LATERAL (
      SELECT sum(p2.amount)::bigint AS amount FROM payments p2
      WHERE p2."orderId" = o.id AND p2.status = 'captured'
    ) paid ON true
    ${SETTLED_LATERAL}
    ${where}
    ORDER BY o."placedAt" DESC, o.id DESC
    LIMIT ${limit + 1}`);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  res.json({
    items: page.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      channel: r.channel,
      paymentMode: r.payment_mode,
      placedAt: r.placed_at,
      expected: r.expected.toString(),
      received: r.received === null ? null : r.received.toString(),
      difference: r.received === null ? null : (r.received - r.expected).toString(),
      confidence: r.confidence,
      matchMethod: describeMethod(r.status, r.confidence, r.received, invoiceContext(r.status, r)),
      status: r.status,
      note: r.note,
      invoice: invoiceContext(r.status, r),
      settlement: settlementContext(r),
    })),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ placedAt: last.placed_at.toISOString(), id: last.id }) : null,
  });
});

// Null when no provider statement covers this order — which is the common case
// and NOT a failure: a statement is only ever imported for the days it covers,
// so an order placed yesterday has no payout yet by definition. The frontend
// distinguishes "settled", "no statement covers this date", and "a statement
// covers it and this order isn't in it" from these fields plus the coverage
// window, rather than collapsing all three into a blank cell.
function settlementContext(r: {
  settled_net: bigint | null;
  settled_gross: bigint | null;
  settled_fee: bigint | null;
  settled_utr: string | null;
  settled_at: Date | null;
}) {
  if (r.settled_net === null) return null;
  return {
    netAmount: r.settled_net.toString(),
    grossAmount: (r.settled_gross ?? 0n).toString(),
    feeAmount: (r.settled_fee ?? 0n).toString(),
    utr: r.settled_utr,
    settledAt: r.settled_at?.toISOString() ?? null,
  };
}

// Plain words for how a row reached its state. Deliberately NOT a confidence
// percentage: the engine produces an enum with three levels, and rendering
// that as "98%" would invent two digits of precision it never had (§109).
function describeMethod(
  status: RowStatus,
  confidence: string | null,
  receivedPaise: bigint | null = null,
  invoice: ReturnType<typeof invoiceContext> = null
): string {
  if (status === "written_off") return "Written off — manual";
  if (status === "cancelled") return "Order cancelled — no payment expected";
  if (status === "invoiced") {
    // Says why no gateway payment exists AND where the order came from, because
    // "no payment found" on a staff-raised invoice reads as a lost payment when
    // it is simply an unpaid bill.
    const where = invoice?.raisedInAdmin ? "Raised in Shopify admin" : "Invoiced order";
    const terms = invoice?.termsName ? ` on ${invoice.termsName.toLowerCase()} terms` : " on payment terms";
    return `${where}${terms} — awaiting payment, not a failed one`;
  }
  if (status === "cod_pending") {
    // A COD row with captured money is PPCOD: the deposit arrived online and
    // only the balance rides with the courier. Saying just "awaiting
    // remittance" would contradict the Received column sitting next to it.
    return receivedPaise !== null && receivedPaise > 0n
      ? "PPCOD — deposit received online, balance due at the door"
      : "Cash on delivery — awaiting courier remittance";
  }
  switch (confidence) {
    case "HIGH":
      return "Matched on order reference";
    case "MEDIUM":
      return "Matched on amount and date — needs confirmation";
    case "LOW":
      return "Weak match — needs confirmation";
    case "MANUAL":
      return "Matched manually";
    default:
      return "No payment found";
  }
}

// ---------------------------------------------------------------------------
// POST /reconciliation/items/:orderId/write-off
// ---------------------------------------------------------------------------
// A decision, not a derivation — the one thing the engine cannot recompute, so
// the one thing that must be stored. Recorded with a null target: no money
// arrived, and pretending otherwise by pointing at some payment would corrupt
// every total downstream.
reconciliationRouter.post("/items/:orderId/write-off", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const orderId = req.params.orderId;
  if (!orderId) {
    res.status(400).json({ error: "order_id_required" });
    return;
  }

  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : null;

  const order = await prisma.order.findFirst({
    where: { id: orderId, organizationId },
    select: { id: true, grossAmount: true, externalOrderId: true, placedAt: true, channel: true },
  });
  if (!order) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }

  // §22 (P5.2). Above the org's materiality threshold this stops being
  // housekeeping and becomes a decision, so it goes to a second person
  // instead of happening. Below it, nothing changes — requiring sign-off on
  // every ₹200 write-off is how approvals become a reflex click, and an
  // approval nobody reads launders a mistake into a decision two people made.
  const threshold = await getMaterialityThreshold(organizationId);
  const verdict = needsApproval("RECONCILIATION_WRITE_OFF", order.grossAmount, threshold);
  if (verdict.required) {
    const existingRequest = await prisma.approvalRequest.findFirst({
      where: { organizationId, entityType: "ORDER", entityId: orderId, status: "PENDING" },
      select: { id: true },
    });
    if (existingRequest) {
      res.status(409).json({
        error: "approval_pending",
        message: "A write-off for this order is already waiting for approval.",
        approvalRequestId: existingRequest.id,
      });
      return;
    }

    const request = await createApprovalRequest({
      organizationId,
      actionType: "RECONCILIATION_WRITE_OFF",
      title: `Write off order ${order.externalOrderId ?? orderId}`,
      reason: note ?? "No justification was given.",
      amountPaise: order.grossAmount,
      entityType: "ORDER",
      entityId: orderId,
      // Captured NOW, so the reviewer signs off on the figures that were
      // shown rather than on whatever the data says when they get to it.
      evidence: {
        orderId,
        externalOrderId: order.externalOrderId,
        channel: order.channel,
        placedAt: order.placedAt?.toISOString() ?? null,
        grossAmountPaise: order.grossAmount.toString(),
        thresholdPaise: threshold.toString(),
        rule: verdict.reason,
      },
      payload: { note },
      preparedBy: req.auth!.userId,
      requestedBy: req.auth!.userId,
    });

    // 202, not 200: the request was accepted and nothing has been written off.
    res.status(202).json({
      status: "approval_required",
      approvalRequestId: request.id,
      requiredRole: request.requiredRole,
      riskLevel: request.riskLevel,
      message: verdict.reason,
    });
    return;
  }

  const existing = await prisma.reconciliationMatch.findFirst({
    where: { organizationId, matchType: "ORDER_PAYMENT", sourceType: "ORDER", sourceId: orderId },
    select: { id: true },
  });

  const data = {
    status: "RESOLVED" as const,
    confidence: "MANUAL" as const,
    note,
    resolvedBy: req.auth!.userId,
    resolvedAt: new Date(),
  };

  const match = existing
    ? await prisma.reconciliationMatch.update({ where: { id: existing.id }, data })
    : await prisma.reconciliationMatch.create({
        data: {
          organizationId,
          matchType: "ORDER_PAYMENT",
          sourceType: "ORDER",
          sourceId: orderId,
          targetType: null,
          targetId: null,
          amountDeltaAbs: order.grossAmount,
          ...data,
        },
      });

  // Human decisions about money are audited — especially because restore
  // (below) DELETES the decision row, and without this trail "who wrote this
  // off and when" would be unanswerable afterwards.
  await prisma.auditLog.create({
    data: {
      organizationId,
      actorType: "USER",
      actorId: req.auth!.userId,
      action: "reconciliation.write_off",
      entityType: "ORDER",
      entityId: orderId,
      metadata: { note, amountPaise: order.grossAmount.toString() },
    },
  });

  res.json({ id: match.id, status: "written_off" });
});

// ---------------------------------------------------------------------------
// POST /reconciliation/items/:orderId/restore
// ---------------------------------------------------------------------------
// Undoes a write-off. The decision row is DELETED, not flipped back — we
// cannot know what the row's pre-decision state was (write-off overwrites
// confidence in place), and we don't need to: the engine is a pure function
// of orders/payments, so deleting the human override and re-running restores
// exactly what the evidence supports. Matched if a payment exists, unmatched
// if not — never a guess at "what it probably was".
reconciliationRouter.post("/items/:orderId/restore", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const orderId = req.params.orderId;
  if (!orderId) {
    res.status(400).json({ error: "order_id_required" });
    return;
  }

  // Scoped by org in the WHERE — an id from another tenant reads as "not
  // written off", never as something actionable.
  const { count } = await prisma.reconciliationMatch.deleteMany({
    where: {
      organizationId,
      matchType: "ORDER_PAYMENT",
      sourceType: "ORDER",
      sourceId: orderId,
      status: "RESOLVED",
    },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_written_off" });
    return;
  }

  await prisma.auditLog.create({
    data: {
      organizationId,
      actorType: "USER",
      actorId: req.auth!.userId,
      action: "reconciliation.restore",
      entityType: "ORDER",
      entityId: orderId,
    },
  });

  // Re-run inline so the row's state is truthful in THIS response, not after
  // some future run. ~0.5s against 25k orders — well within a request.
  await runReconciliation(organizationId);

  const rows = await prisma.$queryRaw<
    ({ received: bigint | null; confidence: string | null; status: RowStatus; note: string | null } &
      InvoiceContextRow)[]
  >(Prisma.sql`
    SELECT paid.amount AS received, m.confidence::text AS confidence, m.note,
           ${INVOICE_CONTEXT},
           ${STATUS_CASE} AS status
    ${BASE_FROM}
    LEFT JOIN LATERAL (
      SELECT sum(p2.amount)::bigint AS amount FROM payments p2
      WHERE p2."orderId" = o.id AND p2.status = 'captured'
    ) paid ON true
    WHERE o."organizationId" = ${organizationId} AND o.id = ${orderId}`);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }

  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { grossAmount: true } });
  res.json({
    id: orderId,
    status: row.status,
    received: row.received === null ? null : row.received.toString(),
    difference:
      row.received === null || !order ? null : (row.received - order.grossAmount).toString(),
    confidence: row.confidence,
    matchMethod: describeMethod(row.status, row.confidence, row.received, invoiceContext(row.status, row)),
    note: row.note,
    invoice: invoiceContext(row.status, row),
  });
});

// ---------------------------------------------------------------------------
// P6.3 — MANUAL MATCH PAIRING (§15)
// ---------------------------------------------------------------------------
// Thin over modules/reconciliation/manualMatch.ts — the reasoning, the refusal
// and the audit trail all live there so they can be exercised without HTTP.
// These handlers only map results onto status codes.

/** Payments that could plausibly belong to this order, for the pairing UI. */
reconciliationRouter.get("/items/:orderId/pair-candidates", ...requireAuth, async (req, res, next) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId) {
      res.status(400).json({ error: "order_id_required" });
      return;
    }
    const result = await getPairCandidates(req.auth!.organizationId, orderId);
    if (!result) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    res.json({
      order: {
        id: result.order.id,
        externalOrderId: result.order.externalOrderId,
        grossAmountPaise: result.order.grossAmount.toString(),
        placedAt: result.order.placedAt.toISOString(),
      },
      windowDays: result.windowDays,
      candidates: result.candidates.map((c) => ({
        id: c.id,
        externalPaymentId: c.externalPaymentId,
        amountPaise: c.amountPaise.toString(),
        differencePaise: c.differencePaise.toString(),
        capturedAt: c.capturedAt?.toISOString() ?? null,
        method: c.method,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Pair an order to a payment by hand. */
reconciliationRouter.post("/items/:orderId/pair", ...requireAuth, async (req, res, next) => {
  try {
    const orderId = req.params.orderId;
    const parsed = pairSchema.safeParse(req.body);
    if (!orderId || !parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        detail: parsed.success ? "order_id_required" : parsed.error.issues,
      });
      return;
    }

    const result = await pairOrderToPayment(
      req.auth!.organizationId,
      orderId,
      parsed.data.paymentId,
      parsed.data.note,
      req.auth!.userId
    );

    if (!result.ok) {
      if (result.reason === "payment_already_matched") {
        res.status(409).json({
          error: result.reason,
          // Names the other order. "Already matched" alone leaves someone
          // hunting through the table for which one.
          message: `That payment is already matched to order ${result.conflictingOrderRef ?? result.conflictingOrderId}. Unpair it there first — one payment cannot settle two orders.`,
          conflictingOrderId: result.conflictingOrderId,
        });
        return;
      }
      res.status(404).json({ error: result.reason });
      return;
    }

    res.json({
      id: result.matchId,
      status: "matched",
      confidence: "MANUAL",
      differencePaise: result.differencePaise.toString(),
      matchMethod: "Matched manually",
    });
  } catch (err) {
    next(err);
  }
});

/** Undo a manual pairing. */
reconciliationRouter.post("/items/:orderId/unpair", ...requireAuth, async (req, res, next) => {
  try {
    const organizationId = req.auth!.organizationId;
    const orderId = req.params.orderId;
    if (!orderId) {
      res.status(400).json({ error: "order_id_required" });
      return;
    }

    const { unpaired } = await unpairOrder(organizationId, orderId, req.auth!.userId);
    if (!unpaired) {
      res.status(404).json({ error: "not_manually_paired" });
      return;
    }

    // Re-run so the row's state in THIS response is what the evidence
    // supports, rather than an empty state that resolves at some later run.
    await runReconciliation(organizationId);
    res.json({ status: "unpaired" });
  } catch (err) {
    next(err);
  }
});
