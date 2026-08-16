import crypto from "node:crypto";
import { env } from "../../../config/env.js";
import { decryptSecret } from "../../../lib/crypto.js";
import { invalidateOrgReads } from "../../../lib/orgReadCache.js";
import { prisma } from "../../../lib/prisma.js";
import { rupeesToPaise } from "../../calc/money.js";
import { toConnectorContext, type Connector, type ConnectorContext, type SyncResult, type WebhookVerificationResult } from "../types.js";

// Setu Account Aggregator (AA) is a sixth shape, and structurally the most
// different one yet — India's RBI-regulated AA framework for consent-based
// financial data sharing, not a normal bank API:
//  - Connecting isn't OAuth. It's a *consent request*: we ask Setu to create
//    a consent object, the founder approves it in their own AA app (Setu
//    hosts the approval screen, not us), and only once that flips ACTIVE can
//    we ask for any data at all.
//  - Fetching data isn't a single GET either. It's a second async step:
//    create a "data session" against the ACTIVE consent, wait for Setu to
//    notify us the bank (FIP) has responded (PARTIAL/COMPLETED), *then*
//    fetch the session contents. Nothing is fetched synchronously anywhere
//    in this file — see routes/webhooks/setu.ts for where data actually
//    lands.
//  - Auth to Setu's FIU API is three static request headers (x-client-id,
//    x-client-secret, x-product-instance-id), not a Bearer token exchange —
//    confirmed against Setu's own docs before writing this, since Setu's
//    *other* products (BBPS, UPI) do use OAuth and it would have been an
//    easy wrong guess to copy that here.
//  - The consent-status and FI-data-ready webhooks Setu sends carry no
//    documented signature scheme (same gap as Delhivery), but unlike
//    Delhivery's per-connection URL trick, Setu's notification URL is
//    registered once, globally, on their Bridge console — so a per-connection
//    unguessable path isn't available here. See routes/webhooks/setu.ts for
//    the shared-secret workaround this uses instead.
//
// This is a *second path* to bank data, not a replacement for the CSV
// connector (modules/connectors/bank) — Setu's AA network needs the
// founder's specific bank to be a live participant (most major Indian
// retail banks are, as of 2026, but not all) and needs the founder to
// approve a consent in an AA app they may never have used before. CSV
// upload stays as the fallback for whichever of those doesn't hold.

const DATA_RANGE_BACKFILL_MONTHS = 12;
const CONSENT_DURATION_MONTHS = 12; // how long the consent itself stays valid, separate from any one data session's range

export interface SetuCredentials {
  consentId: string;
  vua: string; // mobile number (or mobile@handle) the consent was requested against
}

export function encodeCredentials(creds: SetuCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): SetuCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as SetuCredentials;
}

function requireConfig(): { clientId: string; clientSecret: string; productInstanceId: string } {
  if (!env.SETU_CLIENT_ID || !env.SETU_CLIENT_SECRET || !env.SETU_PRODUCT_INSTANCE_ID) {
    throw new Error("setu_not_configured");
  }
  return {
    clientId: env.SETU_CLIENT_ID,
    clientSecret: env.SETU_CLIENT_SECRET,
    productInstanceId: env.SETU_PRODUCT_INSTANCE_ID,
  };
}

function requestHeaders(): Record<string, string> {
  const { clientId, clientSecret, productInstanceId } = requireConfig();
  return {
    "Content-Type": "application/json",
    "x-client-id": clientId,
    "x-client-secret": clientSecret,
    "x-product-instance-id": productInstanceId,
  };
}

export interface ConsentResult {
  id: string;
  status: string;
  url: string;
}

// Kicks off the consent flow — the founder still has to approve it at `url`
// before any data can be requested. `dataRangeFrom` bounds how far back this
// consent is even allowed to be used for later (the AA framework fixes this
// at consent-creation time, not per data session).
export async function createConsent(vua: string, dataRangeFrom: Date, redirectUrl: string): Promise<ConsentResult> {
  const now = new Date();
  const res = await fetch(`${env.SETU_BASE_URL}/consents`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      consentDuration: { unit: "MONTH", value: String(CONSENT_DURATION_MONTHS) },
      vua,
      dataRange: { from: dataRangeFrom.toISOString(), to: now.toISOString() },
      redirectUrl,
      context: [{ key: "purpose", value: "CFOOS cash position and bank reconciliation" }],
    }),
  });
  if (!res.ok) throw new Error(`setu_create_consent_failed_${res.status}`);
  return (await res.json()) as ConsentResult;
}

// Live poll against Setu, used as a fallback when the consent-notification
// webhook hasn't arrived yet (e.g. local/sandbox dev with no public URL for
// Setu to reach) — see routes/connections/setu.ts's GET /:connectionId/status.
export async function getConsentStatus(consentId: string): Promise<{ id: string; status: string }> {
  const res = await fetch(`${env.SETU_BASE_URL}/consents/${consentId}`, { headers: requestHeaders() });
  if (!res.ok) throw new Error(`setu_get_consent_failed_${res.status}`);
  return (await res.json()) as { id: string; status: string };
}

