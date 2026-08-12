import crypto from "node:crypto";
import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import { ingestStatement, type IngestResult, type StatementFormat } from "../remittance/statement.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";

// GoKwik. Structurally different from every other connector here, and the
// difference is the point.
//
// GoKwik is not a courier and not a payment gateway — it sits between them. It
// runs the checkout, decides which customers may pay cash on delivery, and then
// COLLECTS AND REMITS that cash itself. That makes it the one source that can
// close the loop this system has never been able to close:
//
//   the courier says a parcel was delivered
//   GoKwik says the cash for it was remitted, in payout X
//   the bank says payout X landed
//
// Without the middle statement, a delivered COD order and a bank credit can only
// be tied together by guessing at amounts — which is exactly why
// reconciliation.ts reported COD_REMITTANCE as `unavailable` rather than
// producing matches it could not stand behind.
//
// Two paths, same reasoning as Bluedart:
//   1. ORDER/RTO STATUS — a real HTTP API, used to enrich COD orders with
//      GoKwik's own view (verified, prepaid-converted, RTO-flagged).
//   2. SETTLEMENT — a report, not an endpoint. GoKwik publishes settlement and
//      remittance as downloadable statements, so that path is an import.
//
// VERIFIED against GoKwik's published material (the RTO Model vF spec at
// cdn.gokwik.co/rto-doc/rto-predict-api.pdf and their integration docs), which
// corrected three things:
//
//   - AUTH is `appid` / `appsecret` — bare lowercase header names, no `x-`
//     prefix and no separate merchant-id header. The merchant id (`mid`) is a
//     BODY/QUERY field, not a credential header.
//   - THE VERSION IS PER-ENDPOINT, not global. Orders live under `/v1`
//     (`/v1/order/create`), RTO prediction under `/v2` (`/v2/rto/predict`).
//     A single `API_BASE` ending in `/v1` cannot express that.
//   - THE HOST DIFFERS BY ENVIRONMENT (`sandbox.gokwik.co` vs production).
//     Hardcoding one guarantees the other is wrong, so it is configurable.
//
// Still unverified (no live merchant account): the settlement endpoint's exact
// path and response shape. GoKwik does publish a Settlement API — DataChannel's
// GoKwik connector pulls settlement reports through it for exactly the
// reconciliation use case this connector serves — but its spec is behind
// merchant onboarding, so the settlement path here remains a statement import.
// That import is not subject to vendor drift: its columns are defined in this
// repo.

// PRODUCTION by default, overridable to https://sandbox.gokwik.co.
//
// It defaulted to sandbox on the theory that this was the safe choice. Probing
// a real merchant showed the opposite: sandbox answers "Merchant not
// registered!" for a live mid, because merchants exist on ONE host or the
// other. Defaulting to sandbox therefore guaranteed failure for every real
// merchant, while being no safer — these are read-only GET endpoints.
const API_HOST = process.env.GOKWIK_API_HOST ?? "https://api.gokwik.co";

export interface GokwikCredentials {
  merchantId: string;
  appId: string;
  appSecret: string;
}

export function encodeCredentials(creds: GokwikCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): GokwikCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as GokwikCredentials;
}

// Field names below are GoKwik's own, as they appear in its order payloads:
// `mid` merchant id, `moid` merchant order id (the merchant's own reference),
// `gokwik_oid` GoKwik's internal order id. `order_type` — not
// `payment_method` — is what carries COD vs prepaid.
interface GokwikOrder {
  request_id?: string;
  gokwik_oid?: string;
  mid?: string;
  moid?: string;
  merchant_order_id?: string;
  order_type?: string; // COD | PREPAID
  payment_method?: string; // older spelling, still accepted
  order_status?: string;
  phone?: string;
  rto_flag?: boolean | string;
  rto_risk?: string; // low | medium | high
  total?: number | string;
  total_amount?: number | string;
  created_at?: string;
}

// GoKwik has used both spellings across its integration surfaces. Reading both
// costs nothing; reading one and being wrong means every COD order silently
// keeps whatever payment mode it already had.
function paymentModeOf(o: GokwikOrder): "COD" | "PREPAID" | null {
  const raw = (o.order_type ?? o.payment_method ?? "").trim().toUpperCase();
  if (raw === "COD") return "COD";
  if (raw === "PREPAID") return "PREPAID";
  return null;
}

