import { Router } from "express";
import { env } from "../../config/env.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { signOAuthState, verifyOAuthState } from "../../lib/oauthState.js";
import { requireAuth } from "../../middleware/auth.js";
import { writeAudit } from "../../lib/audit.js";
import {
  encodeCredentials,
  exchangeCodeForRefreshToken,
  getAccessToken,
  getAuthorizeUrl,
  googleAdsConnector,
  listAccessibleCustomers,
} from "../../modules/connectors/googleAds/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const googleAdsConnectionRouter = Router();

function redirectUri(): string {
  return `${env.BACKEND_URL}/connections/google-ads/callback`;
}

// Step 1 — same shape as Shopify's/Meta's /install.
googleAdsConnectionRouter.post("/install", ...requireAuth, async (req, res) => {
  if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET || !env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    res.status(503).json({ error: "google_ads_not_configured" });
    return;
  }
  const state = signOAuthState(req.auth!.organizationId);
  res.json({ url: getAuthorizeUrl(state, redirectUri()) });
});

// Step 2 — Google redirects here directly, org identity comes from the
// signed state (same mechanism as Shopify/Meta). Also creates one Connection
// per accessible customer ID, same "don't assume 1:1" reasoning as Meta Ads.
googleAdsConnectionRouter.get("/callback", async (req, res) => {
  const { code, state } = req.query as Record<string, string>;

  try {
    if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET || !env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      throw new Error("google_ads_not_configured");
    }
    if (!code || !state) throw new Error("missing_params");

    const stateResult = verifyOAuthState(state);
    if (!stateResult) throw new Error("invalid_or_expired_state");

    const refreshToken = await exchangeCodeForRefreshToken(code, redirectUri());
    const credentialsRef = encryptSecret(encodeCredentials({ refreshToken }));

    const accessToken = await getAccessToken(refreshToken);
    const customerIds = await listAccessibleCustomers(accessToken);
    if (customerIds.length === 0) throw new Error("no_customers_found");

    const legalEntity = await getOrCreateDefaultLegalEntity(stateResult.organizationId);

    let totalRecords = 0;
    for (const customerId of customerIds) {
      let connection = await prisma.connection.findFirst({
        where: { organizationId: stateResult.organizationId, provider: "GOOGLE_ADS", externalAccountId: customerId },
      });
      connection = connection
        ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
        : await prisma.connection.create({
            data: {
              organizationId: stateResult.organizationId,
              legalEntityId: legalEntity.id,
              provider: "GOOGLE_ADS",
              status: "ACTIVE",
              externalAccountId: customerId,
              credentialsRef,
            },
          });

      // Inline for now, same trade-off as every other connector's backfill — see cfo-docs/PROGRESS.md.
      const result = await googleAdsConnector.backfill(toConnectorContext(connection));
      await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
      totalRecords += result.recordsFetched;
    }

    logger.info(
      { organizationId: stateResult.organizationId, accounts: customerIds.length, totalRecords },
      "google_ads_backfill_complete"
    );
    // No Clerk session on an OAuth redirect callback — state only carries
    // organizationId. One entry for the whole grant, not one per customer ID,
    // since it's a single authorization event.
    await writeAudit({
      organizationId: stateResult.organizationId,
      actorType: "SYSTEM",
      actorId: "oauth_callback",
      action: "connection.credential_set",
      entityType: "CONNECTION",
      metadata: { provider: "GOOGLE_ADS", customerIds },
    });
    res.redirect(`${env.FRONTEND_URL}/connections?googleAds=connected&accounts=${customerIds.length}&records=${totalRecords}`);
  } catch (err) {
    logger.error({ err }, "google_ads_oauth_callback_failed");
    res.redirect(`${env.FRONTEND_URL}/connections?googleAds=error`);
  }
});
