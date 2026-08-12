import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../../config/env.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { signOAuthState, verifyOAuthState } from "../../lib/oauthState.js";
import { requireAuth } from "../../middleware/auth.js";
import { writeAudit } from "../../lib/audit.js";
import { shopifyConnector } from "../../modules/connectors/shopify/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";
import { prisma } from "../../lib/prisma.js";

export const shopifyConnectionRouter = Router();

const SHOPIFY_SCOPES = "read_orders,read_products,read_customers,read_fulfillments";

function isValidShopDomain(shop: unknown): shop is string {
  return typeof shop === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

function verifyOAuthCallbackHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const digestBuf = Buffer.from(digest);
  const hmacBuf = Buffer.from(hmac);
  return digestBuf.length === hmacBuf.length && crypto.timingSafeEqual(digestBuf, hmacBuf);
}

async function exchangeCodeForAccessToken(shop: string, code: string): Promise<string> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.SHOPIFY_API_KEY, client_secret: env.SHOPIFY_API_SECRET, code }),
  });
  if (!res.ok) throw new Error(`token_exchange_failed_${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// Step 1: the frontend calls this (authenticated) to get the URL to send the
// browser to. It can't just redirect directly from an authenticated fetch —
// the actual navigation to Shopify happens as a follow-up window.location
// change on the client, since that's a plain unauthenticated browser request.
shopifyConnectionRouter.post("/install", ...requireAuth, async (req, res) => {
  if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) {
    res.status(503).json({ error: "shopify_not_configured" });
    return;
  }

  const shop = req.body?.shop;
  if (!isValidShopDomain(shop)) {
    res.status(400).json({ error: "invalid_shop_domain" });
    return;
  }

  const state = signOAuthState(req.auth!.organizationId);
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", env.SHOPIFY_API_KEY);
  url.searchParams.set("scope", SHOPIFY_SCOPES);
  url.searchParams.set("redirect_uri", `${env.BACKEND_URL}/connections/shopify/callback`);
  url.searchParams.set("state", state);

  res.json({ url: url.toString() });
});

// Alternate to /install+/callback: a Shopify "Custom App" (created directly
// in a merchant's own admin, Settings -> Apps -> Develop apps — not via a
// Partner account) issues a static Admin API access token with no OAuth
// round-trip at all. Same shape as Razorpay/Shiprocket/Delhivery's direct
// connect routes: one authenticated request, `{shop, accessToken}`,
// validated against Shopify's real API before saving anything. This is
// also, practically, the only way to test this connector at all without a
// Partner account, a dev store, and a public HTTPS callback URL for
// `/callback` above — none of which exist yet (see cfo-docs/PROGRESS.md).
// `shopifyConnector` itself doesn't care how the token was obtained — the
// Admin API accepts an OAuth-issued and a Custom-App-issued token
// identically, so backfill()/sync()/processEvent() are untouched.
shopifyConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  const { shop, accessToken } = req.body ?? {};
  if (!isValidShopDomain(shop) || typeof accessToken !== "string" || !accessToken.trim()) {
    res.status(400).json({ error: "invalid_credentials" });
    return;
  }

  const probe = await fetch(`https://${shop}/admin/api/2024-10/shop.json`, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  if (probe.status === 401 || probe.status === 403) {
    res.status(400).json({ error: "invalid_credentials" });
    return;
  }
  if (!probe.ok) {
    logger.error({ status: probe.status, shop }, "shopify_token_validation_failed");
    res.status(502).json({ error: "shopify_unreachable" });
    return;
  }

  // Everything past this point can throw (DB errors, and especially
  // backfill() — a real external API call against live data, the least
  // predictable part of this route) and must not be allowed to crash the
  // process the way an uncaught rejection did here before this fix. Every
  // other connect route in this codebase (Razorpay, Shiprocket, Delhivery)
  // already wraps this section in try/catch; this one originally didn't.
  try {
    const organizationId = req.auth!.organizationId;
    const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
    const credentialsRef = encryptSecret(accessToken);

    let connection = await prisma.connection.findFirst({
      where: { organizationId, provider: "SHOPIFY", externalAccountId: shop },
    });
    connection = connection
      ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
      : await prisma.connection.create({
          data: {
            organizationId,
            legalEntityId: legalEntity.id,
            provider: "SHOPIFY",
            status: "ACTIVE",
            externalAccountId: shop,
            credentialsRef,
          },
        });

    const result = await shopifyConnector.backfill(toConnectorContext(connection));
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });

    logger.info({ connectionId: connection.id, recordsFetched: result.recordsFetched }, "shopify_token_connect_complete");
    await writeAudit({
      organizationId,
      actorType: "USER",
      actorId: req.auth!.userId,
      action: "connection.credential_set",
      entityType: "CONNECTION",
      entityId: connection.id,
      metadata: { provider: "SHOPIFY", shop },
    });
    res.json({ connected: true, recordsFetched: result.recordsFetched });
  } catch (err) {
    logger.error({ err, shop }, "shopify_token_connect_failed");
    res.status(500).json({ error: "connect_failed" });
  }
});

// Step 2: Shopify redirects the browser here directly — no Clerk session
// involved, org identity comes from the signed state instead (see lib/oauthState.ts).
shopifyConnectionRouter.get("/callback", async (req, res) => {
  const query = req.query as Record<string, string>;

  try {
    if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) throw new Error("shopify_not_configured");

    const { shop, code, state } = query;
    if (!isValidShopDomain(shop) || !code || !state) throw new Error("missing_or_invalid_params");
    if (!verifyOAuthCallbackHmac(query, env.SHOPIFY_API_SECRET)) throw new Error("invalid_hmac");

    const stateResult = verifyOAuthState(state);
    if (!stateResult) throw new Error("invalid_or_expired_state");

    const accessToken = await exchangeCodeForAccessToken(shop, code);
    const legalEntity = await getOrCreateDefaultLegalEntity(stateResult.organizationId);

    let connection = await prisma.connection.findFirst({
      where: { organizationId: stateResult.organizationId, provider: "SHOPIFY", externalAccountId: shop },
    });
    connection = connection
      ? await prisma.connection.update({
          where: { id: connection.id },
          data: { credentialsRef: encryptSecret(accessToken), status: "ACTIVE" },
        })
      : await prisma.connection.create({
          data: {
            organizationId: stateResult.organizationId,
            legalEntityId: legalEntity.id,
            provider: "SHOPIFY",
            status: "ACTIVE",
            externalAccountId: shop,
            credentialsRef: encryptSecret(accessToken),
          },
        });

    // Inline for now — fine for a dev store's order volume. A real store's
    // full history should move to a background job; see cfo-docs/PROGRESS.md.
    const result = await shopifyConnector.backfill(toConnectorContext(connection));
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });

    logger.info({ connectionId: connection.id, recordsFetched: result.recordsFetched }, "shopify_backfill_complete");
    // No Clerk session on an OAuth redirect callback — state only carries
    // organizationId (see lib/oauthState.ts).
    await writeAudit({
      organizationId: stateResult.organizationId,
      actorType: "SYSTEM",
      actorId: "oauth_callback",
      action: "connection.credential_set",
      entityType: "CONNECTION",
      entityId: connection.id,
      metadata: { provider: "SHOPIFY", shop },
    });
    res.redirect(`${env.FRONTEND_URL}/connections?shopify=connected&orders=${result.recordsFetched}`);
  } catch (err) {
    logger.error({ err }, "shopify_oauth_callback_failed");
    res.redirect(`${env.FRONTEND_URL}/connections?shopify=error`);
  }
});