// GoKwik wraps EVERYTHING in this envelope and returns HTTP 200 even when the
// call failed — an application error arrives as `{"statusCode":500,
// "statusMessage":"Unable to get order details","data":{}}` with a 200 status
// line. Verified against the live production API.
//
// A plain `res.ok` check passes, and `data` then arrives as an empty OBJECT
// where an array was expected. Measured against the real response, the old code
// fell through the `orders.length === 0` guard (an object has no `.length`) and
// died in the `for…of` with "orders is not iterable" — an error that blames
// this file and hides what GoKwik actually said. The connection ends up FAILED
// with a message no one can act on.
interface GokwikEnvelope<T> {
  statusCode?: number;
  statusMessage?: string;
  data?: T;
}

interface GokwikOrdersResponse {
  data?: GokwikOrder[] | Record<string, unknown>;
  orders?: GokwikOrder[];
  next_cursor?: string | null;
  has_more?: boolean;
}

// Treats the ENVELOPE as the source of truth, not the HTTP status line.
// Anything other than an explicit success is thrown with GoKwik's own message,
// so it lands in Connection.lastSyncError where a human can read it.
function unwrapEnvelope<T>(body: GokwikEnvelope<T>, what: string): T {
  const code = body.statusCode;
  if (code !== undefined && code !== 200 && code !== 201) {
    throw new Error(`gokwik ${what} failed (statusCode ${code}): ${body.statusMessage ?? "no message"}`);
  }
  return body.data as T;
}

function authHeaders(creds: GokwikCredentials): Record<string, string> {
  return {
    appid: creds.appId,
    appsecret: creds.appSecret,
    "Content-Type": "application/json",
  };
}

// GoKwik references the merchant's own order id, which for a Shopify store is
// the order NAME ("#1042"), sometimes with the hash stripped and sometimes not.
// Both are tried rather than assuming one — a reference that fails to resolve
// is a silently missing reconciliation, not an error anyone would see.
function orderNumberCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const bare = trimmed.replace(/^#/, "");
  return [...new Set([trimmed, bare, `#${bare}`])];
}

async function pullOrders(ctx: ConnectorContext, since: string | null): Promise<SyncResult> {
  const creds = decodeCredentials(ctx.credentialsRef);
  let cursor: string | null = null;
  let fetched = 0;
  const seenCursors = new Set<string>();

  for (let page = 0; page < 200; page += 1) {
    const url = new URL(`${API_HOST}/v1/order/list`);
    url.searchParams.set("mid", creds.merchantId);
    url.searchParams.set("limit", "100");
    if (since) url.searchParams.set("updated_after", since);
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, { headers: authHeaders(creds) });
    if (!res.ok) throw new Error(`gokwik orders request failed: HTTP ${res.status}`);
    const body = (await res.json()) as GokwikOrdersResponse & GokwikEnvelope<unknown>;
    // Throws on an in-body error rather than quietly treating it as "no orders".
    unwrapEnvelope(body, "order/list");
    // `data` is the order array on success and an empty OBJECT on failure, so
    // the array check is load-bearing, not defensive noise.
    const orders = (Array.isArray(body.data) ? body.data : body.orders) ?? [];
    if (orders.length === 0) break;

    for (const o of orders) {
      const ref = o.moid ?? o.merchant_order_id;
      if (!ref) continue;
      const paymentMode = paymentModeOf(o);
      // A payload that states no payment mode has nothing to teach us. Writing
      // `undefined` would be a no-op update; skipping keeps `fetched` honest.
      if (!paymentMode) continue;
      // GoKwik does not own the order — Shopify does. So this enriches the
      // order we already hold rather than creating one; creating orders from
      // two sources is how the same sale gets counted twice.
      const updated = await prisma.order.updateMany({
        where: { organizationId: ctx.organizationId, orderNumber: { in: orderNumberCandidates(ref) } },
        data: { paymentMode },
      });
      if (updated.count > 0) fetched += 1;
    }

    const next = body.next_cursor ?? null;
    // A provider that returns the same cursor forever is a provider that would
    // spin this loop until the job times out.
    if (!next || seenCursors.has(next) || body.has_more === false) break;
    seenCursors.add(next);
    cursor = next;
    await ctx.reportProgress?.(fetched, null);
  }

  return { recordsFetched: fetched, cursor: new Date().toISOString() };
}

