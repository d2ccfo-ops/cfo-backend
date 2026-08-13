import { env } from "../../../config/env.js";
import { decryptSecret } from "../../../lib/crypto.js";
import { logger } from "../../../lib/logger.js";
import { prisma } from "../../../lib/prisma.js";
import type { Connector, ConnectorContext, WebhookVerificationResult } from "../types.js";

// Zoho Books (accounting). Supplies the two things nothing else in CFOOS can:
// vendor bills for §57 accounts payable, and expenses for §74 operating costs —
// which together unblock upcoming payments, burn and eventually EBITDA.
//
// THE THING MOST LIKELY TO BE GOT WRONG: MULTI-DATACENTER
// -------------------------------------------------------
// Zoho is not one API host. An account lives in a specific datacenter — .in,
// .com, .eu, .com.au, .jp, .ca, .sa — and BOTH the accounts server (token
// exchange, refresh) and the API host differ per DC. Hardcoding
// accounts.zoho.com would fail for every Indian merchant, i.e. this product's
// entire target market.
//
// Two signals resolve it, and both are used:
//   1. The OAuth callback carries `location` (e.g. "in") and `accounts-server`
//      (e.g. "https://accounts.zoho.in"). The authorization code MUST be
//      exchanged against THAT server — a code issued in one DC is not valid at
//      another.
//   2. The token response carries `api_domain` (e.g. "https://www.zohoapis.in").
//      Every subsequent API call goes there.
// Both are persisted with the credential so refreshes keep working.

const DEFAULT_ACCOUNTS_SERVER = "https://accounts.zoho.com";
const DEFAULT_API_DOMAIN = "https://www.zohoapis.com";

// Read-only. `settings.READ` is needed for GET /organizations, which is how the
// organization_id required by every other call is discovered.
export const ZOHO_SCOPES = [
  "ZohoBooks.settings.READ",
  "ZohoBooks.bills.READ",
  "ZohoBooks.expenses.READ",
].join(",");

const PER_PAGE = 200; // Zoho's maximum
const MAX_PAGES_PER_RUN = 100;

export interface ZohoCredentials {
  refreshToken: string;
  accountsServer: string;
  apiDomain: string;
  zohoOrganizationId: string;
}

export function encodeCredentials(c: ZohoCredentials): string {
  return JSON.stringify(c);
}

function decodeCredentials(credentialsRef: string): ZohoCredentials {
  const parsed = JSON.parse(decryptSecret(credentialsRef)) as Partial<ZohoCredentials>;
  if (!parsed.refreshToken) throw new Error("zoho_credentials_missing_refresh_token");
  return {
    refreshToken: parsed.refreshToken,
    accountsServer: parsed.accountsServer || DEFAULT_ACCOUNTS_SERVER,
    apiDomain: parsed.apiDomain || DEFAULT_API_DOMAIN,
    zohoOrganizationId: parsed.zohoOrganizationId ?? "",
  };
}

// The `location` param Zoho puts on the callback maps to an accounts host.
// Falling back to .com rather than throwing: an unknown/absent location is far
// more likely to be a .com account than a fatal error.
const LOCATION_TO_ACCOUNTS: Record<string, string> = {
  us: "https://accounts.zoho.com",
  in: "https://accounts.zoho.in",
  eu: "https://accounts.zoho.eu",
  au: "https://accounts.zoho.com.au",
  jp: "https://accounts.zoho.jp",
  ca: "https://accounts.zohocloud.ca",
  sa: "https://accounts.zoho.sa",
  uk: "https://accounts.zoho.uk",
};

