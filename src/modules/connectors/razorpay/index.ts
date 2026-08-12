import crypto from "node:crypto";
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
  return { recordsFetched: paymentsCount + settlementsCount, cursor: String(Math.floor(Date.now() / 1000)) };
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
          capturedAt: new Date(p.created_at * 1000),
          raw: payload as object,
        },
        update: {
          status: p.status,
          feeAmount: p.fee != null ? BigInt(p.fee) : null,
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
          utr: s.utr ?? null,
          status: s.status,
          settledAt: new Date(s.created_at * 1000),
          raw: payload as object,
        },
        update: {
          status: s.status,
          amount: BigInt(s.amount),
          feeAmount: BigInt(s.fees ?? 0),
          raw: payload as object,
        },
      });
    }
  },
};
