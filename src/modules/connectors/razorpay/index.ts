import crypto from "node:crypto";
import type { SettlementLineType } from "@prisma/client";
import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";

// Razorpay is API-key based, not OAuth — there's no platform app, no
// install/callback dance. Each merchant generates their own key_id/key_secret
// (and their own webhook secret) in their own Razorpay dashboard and pastes
// them in via routes/connections/razorpay.ts. credentialsRef holds all three,
// encrypted together as JSON — see decodeCredentials() below.

const API_BASE = "https://api.razorpay.com/v1";
const PAGE_SIZE = 100; // Razorpay's max page size
const MAX_PAGES_PER_RUN = 500; // safety cap: 100 * 500 = 50k records per run

// P1.4: how far back a settlement-recon backfill reaches, and how many days
// one run will walk — same shape as Meta/Google Ads' BACKFILL_DAYS, needed
// here because /settlements/recon/combined is queried per calendar day, not
// by a `from` timestamp like /payments and /settlements above. A DELIBERATE
// gap from those two: they backfill unbounded history (no `from` at all on a
// null cursor), so a settlement older than 90 days still lands in Settlement
// — it just never gets SettlementLine items, same "reports the gap instead
// of guessing" posture as the rest of this codebase, not a bug to silently
// paper over with a wider window chosen without a real account to size it
// against. routes/connections/razorpay.ts calls backfill() inline in the
// connect request ("same trade-off as Shopify's backfill" — see
// cfo-docs/PROGRESS.md) — this rides that same already-accepted trade-off
// rather than introducing a new one; a 90-day day-walk stays well inside it.
const RECON_BACKFILL_DAYS = 90;
// Recon data is reported to lag a day or two behind settlement. An
// incremental sync re-walks a few days behind its cursor rather than
// resuming exactly at it, so a payout whose recon row wasn't ready on the
// last run still gets picked up — every write below is an upsert, so
// re-walking already-processed days costs API calls, not correctness.
const RECON_OVERLAP_DAYS = 3;
const MAX_RECON_DAYS_PER_RUN = 120; // headroom above the 90-day backfill window

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export function encodeCredentials(creds: RazorpayCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): RazorpayCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as RazorpayCredentials;
}

function authHeader(creds: RazorpayCredentials): string {
  return "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
}

// Exported separately because verifying a Razorpay webhook needs to try it
// against each connection's own secret (see verifyWebhook below) — the DB
// lookup that requires has to happen in the route, not inside the
// synchronous, stateless Connector.verifyWebhook signature.
export function verifyRazorpaySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const digestBuf = Buffer.from(digest);
  const sigBuf = Buffer.from(signature);
  return digestBuf.length === sigBuf.length && crypto.timingSafeEqual(digestBuf, sigBuf);
}

interface RazorpayPayment {
  id: string;
  order_id?: string | null;
  amount: number; // paise, already — Razorpay is paise-native like our schema
  currency: string;
  status: string;
  method?: string;
  fee?: number | null;
  tax?: number | null;
  created_at: number; // unix seconds
}

interface RazorpaySettlement {
  id: string;
  amount: number;
  fees?: number;
  tax?: number;
  utr?: string | null;
  status: string;
  created_at: number;
}

// Settlement Recon (the "Combined Settlement Report"): the one Razorpay API
// that states which payments, refunds, adjustments and transfers composed a
// given payout. modules/calc/reconciliation.ts's runPaymentSettlementLeg
// already fully consumes SettlementLine rows of type PAYMENT — it has been
// "unavailable" purely because nothing wrote them; this connects the two.
//
// Field names here are best-effort against Razorpay's published API
// reference, not confirmed against a live account — same caveat as the
// Shiprocket connector carries (see cfo-docs/ONBOARDING.md). Every item is
// saved verbatim (RawEvent.payload, SettlementLine.raw) specifically so a
// live response's actual shape can be diffed against this mapping and
// corrected without re-deriving it from scratch.
interface RazorpayReconItem {
  entity_id: string;
  // "refund" covers customer refunds; "adjustment" covers chargebacks/
  // disputes and other provider-side corrections — Razorpay does not appear
  // to split disputes into their own type, so both land as ADJUSTMENT lines
  // (raw.type is kept so a disputed item can still be told apart from a
  // routine correction by whoever reads it back).
  type: "payment" | "refund" | "adjustment" | "transfer";
  debit: number;
  credit: number;
  amount: number;
  fee?: number;
  tax?: number;
  settlement_id: string | null;
}

