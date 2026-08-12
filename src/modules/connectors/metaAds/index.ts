import { env } from "../../../config/env.js";
import { decryptSecret } from "../../../lib/crypto.js";
import { prisma } from "../../../lib/prisma.js";
import { majorToMinorUnits } from "../../calc/money.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";

// Meta Ads is OAuth like Shopify (platform app, browser redirect), but two
// real differences from every connector built so far:
//  - There's no webhook at all. Meta's Marketing API has no push mechanism
//    for ad spend/insights — it's poll-only, same as Google Ads will be. No
//    routes/webhooks/metaAds.ts exists, and verifyWebhook() below is never
//    actually called (same "interface requires it, provider doesn't have
//    one" shape as the bank connector, but this one *does* have OAuth).
//  - One OAuth grant can cover multiple ad accounts. The callback route
//    creates one Connection per ad account returned by /me/adaccounts,
//    rather than assuming a 1:1 mapping like Shopify's one-shop-per-install.

// v21.0 (the previous pin) still answers today but expires 21 Jan 2027, and
// Marketing API v24.0 expires even sooner (6 Oct 2026). v25.0 (released
// 18 Feb 2026) is deliberately chosen over the newest v26.0 (29 Jul 2026):
// six months settled, and it runs to ~Jul 2028. Unlike Google Ads, Meta
// versions expire on a published ~2-year schedule rather than ~1 year:
// https://developers.facebook.com/docs/graph-api/changelog
const GRAPH_API_VERSION = "v25.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const MAX_PAGES_PER_RUN = 50;
const BACKFILL_DAYS = 90;

export interface MetaAdsCredentials {
  accessToken: string;
  expiresAt: string; // ISO — long-lived tokens last ~60 days, no refresh-token flow exists
}

export function encodeCredentials(creds: MetaAdsCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): MetaAdsCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as MetaAdsCredentials;
}

export function getAuthorizeUrl(state: string, redirectUri: string): string {
  const url = new URL(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", env.META_APP_ID ?? "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "ads_read");
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

export async function exchangeCodeForLongLivedToken(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; expiresAt: string }> {
  if (!env.META_APP_ID || !env.META_APP_SECRET) throw new Error("meta_ads_not_configured");

  // Step 1: code -> short-lived user token.
  const shortLivedUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
  shortLivedUrl.searchParams.set("client_id", env.META_APP_ID);
  shortLivedUrl.searchParams.set("client_secret", env.META_APP_SECRET);
  shortLivedUrl.searchParams.set("redirect_uri", redirectUri);
  shortLivedUrl.searchParams.set("code", code);
  const shortLivedRes = await fetch(shortLivedUrl);
  if (!shortLivedRes.ok) throw new Error(`meta_token_exchange_failed_${shortLivedRes.status}`);
  const shortLived = (await shortLivedRes.json()) as { access_token: string };

  // Step 2: short-lived -> long-lived (~60 days), the only "refresh" this
  // token type gets — there's no separate refresh_token, unlike Google's
  // OAuth. Re-exchanging before expiry would extend it again, and nothing does
  // that yet: the sync scheduler (modules/queue/syncScheduler.ts) now keeps
  // this connection syncing every 3 hours, which means the token is at least
  // exercised regularly, but a proactive re-exchange is still unbuilt — so an
  // expired connection needs a fresh OAuth install, not an automatic refresh.
  const longLivedUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
  longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
  longLivedUrl.searchParams.set("client_id", env.META_APP_ID);
  longLivedUrl.searchParams.set("client_secret", env.META_APP_SECRET);
  longLivedUrl.searchParams.set("fb_exchange_token", shortLived.access_token);
  const longLivedRes = await fetch(longLivedUrl);
  if (!longLivedRes.ok) throw new Error(`meta_long_lived_exchange_failed_${longLivedRes.status}`);
  const longLived = (await longLivedRes.json()) as { access_token: string; expires_in: number };

  return {
    accessToken: longLived.access_token,
    expiresAt: new Date(Date.now() + longLived.expires_in * 1000).toISOString(),
  };
}

export async function listAdAccounts(accessToken: string): Promise<{ id: string; name: string }[]> {
  const url = new URL(`${GRAPH_BASE}/me/adaccounts`);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`meta_list_ad_accounts_failed_${res.status}`);
  const data = (await res.json()) as { data: { id: string; name: string }[] };
  return data.data;
}

