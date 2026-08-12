import { env } from "../../../config/env.js";
import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import { majorToMinorUnits } from "../../calc/money.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";

// Google Ads is OAuth like Meta Ads (poll-only, one grant can cover multiple
// accounts), but with real differences from Meta:
//  - Google's OAuth actually has a refresh_token, so this connector can
//    genuinely auto-renew access without the user re-authorizing — unlike
//    Meta's long-lived-token-with-no-refresh-flow. The stored credential is
//    just the refresh_token; a fresh access_token is fetched at the start of
//    every backfill/sync/etc, same "always get a fresh short-lived
//    credential" pattern as Shiprocket's login(), except this is the
//    textbook-correct way to use Google's OAuth (access tokens are ~1hr by
//    design, refresh tokens are the actual long-lived credential).
//  - There's a SECOND approval gate beyond the OAuth app itself: a Google
//    Ads "developer token", requested separately in the Google Ads UI. New
//    tokens default to test-account-only access; reading a real advertiser's
//    data needs Google to approve "Standard" access — a genuinely harder bar
//    than Meta's Advanced Access review, not just the same thing twice.
//  - Spend comes back as `cost_micros` (1,000,000 micros = 1 currency unit)
//    via GAQL (Google Ads Query Language), not a plain decimal string.

// Google sunsets each version roughly a year after release, and a sunset
// version doesn't degrade — every request just fails. This was pinned to v17
// (sunset 4 June 2025), i.e. the connector could not have worked at all.
// v24 (released 22 Apr 2026, minors through v24.2) is deliberately chosen
// over the newest v25 (22 Jul 2026): it's had three months and two minor
// releases to settle, and still runs to ~Apr 2027. Re-check this before it
// sunsets: https://developers.google.com/google-ads/api/docs/sunset-dates
const GOOGLE_ADS_API_VERSION = "v24";
const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const BACKFILL_DAYS = 90;
const MAX_PAGES_PER_RUN = 50;

export interface GoogleAdsCredentials {
  refreshToken: string;
}

export function encodeCredentials(creds: GoogleAdsCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): GoogleAdsCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as GoogleAdsCredentials;
}

export function getAuthorizeUrl(state: string, redirectUri: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_ADS_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "https://www.googleapis.com/auth/adwords");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // forces a refresh_token even on repeat consent
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForRefreshToken(code: string, redirectUri: string): Promise<string> {
  if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET) throw new Error("google_ads_not_configured");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`google_ads_token_exchange_failed_${res.status}`);
  const data = (await res.json()) as { refresh_token?: string };
  if (!data.refresh_token) {
    // Google only returns a refresh_token on the *first* consent (or with
    // prompt=consent forcing re-issue) — surfacing this clearly beats a
    // silent connection that can never actually refresh.
    throw new Error("google_ads_no_refresh_token_returned");
  }
  return data.refresh_token;
}