// GoKwik's settlement report. NOT a COD-only document.
//
// This was originally modelled as COD-only, which was wrong. GoKwik runs the
// ENTIRE checkout: a customer paying by card or UPI pays GoKwik too, so a
// single payout mixes prepaid captures with COD cash collected on delivery.
// Treating every row as COD would have matched prepaid card payments against
// shipments — attributing real money to the wrong ledger and leaving the
// PAYMENT_SETTLEMENT leg permanently empty while the COD leg silently
// over-counted.
//
// So the line type is resolved PER ROW from the report's own payment-mode
// column. A row whose mode we cannot read is refused, not defaulted: guessing
// between "this is a card capture" and "this is cash from a parcel" is exactly
// the kind of confident wrongness this importer exists to prevent.
//
// `lineType` below is only the fallback for a file that carries no mode column
// at all (a COD-only export), which is why it stays SHIPMENT_COD.
export const GOKWIK_SETTLEMENT_STATEMENT: StatementFormat = {
  provider: "GOKWIK",
  lineType: "SHIPMENT_COD",
  kind: "COD_REMITTANCE",
  label: "GoKwik settlement report (prepaid + COD)",
  // Priority order, and it matters: "Payment Mode" is the most specific but is
  // blank on many real rows, so "Transaction Type" backs it up.
  lineTypeColumn: [
    "Payment Mode", "PaymentMode", "Order Type", "OrderType", "Mode",
    "Transaction Type", "TransactionType", "Payment Method", "Type",
  ],
  // The GoKwik-prefixed spellings below are the REAL ones observed on the live
  // store's Shopify orders (`payment_gateway_names`), not guesses: "Gokwik UPI",
  // "Gokwik Cards", "Gokwik Snapmint", "Gokwik PPCOD".
  lineTypeMap: {
    // Transaction Type vocabulary, observed in the real export.
    payment: "PAYMENT",
    sale: "PAYMENT",
    capture: "PAYMENT",
    "cod remittance": "SHIPMENT_COD",
    "cod collection": "SHIPMENT_COD",
    cod: "SHIPMENT_COD",
    "cash on delivery": "SHIPMENT_COD",
    "cash on delivery (cod)": "SHIPMENT_COD",
    cash_on_delivery: "SHIPMENT_COD",
    cashondelivery: "SHIPMENT_COD",
    "gokwik cod": "SHIPMENT_COD",
    prepaid: "PAYMENT",
    prepaid_order: "PAYMENT",
    online: "PAYMENT",
    upi: "PAYMENT",
    card: "PAYMENT",
    "card | credit": "PAYMENT",
    netbanking: "PAYMENT",
    wallet: "PAYMENT",
    "gokwik upi": "PAYMENT",
    "gokwik cards": "PAYMENT",
    // Snapmint is BNPL/consumer finance. The lender pays the merchant up front,
    // so from the settlement's point of view it behaves as a prepaid capture.
    snapmint: "PAYMENT",
    "gokwik snapmint": "PAYMENT",
    "consumer_finance-snapmint": "PAYMENT",
    //
    // DELIBERATELY NOT MAPPED: "gokwik ppcod" (partially prepaid COD), which is
    // 448 of the last 60 days' orders on the live store. A PPCOD order carries a
    // prepaid deposit AND cash collected on delivery, so a row labelled only
    // "PPCOD" cannot be assigned to either ledger from its mode alone — the two
    // halves settle at different times for different amounts. Left unmapped so
    // such rows are REFUSED and reported rather than silently filed as one or
    // the other. Resolve by looking at a real GoKwik settlement export: if the
    // two halves arrive as separate rows with distinguishable modes, map those
    // spellings instead; if one row carries both, this needs a split, not a map.
    // Money in the payout with no order behind it — GoKwik's own commission
    // line, TDS, a chargeback. Modelled rather than dropped so the batch still
    // balances; see SettlementLineType.ADJUSTMENT.
    adjustment: "ADJUSTMENT",
    fee: "ADJUSTMENT",
    commission: "ADJUSTMENT",
    tds: "ADJUSTMENT",
    chargeback: "ADJUSTMENT",
    refund: "ADJUSTMENT",
  },
  columns: {
    // GoKwik's real export is a TRANSACTION LEDGER, not a payout summary: one
    // row per payment, with the payout identified only by "Settlement UTR".
    // That UTR is therefore the batch id — there is no separate settlement id,
    // and grouping by it is what turns a flat ledger back into payouts.
    batchId: ["Settlement UTR", "Settlement Id", "SettlementId", "Payout Id", "UTR", "Batch Id"],
    utr: ["Settlement UTR", "UTR", "UTR No", "Bank Reference", "Transaction Reference"],
    paidOn: ["Settlement Date", "Payout Date", "Credit Date", "Settled On"],
    // One reference column serves both row kinds, because GoKwik identifies
    // everything by the merchant's order: a COD row resolves order → shipment,
    // a prepaid row resolves order → payment. Payment-id spellings are listed
    // first so a report that DOES state the gateway's id uses it directly
    // rather than going through the order.
    // "Merchant Order Id" FIRST: it is the merchant's own order number, which
    // is what resolves against Order.orderNumber here. GoKwik's "Payment Id" is
    // its internal id and matches nothing we hold unless GoKwik is also the
    // gateway of record.
    reference: [
      "Merchant Order Id", "Order Id", "OrderId", "Order Number", "Platform Order Id",
      "Payment Id", "PaymentId", "Transaction Id", "TransactionId", "Shopify Transaction Id",
      "AWB", "AWB No", "Waybill", "Shipment Id",
    ],
    gross: ["Amount", "Order Amount", "COD Amount", "Collected Amount", "Gross Amount", "Transaction Amount"],
    // Five separate deduction columns in the real export. Summed, not picked —
    // see StatementColumnMap.feeParts.
    feeParts: ["Tax", "Fee", "Additional Fees", "Additional Tax", "gokwik Deduction"],
    fee: ["Commission", "GoKwik Fee", "Charges", "Deduction", "Fee"],
    net: ["Credit", "Settled Amount", "Net Amount", "Remitted Amount"],
    // Refunds/chargebacks land here rather than in Credit — see StatementColumnMap.debit.
    debit: ["Debit"],
    batchTotal: ["Total Settlement", "Payout Amount", "Batch Total"],
  },
};