export interface DataSessionResult {
  id: string;
  status: string;
}

export async function createDataSession(consentId: string, from: Date, to: Date): Promise<DataSessionResult> {
  const res = await fetch(`${env.SETU_BASE_URL}/sessions`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      consentId,
      dataRange: { from: from.toISOString(), to: to.toISOString() },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`setu_create_data_session_failed_${res.status}`);
  return (await res.json()) as DataSessionResult;
}

// --- FI data shape -------------------------------------------------------
// Corrected against Setu's own "Fetch FI data" documentation
// (docs.setu.co/data/account-aggregator/api-integration/data-apis). The
// previous version of this file assumed a flat `data: FiAccountData[]` at the
// top level with ReBIT's PascalCase `Transactions.Transaction` inside. That
// was wrong on both counts: the real response nests accounts two levels
// deeper, under `fips[].accounts[].data.account`. Because `response.data` did
// not exist, the webhook's `for (const account of fiData.data ?? [])` loop
// iterated zero times — this connector would have silently ingested nothing,
// with no error anywhere, which is exactly the failure mode that survives a
// typecheck and a boot test.
//
// Still not verified against a live sandbox payload: Setu's docs give the
// container nesting but not the exact casing of the innermost transaction
// array or balance field, and AAs vary in how they normalise ReBIT's XML into
// JSON. Everything below is therefore read *tolerantly* — both PascalCase
// (ReBIT XML style) and camelCase (Setu JSON style), and both a wrapped
// `{ transaction: [...] }` object and a bare array — rather than betting on
// one spelling. The full payload is always stored on BankTransaction.raw, so
// a real response can correct this without data loss.

interface FiTransaction {
  txnId?: string;
  amount?: string | number;
  type?: "CREDIT" | "DEBIT" | string;
  transactionTimestamp?: string;
  valueDate?: string;
  narration?: string;
  reference?: string;
}

interface FiAccountSummary {
  currentBalance?: string | number;
  balanceDateTime?: string;
  type?: string;
  branch?: string;
}

// One account's worth of FI data, already flattened out of the fips/accounts
// nesting by extractAccounts() below.
export interface FlatFiAccount {
  fipId: string | null;
  linkRefNumber: string | null;
  maskedAccNumber: string | null;
  summary: FiAccountSummary | null;
  transactions: FiTransaction[];
}

export interface SetuFiDataResponse {
  id: string;
  status: string;
  format?: string;
  consentId?: string;
  fips?: {
    fipID?: string;
    accounts?: {
      linkRefNumber?: string;
      maskedAccNumber?: string;
      status?: string;
      data?: { account?: Record<string, unknown> };
    }[];
  }[];
}

// Case-insensitive property read — Setu normalises ReBIT's XML into JSON and
// the docs don't pin down whether the inner keys keep ReBIT's PascalCase.
function pick<T>(obj: Record<string, unknown> | null | undefined, ...names: string[]): T | undefined {
  if (!obj) return undefined;
  for (const name of names) {
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === name.toLowerCase()) return obj[key] as T;
    }
  }
  return undefined;
}

// Accepts `{ transaction: [...] }`, `{ Transaction: [...] }`, a bare array, or
// a single object, and always returns a list.
function toTransactionList(node: unknown): FiTransaction[] {
  if (!node) return [];
  if (Array.isArray(node)) return node as FiTransaction[];
  const inner = pick<unknown>(node as Record<string, unknown>, "transaction");
  if (Array.isArray(inner)) return inner as FiTransaction[];
  if (inner && typeof inner === "object") return [inner as FiTransaction];
  return [];
}

// Walks fips[] -> accounts[] -> data.account and flattens to one entry per
// bank account. Exported so routes/webhooks/setu.ts iterates the real shape.
export function extractAccounts(response: SetuFiDataResponse): FlatFiAccount[] {
  const out: FlatFiAccount[] = [];
  for (const fip of response.fips ?? []) {
    for (const acc of fip.accounts ?? []) {
      const account = acc.data?.account ?? {};
      out.push({
        fipId: fip.fipID ?? null,
        linkRefNumber: acc.linkRefNumber ?? null,
        maskedAccNumber: acc.maskedAccNumber ?? null,
        summary: pick<FiAccountSummary>(account, "summary") ?? null,
        transactions: toTransactionList(pick<unknown>(account, "transactions")),
      });
    }
  }
  return out;
}