/**
 * Every accounts host Zoho actually operates. An ALLOWLIST, not a pattern.
 *
 * ---------------------------------------------------------------------------
 * THE SSRF THIS REPLACES
 * ---------------------------------------------------------------------------
 * This was `/^https:\/\/accounts\.zoho(cloud)?\.[a-z.]+$/`, and the character
 * class `[a-z.]+` contains a DOT — so it does not match a top-level domain, it
 * matches any remaining dotted string. `https://accounts.zoho.attacker.com`
 * passed it cleanly.
 *
 * `accounts-server` is a plain query parameter on an UNAUTHENTICATED callback
 * route, and the only gate before it, verifyOAuthState, is satisfied by any
 * state this server itself signed — which any user with an account can obtain
 * by starting the flow. So an attacker could send themselves to
 * /connections/zoho-books/callback?code=x&state=<their own valid state>
 * &accounts-server=https://accounts.zoho.attacker.com, and exchangeCodeForTokens
 * would POST client_id AND ZOHO_CLIENT_SECRET straight to that host.
 *
 * That is the application's Zoho app credential — not one user's token — so the
 * blast radius is every Zoho connection this deployment will ever make. A
 * pattern cannot express "a host Zoho runs"; only a list can.
 */
const ALLOWED_ACCOUNTS_SERVERS: ReadonlySet<string> = new Set(Object.values(LOCATION_TO_ACCOUNTS));

export function accountsServerFor(location?: string, accountsServerParam?: string): string {
  // Prefer what Zoho itself sent on the callback, but only if it is a host Zoho
  // actually runs. Anything else is discarded silently rather than throwing:
  // the datacenter map below resolves the overwhelming majority of real logins,
  // and a hard failure here would turn a probing attempt into a broken connect
  // flow for the legitimate user who happens to hit an edge case.
  if (accountsServerParam && ALLOWED_ACCOUNTS_SERVERS.has(accountsServerParam)) {
    return accountsServerParam;
  }
  return LOCATION_TO_ACCOUNTS[(location ?? "").toLowerCase()] ?? DEFAULT_ACCOUNTS_SERVER;
}

export function getAuthorizeUrl(state: string, redirectUri: string): string {
  const url = new URL(`${DEFAULT_ACCOUNTS_SERVER}/oauth/v2/auth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.ZOHO_CLIENT_ID ?? "");
  url.searchParams.set("scope", ZOHO_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  // Without access_type=offline Zoho returns only a one-hour access token and
  // NO refresh token — the connection would die an hour after being made.
  url.searchParams.set("access_type", "offline");
  // Zoho only issues a refresh token on the first consent unless re-prompted.
  // Without this, reconnecting an already-authorised app silently yields no
  // refresh token, which is a confusing failure to debug later.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  api_domain?: string;
  expires_in?: number;
  error?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  accountsServer: string
): Promise<{ refreshToken: string; accessToken: string; apiDomain: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.ZOHO_CLIENT_ID ?? "",
    client_secret: env.ZOHO_CLIENT_SECRET ?? "",
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetch(`${accountsServer}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as TokenResponse;

  // Zoho returns HTTP 200 with an `error` field for most failures, so status
  // alone is not a sufficient check.
  if (!res.ok || json.error) {
    throw new Error(`zoho_token_exchange_failed: ${json.error ?? res.status}`);
  }
  if (!json.refresh_token) {
    throw new Error(
      "zoho_no_refresh_token — the app was likely already authorised; prompt=consent should force a new one"
    );
  }
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token ?? "",
    // api_domain is STORED in the connection's credentials and then used to
    // build every subsequent Books API URL, so a bad value is durable, not
    // per-request. With the accounts server allowlisted above this response can
    // only come from Zoho, which makes this defence in depth rather than a
    // second hole — but a field that decides where an access token gets sent
    // for the life of a connection is worth checking even when its source is
    // trusted.
    apiDomain: isZohoApiDomain(json.api_domain) ? json.api_domain! : DEFAULT_API_DOMAIN,
  };
}

/** A host Zoho serves the Books API from. Same allowlist discipline as accountsServerFor. */
export function isZohoApiDomain(value: string | undefined | null): boolean {
  if (!value) return false;
  let host: string;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    host = url.host.toLowerCase();
  } catch {
    return false;
  }
  // Exact hosts, or a subdomain of a Zoho-owned API domain. Written as a
  // suffix check against a leading dot so "zohoapis.com.evil.net" cannot pass.
  const roots = ["zohoapis.com", "zohoapis.in", "zohoapis.eu", "zohoapis.com.au", "zohoapis.jp", "zohoapis.ca", "zohoapis.sa", "zohoapis.uk", "zohocloud.ca"];
  return roots.some((r) => host === r || host.endsWith(`.${r}`));
}

