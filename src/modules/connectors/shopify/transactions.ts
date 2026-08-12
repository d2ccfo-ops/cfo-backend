import crypto from "node:crypto";
import readline from "node:readline";
import { Readable } from "node:stream";
import { Prisma } from "@prisma/client";
import { decryptSecret } from "../../../lib/crypto.js";
import { logger } from "../../../lib/logger.js";
import { prisma } from "../../../lib/prisma.js";
import type { ConnectorContext } from "../types.js";

// Order-level transactions → Payment rows, via a GraphQL BULK operation.
//
// Why this exists: this store's prepaid flow runs through GoKwik (plus UPI,
// cards, Snapmint, a trickle of Razorpay) — gateways with no connector and no
// public API to build one against. But Shopify itself records a transaction
// for every payment on every gateway, attached to the order by construction.
// Pulling those gives the reconciliation engine an ORDER_PAYMENT leg that
// covers every prepaid order with a REAL key (the order FK), no
// amount-and-date guessing, and no new credentials.
//
// Why BULK and not REST: transactions are only exposed per order over REST —
// 24,863 orders × 1 call at 2 req/s is ~3.5 hours per connection. One bulk
// operation exports every order's transactions as a single JSONL file in
// minutes, and the same query with an `updated_at` filter is cheap enough to
// run inside every incremental sync.
//
// What deliberately does NOT become a Payment row:
//  - kinds other than SALE/CAPTURE. AUTHORIZATION holds money without moving
//    it, VOID cancels an authorisation, REFUND is money OUT and already lives
//    on Order.refundedAmount (§13/§14) — importing it here would double-count
//    the reversal.
//  - non-SUCCESS statuses (a pending UPI attempt is not money) — though the
//    upsert means a transaction that later succeeds is captured on the next
//    pull.
//  - test transactions.

const API_VERSION = "2024-10";
const POLL_INTERVAL_MS = 2_000;
const BUSY_WAIT_BUDGET_MS = 60_000;

// Shopify updates an order's updated_at when a transaction lands on it, so an
// incremental orders pull already re-fetches orders with new payments. The
// lookback exists for the failure modes around that: a sync where the bulk
// slot was busy and the transactions step was skipped, or a payment captured
// against an order our cursor had already passed. Seven days of orders is a
// few thousand JSONL lines — idempotent and near-free.
const INCREMENTAL_LOOKBACK_DAYS = 7;

interface BulkMoneyBag {
  shopMoney?: { amount?: string; currencyCode?: string };
}

interface BulkTransaction {
  id: string; // gid://shopify/OrderTransaction/123
  kind?: string; // SALE | CAPTURE | AUTHORIZATION | VOID | REFUND | ...
  status?: string; // SUCCESS | FAILURE | PENDING | ERROR | ...
  gateway?: string | null;
  test?: boolean;
  processedAt?: string | null;
  paymentId?: string | null;
  amountSet?: BulkMoneyBag;
}

interface BulkOrderLine {
  id?: string; // gid://shopify/Order/123
  transactions?: BulkTransaction[];
}

function legacyId(gid: string | undefined): string | null {
  if (!gid) return null;
  const last = gid.split("/").pop();
  return last && last.length > 0 ? last : null;
}

function toPaise(amount: string | undefined): bigint {
  if (!amount) return 0n;
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 100));
}

async function graphql<T>(shop: string, accessToken: string, query: string): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Shopify GraphQL failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (!body.data) {
    throw new Error(`Shopify GraphQL returned errors: ${JSON.stringify(body.errors).slice(0, 500)}`);
  }
  return body.data;
}

interface CurrentBulkOperation {
  currentBulkOperation: {
    id: string;
    status: string; // CREATED | RUNNING | COMPLETED | FAILED | CANCELED | EXPIRED
    errorCode: string | null;
    objectCount: string;
    url: string | null;
  } | null;
}