// Exported separately so routes/connections/googleAds.ts's callback (which
// needs a fresh access token to call listAccessibleCustomers right after
// exchanging the code, before any Connection/credentialsRef exists yet to
// decrypt) doesn't have to duplicate this HTTP call.
export async function getAccessToken(refreshToken: string): Promise<string> {
  if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET) throw new Error("google_ads_not_configured");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`google_ads_refresh_failed_${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function authHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
    "Content-Type": "application/json",
  };
  // Only needed when the OAuth credentials belong to a manager (MCC) account
  // acting on behalf of a client account — absent for a standalone account.
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers["login-customer-id"] = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  return headers;
}

export async function listAccessibleCustomers(accessToken: string): Promise<string[]> {
  const res = await fetch(`${GOOGLE_ADS_BASE}/customers:listAccessibleCustomers`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`google_ads_list_customers_failed_${res.status}`);
  const data = (await res.json()) as { resourceNames: string[] };
  // "customers/1234567890" -> "1234567890"
  return data.resourceNames.map((name) => name.split("/")[1]).filter((id): id is string => Boolean(id));
}

interface GoogleAdsRow {
  segments?: { date?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string };
  // Selected in the same query rather than fetched separately — Google
  // reports cost in the *account's* currency, which is not necessarily INR
  // (an Indian advertiser can and often does run a USD-billed account). See
  // processEvent below for why we record it instead of assuming.
  customer?: { currencyCode?: string };
}

async function pullInsights(ctx: ConnectorContext, sinceDate: string, until: string): Promise<number> {
  const creds = decodeCredentials(ctx.credentialsRef);
  const accessToken = await getAccessToken(creds.refreshToken);
  const customerId = ctx.externalAccountId ?? "";

  const query = `SELECT customer.currency_code, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM customer WHERE segments.date BETWEEN '${sinceDate}' AND '${until}'`;

  let count = 0;
  let pageToken: string | undefined;
  let pages = 0;

  // googleAds:search is paginated (nextPageToken). The previous version read
  // only the first page — invisible at 90 daily account-level rows, but
  // silently lossy the moment the window or the query grain grows.
  do {
    const res = await fetch(`${GOOGLE_ADS_BASE}/customers/${customerId}/googleAds:search`, {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
    });
    if (!res.ok) throw new Error(`google_ads_search_failed_${res.status}_${await res.text()}`);
    const data = (await res.json()) as { results?: GoogleAdsRow[]; nextPageToken?: string };

    for (const row of data.results ?? []) {
      const date = row.segments?.date;
      if (!date) continue;
      const externalEventId = `adspend_${customerId}_${date}`;
      await prisma.rawEvent.upsert({
        where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
        create: {
          organizationId: ctx.organizationId,
          connectionId: ctx.connectionId,
          provider: "GOOGLE_ADS",
          externalEventId,
          eventType: "ad_spend.sync",
          payload: row as unknown as object,
          processedAt: new Date(),
          processingStatus: "PROCESSED",
        },
        update: { payload: row as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
      });
      await googleAdsConnector.processEvent(ctx, row, "ad_spend.sync");
      count++;
    }

    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES_PER_RUN);

  return count;
}

function toUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function pull(ctx: ConnectorContext, sinceDate: string | null): Promise<SyncResult> {
  const until = toUtcDateString(new Date());
  const since = sinceDate ?? toUtcDateString(new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000));
  const count = await pullInsights(ctx, since, until);
  return { recordsFetched: count, cursor: until };
}

export const googleAdsConnector: Connector = {
  provider: "GOOGLE_ADS",

  async backfill(ctx: ConnectorContext): Promise<SyncResult> {
    return pull(ctx, null);
  },

  async sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult> {
    return pull(ctx, sinceCursor);
  },

  // No webhook exists for this provider either — same as Meta Ads, the
  // Google Ads API is poll-only for spend/performance data.
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, _eventType: string): Promise<void> {
    const row = payload as GoogleAdsRow;
    const date = row.segments?.date;
    if (!date) return;
    const dateObj = new Date(`${date}T00:00:00.000Z`);
    const costMicros = row.metrics?.costMicros ? Number(row.metrics.costMicros) : 0;
    // cost_micros is in the account's billing currency (1,000,000 micros = 1
    // major unit), NOT necessarily rupees — so this records the currency
    // rather than asserting paise. AdSpend.currency defaults to "INR"; a
    // USD-billed account previously stored $X as if it were ₹X, which would
    // have quietly corrupted contribution margin instead of failing loudly.
    const currency = row.customer?.currencyCode ?? "INR";
    const spendAmount = majorToMinorUnits(costMicros / 1_000_000);

    await prisma.adSpend.upsert({
      where: {
        connectionId_externalAccountId_date: {
          connectionId: ctx.connectionId,
          externalAccountId: ctx.externalAccountId ?? "",
          date: dateObj,
        },
      },
      create: {
        organizationId: ctx.organizationId,
        legalEntityId: ctx.legalEntityId,
        connectionId: ctx.connectionId,
        provider: "GOOGLE_ADS",
        externalAccountId: ctx.externalAccountId ?? "",
        date: dateObj,
        spendAmount,
        currency,
        impressions: row.metrics?.impressions ? Number(row.metrics.impressions) : null,
        clicks: row.metrics?.clicks ? Number(row.metrics.clicks) : null,
        raw: payload as object,
      },
      update: {
        spendAmount,
        currency,
        impressions: row.metrics?.impressions ? Number(row.metrics.impressions) : null,
        clicks: row.metrics?.clicks ? Number(row.metrics.clicks) : null,
        raw: payload as object,
      },
    });
  },
};