async function razorpayFetch<T>(creds: RazorpayCredentials, path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: authHeader(creds) } });
  if (!res.ok) throw new Error(`Razorpay API request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function recordAndProcessPayment(ctx: ConnectorContext, payment: RazorpayPayment) {
  const externalEventId = `payment_${payment.id}`;
  await prisma.rawEvent.upsert({
    where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
    create: {
      organizationId: ctx.organizationId,
      connectionId: ctx.connectionId,
      provider: "RAZORPAY",
      externalEventId,
      eventType: "payment.sync",
      payload: payment as unknown as object,
      processedAt: new Date(),
      processingStatus: "PROCESSED",
    },
    update: { payload: payment as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
  });
  await razorpayConnector.processEvent(ctx, payment, "payment.sync");
}

async function recordAndProcessSettlement(ctx: ConnectorContext, settlement: RazorpaySettlement) {
  const externalEventId = `settlement_${settlement.id}`;
  await prisma.rawEvent.upsert({
    where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
    create: {
      organizationId: ctx.organizationId,
      connectionId: ctx.connectionId,
      provider: "RAZORPAY",
      externalEventId,
      eventType: "settlement.sync",
      payload: settlement as unknown as object,
      processedAt: new Date(),
      processingStatus: "PROCESSED",
    },
    update: { payload: settlement as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
  });
  await razorpayConnector.processEvent(ctx, settlement, "settlement.sync");
}

async function pullPaginated<T>(
  creds: RazorpayCredentials,
  basePath: string,
  sinceUnix: number | null,
  onItem: (item: T) => Promise<void>
): Promise<number> {
  let skip = 0;
  let total = 0;
  let pages = 0;

  do {
    const query = new URLSearchParams({ count: String(PAGE_SIZE), skip: String(skip) });
    if (sinceUnix) query.set("from", String(sinceUnix));
    const data = await razorpayFetch<{ items: T[] }>(creds, `${basePath}?${query}`);
    for (const item of data.items) {
      await onItem(item);
      total++;
    }
    if (data.items.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    pages++;
  } while (pages < MAX_PAGES_PER_RUN);

  return total;
}

async function pull(ctx: ConnectorContext, sinceUnix: number | null): Promise<SyncResult> {
  const creds = decodeCredentials(ctx.credentialsRef);
  const paymentsCount = await pullPaginated<RazorpayPayment>(creds, "/payments", sinceUnix, (p) =>
    recordAndProcessPayment(ctx, p)
  );
  const settlementsCount = await pullPaginated<RazorpaySettlement>(creds, "/settlements", sinceUnix, (s) =>
    recordAndProcessSettlement(ctx, s)
  );
  // Recon runs LAST, after both payments and settlements for this same run
  // have landed — processReconItem resolves a recon item's settlement_id
  // and (for payment-type items) entity_id against rows this pull just
  // wrote, so ordering it first would make every item on its own first day
  // resolve nothing and wait for the next sync.
  const reconCount = await pullSettlementRecon(ctx, creds, sinceUnix);
  return { recordsFetched: paymentsCount + settlementsCount + reconCount, cursor: String(Math.floor(Date.now() / 1000)) };
}

export const razorpayConnector: Connector = {
  provider: "RAZORPAY",

  async backfill(ctx: ConnectorContext): Promise<SyncResult> {
    return pull(ctx, null);
  },

  async sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult> {
    return pull(ctx, sinceCursor ? Number(sinceCursor) : null);
  },

  // Unlike Shopify, the signing secret isn't a single platform-wide value —
  // each merchant configures their own in their own Razorpay dashboard. This
  // can't verify a signature on its own; routes/webhooks/razorpay.ts tries it
  // against every active Razorpay connection's stored secret. See
  // cfo-docs/ARCHITECTURE.md for why, and the scaling caveat that comes with it.
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): WebhookVerificationResult {
    return {
      valid: false,
      externalEventId: headers["x-razorpay-event-id"] ?? "",
      eventType: "unknown",
    };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, eventType: string): Promise<void> {
    if (eventType.startsWith("payment.")) {
      const p = payload as RazorpayPayment;
      await prisma.payment.upsert({
        where: { connectionId_externalPaymentId: { connectionId: ctx.connectionId, externalPaymentId: p.id } },
        create: {
          organizationId: ctx.organizationId,
          legalEntityId: ctx.legalEntityId,
          connectionId: ctx.connectionId,
          externalPaymentId: p.id,
          amount: BigInt(p.amount),
          currency: p.currency,
          method: p.method,
          status: p.status,
          feeAmount: p.fee != null ? BigInt(p.fee) : null,
          taxAmount: p.tax != null ? BigInt(p.tax) : null,
          capturedAt: new Date(p.created_at * 1000),
          raw: payload as object,
        },
        update: {
          status: p.status,
          feeAmount: p.fee != null ? BigInt(p.fee) : null,
          taxAmount: p.tax != null ? BigInt(p.tax) : null,
          raw: payload as object,
        },
      });
      return;
    }

    if (eventType.startsWith("settlement.")) {
      const s = payload as RazorpaySettlement;
      await prisma.settlement.upsert({
        where: { connectionId_externalSettlementId: { connectionId: ctx.connectionId, externalSettlementId: s.id } },
        create: {
          organizationId: ctx.organizationId,
          legalEntityId: ctx.legalEntityId,
          connectionId: ctx.connectionId,
          externalSettlementId: s.id,
          amount: BigInt(s.amount),
          feeAmount: BigInt(s.fees ?? 0),
          taxAmount: BigInt(s.tax ?? 0),
          utr: s.utr ?? null,
          status: s.status,
          settledAt: new Date(s.created_at * 1000),
          raw: payload as object,
        },
        update: {
          status: s.status,
          amount: BigInt(s.amount),
          feeAmount: BigInt(s.fees ?? 0),
          taxAmount: BigInt(s.tax ?? 0),
          raw: payload as object,
        },
      });
    }
  },
};

// ---------------------------------------------------------------------------
// P1.4: settlement items (§12.5)
// ---------------------------------------------------------------------------
//
// Not folded into processEvent() above: a recon item names its OWN entity
// (a payment, refund, adjustment or transfer id), not a payment or a
// settlement, so it needs its own eventType and its own resolution logic
// rather than overloading "payment."/"settlement." prefix matching.

/** True once an item names the payout it belongs to — recon can list items
 * still on hold with no settlement yet; those are skipped, not guessed at. */
function isSettled(item: RazorpayReconItem): item is RazorpayReconItem & { settlement_id: string } {
  return item.settlement_id != null;
}

export interface ReconItemResult {
  imported: boolean;
  reason?: "not_settled" | "settlement_not_found";
}

// Exported and decoupled from the HTTP fetch above specifically so this —
// the money-shaped mapping — is unit-testable without live Razorpay
// credentials. See RazorpayReconItem's header comment on why the field
// names it reads are best-effort.
export async function processReconItem(ctx: ConnectorContext, item: RazorpayReconItem): Promise<ReconItemResult> {
  if (!isSettled(item)) return { imported: false, reason: "not_settled" };

  const settlement = await prisma.settlement.findUnique({
    where: { connectionId_externalSettlementId: { connectionId: ctx.connectionId, externalSettlementId: item.settlement_id } },
    select: { id: true },
  });
  // The settlements pull runs before the recon pull on every call (see
  // pull() below), so this is expected to resolve on the same run the item
  // first appears — a miss here means the payout genuinely hasn't synced
  // yet, and the next sync's RECON_OVERLAP_DAYS re-walk will pick it up.
  if (!settlement) return { imported: false, reason: "settlement_not_found" };

  const lineType: SettlementLineType = item.type === "payment" ? "PAYMENT" : "ADJUSTMENT";
  const payment =
    item.type === "payment"
      ? await prisma.payment.findUnique({
          where: { connectionId_externalPaymentId: { connectionId: ctx.connectionId, externalPaymentId: item.entity_id } },
          select: { id: true },
        })
      : null;

  // credit/debit (not amount alone) is what the item actually contributed to
  // the payout: a refund's `amount` restates the original payment's value,
  // but its debit is what left this settlement.
  const netAmount = BigInt(Math.round(item.credit)) - BigInt(Math.round(item.debit));

  await prisma.settlementLine.upsert({
    where: {
      settlementId_type_externalReference: {
        settlementId: settlement.id,
        type: lineType,
        externalReference: item.entity_id,
      },
    },
    create: {
      organizationId: ctx.organizationId,
      settlementId: settlement.id,
      type: lineType,
      externalReference: item.entity_id,
      paymentId: payment?.id ?? null,
      grossAmount: BigInt(Math.round(item.amount)),
      feeAmount: BigInt(Math.round(item.fee ?? 0)),
      taxAmount: BigInt(Math.round(item.tax ?? 0)),
      netAmount,
      raw: item as unknown as object,
    },
    update: {
      paymentId: payment?.id ?? null,
      grossAmount: BigInt(Math.round(item.amount)),
      feeAmount: BigInt(Math.round(item.fee ?? 0)),
      taxAmount: BigInt(Math.round(item.tax ?? 0)),
      netAmount,
      raw: item as unknown as object,
    },
  });
  return { imported: true };
}

async function recordAndProcessReconItem(ctx: ConnectorContext, item: RazorpayReconItem) {
  const externalEventId = `recon_${item.entity_id}`;
  await prisma.rawEvent.upsert({
    where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
    create: {
      organizationId: ctx.organizationId,
      connectionId: ctx.connectionId,
      provider: "RAZORPAY",
      externalEventId,
      eventType: "settlement_recon.sync",
      payload: item as unknown as object,
      processedAt: new Date(),
      processingStatus: "PROCESSED",
    },
    update: { payload: item as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
  });
  await processReconItem(ctx, item);
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function pullReconDay(creds: RazorpayCredentials, day: Date, ctx: ConnectorContext): Promise<number> {
  let skip = 0;
  let total = 0;
  let pages = 0;
  const query0 = { year: String(day.getUTCFullYear()), month: String(day.getUTCMonth() + 1), day: String(day.getUTCDate()) };

  do {
    const query = new URLSearchParams({ ...query0, count: String(PAGE_SIZE), skip: String(skip) });
    const data = await razorpayFetch<{ items: RazorpayReconItem[] }>(creds, `/settlements/recon/combined?${query}`);
    for (const item of data.items) {
      await recordAndProcessReconItem(ctx, item);
      total++;
    }
    if (data.items.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    pages++;
  } while (pages < MAX_PAGES_PER_RUN);

  return total;
}

async function pullSettlementRecon(ctx: ConnectorContext, creds: RazorpayCredentials, sinceUnix: number | null): Promise<number> {
  const start = utcDayStart(
    sinceUnix
      ? new Date(sinceUnix * 1000 - RECON_OVERLAP_DAYS * 86_400_000)
      : new Date(Date.now() - RECON_BACKFILL_DAYS * 86_400_000)
  );
  const today = utcDayStart(new Date());

  let count = 0;
  let cursor = start;
  let daysWalked = 0;
  while (cursor.getTime() <= today.getTime() && daysWalked < MAX_RECON_DAYS_PER_RUN) {
    count += await pullReconDay(creds, cursor, ctx);
    cursor = new Date(cursor.getTime() + 86_400_000);
    daysWalked++;
  }
  return count;
}