interface MetaInsightRow {
  spend?: string;
  impressions?: string;
  clicks?: string;
  // Requested in the same insights call rather than a separate lookup on the
  // ad account — Meta reports spend in the account's billing currency, which
  // an Indian advertiser may well have set to USD. See processEvent below.
  account_currency?: string;
  date_start: string;
  date_stop: string;
}

function toUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function pullInsights(ctx: ConnectorContext, sinceDate: string, until: string): Promise<number> {
  const creds = decodeCredentials(ctx.credentialsRef);
  let url: URL | null = new URL(`${GRAPH_BASE}/${ctx.externalAccountId}/insights`);
  url.searchParams.set("fields", "spend,impressions,clicks,account_currency");
  url.searchParams.set("time_range", JSON.stringify({ since: sinceDate, until }));
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("access_token", creds.accessToken);

  let total = 0;
  let pages = 0;

  while (url && pages < MAX_PAGES_PER_RUN) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`meta_insights_request_failed_${res.status}`);
    const data = (await res.json()) as { data: MetaInsightRow[]; paging?: { next?: string } };

    for (const row of data.data) {
      const externalEventId = `adspend_${ctx.externalAccountId}_${row.date_start}`;
      await prisma.rawEvent.upsert({
        where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId } },
        create: {
          organizationId: ctx.organizationId,
          connectionId: ctx.connectionId,
          provider: "META_ADS",
          externalEventId,
          eventType: "ad_spend.sync",
          payload: row as unknown as object,
          processedAt: new Date(),
          processingStatus: "PROCESSED",
        },
        update: { payload: row as unknown as object, processedAt: new Date(), processingStatus: "PROCESSED" },
      });
      await metaAdsConnector.processEvent(ctx, row, "ad_spend.sync");
      total++;
    }

    url = data.paging?.next ? new URL(data.paging.next) : null;
    pages++;
  }

  return total;
}

async function pull(ctx: ConnectorContext, sinceDate: string | null): Promise<SyncResult> {
  const until = toUtcDateString(new Date());
  const since = sinceDate ?? toUtcDateString(new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000));
  const count = await pullInsights(ctx, since, until);
  return { recordsFetched: count, cursor: until };
}

export const metaAdsConnector: Connector = {
  provider: "META_ADS",

  async backfill(ctx: ConnectorContext): Promise<SyncResult> {
    return pull(ctx, null);
  },

  async sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult> {
    return pull(ctx, sinceCursor);
  },

  // No webhook exists for this provider — see the module-level comment.
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, _eventType: string): Promise<void> {
    const row = payload as MetaInsightRow;
    const date = new Date(`${row.date_start}T00:00:00.000Z`);
    // `spend` is a decimal string in the account's billing currency, NOT
    // necessarily rupees — so this records the currency rather than asserting
    // paise. AdSpend.currency defaults to "INR"; a USD-billed account
    // previously stored $X as if it were ₹X, which would have quietly
    // corrupted contribution margin instead of failing loudly.
    const currency = row.account_currency ?? "INR";
    const spendAmount = row.spend ? majorToMinorUnits(Number(row.spend)) : 0n;

    await prisma.adSpend.upsert({
      where: {
        connectionId_externalAccountId_date: { connectionId: ctx.connectionId, externalAccountId: ctx.externalAccountId ?? "", date },
      },
      create: {
        organizationId: ctx.organizationId,
        legalEntityId: ctx.legalEntityId,
        connectionId: ctx.connectionId,
        provider: "META_ADS",
        externalAccountId: ctx.externalAccountId ?? "",
        date,
        spendAmount,
        currency,
        impressions: row.impressions ? Number(row.impressions) : null,
        clicks: row.clicks ? Number(row.clicks) : null,
        raw: payload as object,
      },
      update: {
        spendAmount,
        currency,
        impressions: row.impressions ? Number(row.impressions) : null,
        clicks: row.clicks ? Number(row.clicks) : null,
        raw: payload as object,
      },
    });
  },
};