export async function ingestSettlementReport(ctx: ConnectorContext, csv: string): Promise<IngestResult> {
  return ingestStatement(
    { connectionId: ctx.connectionId, organizationId: ctx.organizationId, legalEntityId: ctx.legalEntityId },
    csv,
    GOKWIK_SETTLEMENT_STATEMENT
  );
}

export const gokwikConnector: Connector = {
  provider: "GOKWIK",

  async backfill(ctx: ConnectorContext): Promise<SyncResult> {
    return pullOrders(ctx, null);
  },

  async sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult> {
    return pullOrders(ctx, sinceCursor);
  },

  // GoKwik signs webhooks with an HMAC of the raw body under the app secret.
  // The secret is not available here (verifyWebhook is called before the
  // connection is resolved, same as every other connector in this repo), so the
  // route layer performs the comparison; this derives the idempotency key.
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): WebhookVerificationResult {
    const provided = headers["x-gokwik-signature"] ?? headers["x-signature"] ?? "";
    const digest = crypto.createHash("sha256").update(rawBody).digest("hex");
    let eventType = "order.updated";
    try {
      const parsed = JSON.parse(rawBody.toString("utf8")) as { event?: string; type?: string };
      eventType = parsed.event ?? parsed.type ?? eventType;
    } catch {
      // Unparseable bodies are still stored — §112.
    }
    return { valid: true, externalEventId: provided || digest, eventType };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown): Promise<void> {
    const order = payload as GokwikOrder;
    const ref = order.moid ?? order.merchant_order_id;
    if (!ref) return;
    const paymentMode = paymentModeOf(order);
    if (!paymentMode) return;
    await prisma.order.updateMany({
      where: { organizationId: ctx.organizationId, orderNumber: { in: orderNumberCandidates(ref) } },
      data: { paymentMode },
    });
  },
};