async function getCurrentOperation(shop: string, accessToken: string) {
  const data = await graphql<CurrentBulkOperation>(
    shop,
    accessToken,
    `{ currentBulkOperation { id status errorCode objectCount url } }`
  );
  return data.currentBulkOperation;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TransactionsPullResult {
  paymentsUpserted: number;
  ordersSeen: number;
  /** True when another bulk operation held the shop's slot for the whole wait
   *  budget and this run gave up — the lookback covers it next sync. */
  skipped: boolean;
}

export async function pullOrderTransactions(
  ctx: ConnectorContext,
  updatedAtMin: string | null,
  { timeoutMs = 15 * 60 * 1000 }: { timeoutMs?: number } = {}
): Promise<TransactionsPullResult> {
  if (!ctx.externalAccountId) throw new Error("Shopify connector requires a shop domain (externalAccountId)");
  const accessToken = decryptSecret(ctx.credentialsRef);
  const shop = ctx.externalAccountId;

  // One bulk operation per app+shop at a time is Shopify's rule, and this
  // database has two connections to the SAME store (two orgs). If the slot
  // is held, wait a bounded while for the other run to finish; past the
  // budget, skip rather than fail the whole sync — the incremental lookback
  // re-covers the window on the next run, and `skipped` says so honestly.
  const busyDeadline = Date.now() + BUSY_WAIT_BUDGET_MS;
  for (;;) {
    const current = await getCurrentOperation(shop, accessToken);
    if (!current || !["CREATED", "RUNNING"].includes(current.status)) break;
    if (Date.now() > busyDeadline) {
      logger.warn({ shop, holder: current.id }, "shopify_bulk_slot_busy_transactions_skipped");
      return { paymentsUpserted: 0, ordersSeen: 0, skipped: true };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // updated_at (not created_at): a payment can land on an old order — COD
  // marked paid weeks later, a pending UPI succeeding — and the transaction
  // touches the order's updated_at.
  const sinceClause = updatedAtMin
    ? `(query: "updated_at:>='${new Date(new Date(updatedAtMin).getTime() - INCREMENTAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()}'")`
    : "";

  const bulkQuery = `
    mutation {
      bulkOperationRunQuery(
        query: """
        {
          orders${sinceClause} {
            edges {
              node {
                id
                transactions {
                  id
                  kind
                  status
                  gateway
                  test
                  processedAt
                  paymentId
                  amountSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
        """
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`;

  interface RunResult {
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }
  const run = await graphql<RunResult>(shop, accessToken, bulkQuery);
  const errors = run.bulkOperationRunQuery.userErrors;
  if (errors.length > 0) {
    throw new Error(`Shopify bulk operation rejected: ${errors.map((e) => e.message).join("; ")}`);
  }

  // Poll until the export finishes. Throwing on FAILED (rather than returning
  // 0) is deliberate: a sync that silently never delivers payments would look
  // green while reconciliation quietly decays.
  const deadline = Date.now() + timeoutMs;
  let url: string | null = null;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const current = await getCurrentOperation(shop, accessToken);
    if (!current) throw new Error("Shopify bulk operation disappeared while polling");
    if (current.status === "COMPLETED") {
      url = current.url;
      break;
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(current.status)) {
      throw new Error(`Shopify bulk operation ${current.status}: ${current.errorCode ?? "no error code"}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Shopify bulk operation timed out after ${timeoutMs}ms (status ${current.status})`);
    }
  }

  // url is null when the export matched zero objects — a legitimate empty
  // incremental window, not an error.
  if (!url) return { paymentsUpserted: 0, ordersSeen: 0, skipped: false };

  // Resolve our order ids once — payments carry a real FK, which is exactly
  // what makes the reconciliation match HIGH-confidence instead of guessed.
  const ourOrders = await prisma.order.findMany({
    where: { connectionId: ctx.connectionId },
    select: { id: true, externalOrderId: true },
  });
  const orderIdByExternal = new Map(ourOrders.map((o) => [o.externalOrderId, o.id]));

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Shopify bulk result download failed: ${res.status}`);
  }

  const lines = readline.createInterface({
    input: Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    crlfDelay: Infinity,
  });

  let ordersSeen = 0;
  let paymentsUpserted = 0;
  let unmatchedOrders = 0;
  let batch: Prisma.Sql[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await prisma.$executeRaw`
      INSERT INTO payments (id, "organizationId", "legalEntityId", "connectionId", "externalPaymentId", "orderId", amount, currency, method, status, "feeAmount", "capturedAt", raw, "createdAt")
      VALUES ${Prisma.join(batch)}
      ON CONFLICT ("connectionId", "externalPaymentId") DO UPDATE SET
        "orderId" = EXCLUDED."orderId",
        amount = EXCLUDED.amount,
        currency = EXCLUDED.currency,
        method = EXCLUDED.method,
        status = EXCLUDED.status,
        "capturedAt" = EXCLUDED."capturedAt",
        raw = EXCLUDED.raw
    `;
    paymentsUpserted += batch.length;
    batch = [];
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    const order = JSON.parse(line) as BulkOrderLine;
    const externalOrderId = legacyId(order.id);
    if (!externalOrderId) continue;
    ordersSeen += 1;

    const orderId = orderIdByExternal.get(externalOrderId) ?? null;
    if (!orderId) unmatchedOrders += 1;

    for (const t of order.transactions ?? []) {
      if (t.test) continue;
      if (t.kind !== "SALE" && t.kind !== "CAPTURE") continue;
      if (t.status !== "SUCCESS") continue;
      const amount = toPaise(t.amountSet?.shopMoney?.amount);
      if (amount <= 0n) continue;
      const externalPaymentId = legacyId(t.id);
      if (!externalPaymentId) continue;

      batch.push(
        Prisma.sql`(${crypto.randomUUID()}, ${ctx.organizationId}, ${ctx.legalEntityId}, ${ctx.connectionId}, ${externalPaymentId}, ${orderId}, ${amount}, ${t.amountSet?.shopMoney?.currencyCode ?? "INR"}, ${t.gateway ?? null}, ${"captured"}, ${null}, ${t.processedAt ? new Date(t.processedAt) : null}, ${JSON.stringify(t)}::jsonb, now())`
      );
      if (batch.length >= 500) await flush();
    }
  }
  await flush();

  if (unmatchedOrders > 0) {
    // Orders in the export that aren't in our DB yet — created between our
    // orders pull and this bulk export. Their payments carry a null orderId
    // until the next run's upsert fills it in.
    logger.warn({ shop, unmatchedOrders }, "shopify_transactions_orders_not_in_db_yet");
  }

  return { paymentsUpserted, ordersSeen, skipped: false };
}