// Access tokens last one hour, so this runs on every sync rather than being
// cached — a sync is far rarer than hourly and caching would add a staleness
// bug for no benefit.
export async function getAccessToken(c: ZohoCredentials): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID ?? "",
    client_secret: env.ZOHO_CLIENT_SECRET ?? "",
    refresh_token: c.refreshToken,
  });
  const res = await fetch(`${c.accountsServer}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`zoho_token_refresh_failed: ${json.error ?? res.status}`);
  }
  return json.access_token;
}

interface ZohoOrganization {
  organization_id: string;
  name: string;
  currency_code?: string;
  country?: string;
}

export async function listOrganizations(
  accessToken: string,
  apiDomain: string
): Promise<ZohoOrganization[]> {
  const res = await fetch(`${apiDomain}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`zoho_organizations_failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { organizations?: ZohoOrganization[] };
  return json.organizations ?? [];
}

interface PageContext {
  has_more_page?: boolean;
}

// Zoho is offset-paginated (`page` 1-indexed + `per_page`), with
// `page_context.has_more_page` as the continuation signal. There is no cursor
// option, so this walks pages and stops on has_more_page — with a page cap so a
// malformed response can't spin forever.
async function fetchAllPages<T>(
  apiDomain: string,
  accessToken: string,
  path: string,
  organizationId: string,
  listKey: string,
  extraParams: Record<string, string> = {}
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES_PER_RUN; page += 1) {
    const url = new URL(`${apiDomain}/books/v3/${path}`);
    url.searchParams.set("organization_id", organizationId);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(PER_PAGE));
    for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);

    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`zoho_${path}_failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as Record<string, unknown> & { page_context?: PageContext };
    const rows = (json[listKey] as T[] | undefined) ?? [];
    out.push(...rows);
    if (!json.page_context?.has_more_page) break;
  }
  return out;
}

// Zoho returns money as a JSON number in the organisation's currency (e.g.
// 1234.56), so it must be converted to minor units before storage — no float
// ever reaches the database. Not named rupeesToPaise on purpose: a Zoho org may
// well be USD-billed, which is why `currency` is stored on every row.
function toMinorUnits(value: unknown): bigint {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 100));
}

function parseZohoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const d = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface ZohoBill {
  bill_id: string;
  bill_number?: string;
  vendor_id?: string;
  vendor_name?: string;
  date?: string;
  due_date?: string;
  total?: number;
  balance?: number;
  status?: string;
  currency_code?: string;
}

interface ZohoExpense {
  expense_id: string;
  date?: string;
  account_name?: string;
  vendor_name?: string;
  description?: string;
  total?: number;
  tax_amount?: number;
  currency_code?: string;
  status?: string;
}

async function ingestBills(ctx: ConnectorContext, c: ZohoCredentials, accessToken: string) {
  const bills = await fetchAllPages<ZohoBill>(
    c.apiDomain,
    accessToken,
    "bills",
    c.zohoOrganizationId,
    "bills",
    { sort_column: "date", sort_order: "D" }
  );

  let written = 0;
  for (const bill of bills) {
    const billDate = parseZohoDate(bill.date);
    // A bill with no date can't be aged (§51/§57) and would land in whatever
    // bucket `new Date()` happens to produce — skipped and logged instead.
    if (!billDate) {
      logger.warn({ billId: bill.bill_id }, "zoho_bill_missing_date_skipped");
      continue;
    }
    const data = {
      organizationId: ctx.organizationId,
      legalEntityId: ctx.legalEntityId,
      connectionId: ctx.connectionId,
      externalBillId: String(bill.bill_id),
      billNumber: bill.bill_number ?? String(bill.bill_id),
      vendorName: bill.vendor_name ?? "Unknown vendor",
      vendorRef: bill.vendor_id ?? null,
      billDate,
      dueDate: parseZohoDate(bill.due_date),
      totalAmount: toMinorUnits(bill.total),
      balanceAmount: toMinorUnits(bill.balance),
      currency: bill.currency_code ?? "INR",
      status: (bill.status ?? "unknown").toLowerCase(),
      raw: bill as object,
    };
    await prisma.vendorBill.upsert({
      where: {
        connectionId_externalBillId: {
          connectionId: ctx.connectionId,
          externalBillId: data.externalBillId,
        },
      },
      create: data,
      // A bill being paid down is an UPDATE to the same bill, so balance and
      // status must be in the update branch or a paid bill stays outstanding
      // forever.
      update: {
        billNumber: data.billNumber,
        vendorName: data.vendorName,
        dueDate: data.dueDate,
        totalAmount: data.totalAmount,
        balanceAmount: data.balanceAmount,
        status: data.status,
        currency: data.currency,
        raw: data.raw,
      },
    });
    written += 1;
  }
  return written;
}