export async function fetchDataSession(sessionId: string): Promise<SetuFiDataResponse> {
  const res = await fetch(`${env.SETU_BASE_URL}/sessions/${sessionId}`, { headers: requestHeaders() });
  if (!res.ok) throw new Error(`setu_fetch_data_session_failed_${res.status}`);
  return (await res.json()) as SetuFiDataResponse;
}

async function requestDataSession(ctx: ConnectorContext, from: Date, to: Date): Promise<SyncResult> {
  const creds = decodeCredentials(ctx.credentialsRef);
  const session = await createDataSession(creds.consentId, from, to);
  await prisma.bankAaDataSession.create({
    data: { id: session.id, connectionId: ctx.connectionId, status: session.status },
  });
  // Nothing fetched yet — the actual transactions land later via the
  // FI-data-ready webhook (see routes/webhooks/setu.ts), same async shape
  // for both backfill and sync.
  return { recordsFetched: 0, cursor: to.toISOString() };
}

// Shared by routes/webhooks/setu.ts (the primary path, when Setu's
// consent-notification arrives) and routes/connections/setu.ts's status-poll
// fallback (for local/sandbox dev where Setu can't reach our webhook URL at
// all). Idempotent against double-calling — skips the backfill if the
// connection is already ACTIVE, since either path could get there first.
export async function activateConsentConnection(connection: {
  id: string;
  organizationId: string;
  legalEntityId: string;
  credentialsRef: string;
  externalAccountId: string | null;
  status: string;
}): Promise<void> {
  if (connection.status === "ACTIVE") return;
  await prisma.connection.update({ where: { id: connection.id }, data: { status: "ACTIVE" } });
  await setuConnector.backfill(toConnectorContext(connection));
}

// The AA summary block carries each account's real current balance, which is
// strictly better than what the CSV bank connector can do — there, a founder
// has to look up a balance and type it in, and until they do,
// getAvailableCashSummary() excludes the account entirely (see
// modules/calc/cash.ts). Here we get an authoritative balance with the
// timestamp it was true as of, so the opening-balance anchor can be set
// automatically and refreshed on every sync.
//
// No double-counting: available cash = openingBalance + transactions dated
// *after* openingBalanceDate. Transactions before that date are already
// reflected in the balance itself and are correctly ignored, so ingesting 12
// months of history alongside a current balance is safe.
//
// One consent can cover several bank accounts, and every account's
// transactions land under this one connectionId — so the anchor is the *sum*
// of the per-account balances, matching the pooled transactions it will be
// added to. Accounts that report no balance are skipped rather than counted
// as zero, and if none report one the anchor is left untouched.
export async function syncOpeningBalanceFromSummaries(
  connectionId: string,
  accounts: FlatFiAccount[]
): Promise<{ updated: boolean; accountsWithBalance: number; totalMinor: string | null }> {
  let totalMinor = 0n;
  let accountsWithBalance = 0;
  let asOf: Date | null = null;

  for (const account of accounts) {
    const raw = account.summary?.currentBalance;
    if (raw == null || raw === "") continue;
    const balance = Number(raw);
    if (Number.isNaN(balance)) continue;
    totalMinor += rupeesToPaise(balance);
    accountsWithBalance++;

    const stamp = account.summary?.balanceDateTime ? new Date(account.summary.balanceDateTime) : null;
    if (stamp && !Number.isNaN(stamp.getTime()) && (asOf == null || stamp > asOf)) asOf = stamp;
  }

  if (accountsWithBalance === 0) return { updated: false, accountsWithBalance: 0, totalMinor: null };

  await prisma.connection.update({
    where: { id: connectionId },
    data: { openingBalanceMinor: totalMinor, openingBalanceDate: asOf ?? new Date() },
  });

  return { updated: true, accountsWithBalance, totalMinor: totalMinor.toString() };
}

// Fetches a data session and ingests whatever it contains. Shared by both
// paths that can discover a session is ready:
//   1. routes/webhooks/setu.ts — the FI-data notification (production path).
//   2. routes/connections/setu.ts's status poll — the only path that works in
//      local/sandbox dev, where Setu has no public URL to call back on.
// Without (2), a founder on localhost completes the consent, a data session
// is created, and then nothing ever fetches it — a successful-looking
// connection with permanently zero transactions and no error anywhere.
// Safe to call repeatedly: BankTransaction upserts are keyed on
// externalTxnId, so re-processing the same session is a no-op.
export async function processDataSession(
  dataSessionId: string
): Promise<{ processed: boolean; status: string; accounts: number; transactions: number }> {
  const session = await prisma.bankAaDataSession.findUnique({ where: { id: dataSessionId } });
  if (!session) return { processed: false, status: "unknown_session", accounts: 0, transactions: 0 };

  const fiData = await fetchDataSession(dataSessionId);
  // The fetched response's own status is more authoritative than whatever a
  // notification claimed, so it wins.
  await prisma.bankAaDataSession.update({ where: { id: dataSessionId }, data: { status: fiData.status } });

  if (fiData.status !== "COMPLETED" && fiData.status !== "PARTIAL") {
    return { processed: false, status: fiData.status, accounts: 0, transactions: 0 };
  }

  const connection = await prisma.connection.findUnique({ where: { id: session.connectionId } });
  if (!connection) return { processed: false, status: fiData.status, accounts: 0, transactions: 0 };

  const ctx = toConnectorContext(connection);
  const accounts = extractAccounts(fiData);
  let transactions = 0;
  for (const account of accounts) {
    transactions += account.transactions.length;
    await setuConnector.processEvent(ctx, account, "fi_data.session_update");
  }

  await syncOpeningBalanceFromSummaries(connection.id, accounts);
  await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
  // Bank rows just landed — the cached cash/status reads must reflect them.
  invalidateOrgReads(connection.organizationId);

  return { processed: true, status: fiData.status, accounts: accounts.length, transactions };
}