async function ingestExpenses(ctx: ConnectorContext, c: ZohoCredentials, accessToken: string) {
  const expenses = await fetchAllPages<ZohoExpense>(
    c.apiDomain,
    accessToken,
    "expenses",
    c.zohoOrganizationId,
    "expenses",
    { sort_column: "date", sort_order: "D" }
  );

  let written = 0;
  for (const expense of expenses) {
    const expenseDate = parseZohoDate(expense.date);
    if (!expenseDate) {
      logger.warn({ expenseId: expense.expense_id }, "zoho_expense_missing_date_skipped");
      continue;
    }
    const data = {
      organizationId: ctx.organizationId,
      legalEntityId: ctx.legalEntityId,
      connectionId: ctx.connectionId,
      externalExpenseId: String(expense.expense_id),
      expenseDate,
      accountName: expense.account_name ?? "Uncategorised",
      vendorName: expense.vendor_name ?? null,
      description: expense.description ?? null,
      amount: toMinorUnits(expense.total),
      taxAmount: toMinorUnits(expense.tax_amount),
      currency: expense.currency_code ?? "INR",
      status: expense.status ?? null,
      raw: expense as object,
    };
    await prisma.expense.upsert({
      where: {
        connectionId_externalExpenseId: {
          connectionId: ctx.connectionId,
          externalExpenseId: data.externalExpenseId,
        },
      },
      create: data,
      update: {
        expenseDate: data.expenseDate,
        accountName: data.accountName,
        amount: data.amount,
        taxAmount: data.taxAmount,
        status: data.status,
        raw: data.raw,
      },
    });
    written += 1;
  }
  return written;
}

async function pull(ctx: ConnectorContext) {
  const credentials = decodeCredentials(ctx.credentialsRef);
  if (!credentials.zohoOrganizationId) {
    throw new Error("zoho_organization_id_missing_on_connection");
  }
  const accessToken = await getAccessToken(credentials);

  const bills = await ingestBills(ctx, credentials, accessToken);
  const expenses = await ingestExpenses(ctx, credentials, accessToken);

  logger.info({ connectionId: ctx.connectionId, bills, expenses }, "zoho_books_sync_complete");
  // cursor stays null: see the note on the connector's sync() below for why a
  // date cursor would silently miss bill payments.
  return { recordsFetched: bills + expenses, cursor: null };
}

export const zohoBooksConnector: Connector = {
  provider: "ZOHO_BOOKS",

  // Zoho Books has no incremental cursor this connector relies on: bills change
  // state (a bill gets paid) without their date moving, so a date-filtered
  // incremental sync would miss exactly the updates that matter most for
  // payables. Both paths therefore do the same full upsert walk — correct, and
  // affordable because accounting volumes are orders of magnitude smaller than
  // order volumes.
  async backfill(ctx) {
    return pull(ctx);
  },
  async sync(ctx) {
    return pull(ctx);
  },
  // Zoho Books webhooks exist but are configured per-workflow inside the user's
  // Zoho account rather than registered via the API, so there's nothing this
  // connector can set up automatically. Polling is the honest default.
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  async processEvent(_ctx: ConnectorContext, _payload: unknown, _eventType: string): Promise<void> {
    // No webhook path — see verifyWebhook above.
  },
};