// Drives processDataSession() for every session belonging to a connection
// that hasn't reached a terminal state yet — what the status poll calls so
// local/sandbox dev can make progress without any webhook delivery.
export async function pollPendingDataSessions(
  connectionId: string
): Promise<{ accounts: number; transactions: number }> {
  const pending = await prisma.bankAaDataSession.findMany({
    where: { connectionId, status: { notIn: ["COMPLETED", "FAILED", "EXPIRED"] } },
    select: { id: true },
  });

  let accounts = 0;
  let transactions = 0;
  for (const { id } of pending) {
    const result = await processDataSession(id);
    accounts += result.accounts;
    transactions += result.transactions;
  }
  return { accounts, transactions };
}

export const setuConnector: Connector = {
  provider: "BANK_AA",

  // Called once the consent flips ACTIVE (see routes/webhooks/setu.ts) —
  // requests the first data session covering the backfill window.
  async backfill(ctx: ConnectorContext): Promise<SyncResult> {
    const now = new Date();
    const from = new Date(now.getTime() - DATA_RANGE_BACKFILL_MONTHS * 30 * 24 * 60 * 60 * 1000);
    return requestDataSession(ctx, from, now);
  },

  // Manual re-sync trigger (POST /connections/:id/sync) — requests another
  // data session covering since the last sync's cursor.
  async sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult> {
    const now = new Date();
    const from = sinceCursor
      ? new Date(sinceCursor)
      : new Date(now.getTime() - DATA_RANGE_BACKFILL_MONTHS * 30 * 24 * 60 * 60 * 1000);
    return requestDataSession(ctx, from, now);
  },

  // No documented signature scheme — real verification happens in the route
  // via a shared secret, same gap as Delhivery but platform-wide instead of
  // per-connection (see routes/webhooks/setu.ts).
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  // payload is one FlatFiAccount (one bank account's worth of FI data), as
  // produced by extractAccounts() — routes/webhooks/setu.ts calls this once
  // per account in a fetched session, not once for the whole session.
  async processEvent(ctx: ConnectorContext, payload: unknown, _eventType: string): Promise<void> {
    const account = payload as FlatFiAccount;
    const transactions = account.transactions ?? [];

    for (const txn of transactions) {
      const amountRupees = Number(txn.amount ?? "");
      if (txn.amount == null || txn.amount === "" || Number.isNaN(amountRupees)) continue; // skip unparseable rows rather than guess
      const valueDate = txn.valueDate ?? txn.transactionTimestamp?.slice(0, 10);
      if (!valueDate) continue;
      // Setu's docs confirm CREDIT/DEBIT as the transaction type values;
      // anything unexpected defaults to CREDIT rather than silently
      // dropping the row.
      const direction: "CREDIT" | "DEBIT" = txn.type === "DEBIT" ? "DEBIT" : "CREDIT";
      // txnId isn't guaranteed present/unique across every FIP — fall back
      // to a hash of the fields that do identify a row, same idempotency
      // pattern as the CSV bank connector's ingestStatement().
      const externalTxnId =
        txn.txnId ??
        crypto
          .createHash("sha256")
          .update(`${account.linkRefNumber ?? ""}|${valueDate}|${String(txn.amount)}|${direction}|${txn.narration ?? ""}`)
          .digest("hex");

      await prisma.bankTransaction.upsert({
        where: { connectionId_externalTxnId: { connectionId: ctx.connectionId, externalTxnId } },
        create: {
          organizationId: ctx.organizationId,
          legalEntityId: ctx.legalEntityId,
          connectionId: ctx.connectionId,
          externalTxnId,
          amount: rupeesToPaise(amountRupees),
          direction,
          valueDate: new Date(valueDate),
          description: txn.narration ?? txn.reference ?? null,
          raw: txn as unknown as object,
        },
        update: {}, // bank transactions are treated as immutable once ingested, same rule as the CSV connector
      });
    }
  },
};
