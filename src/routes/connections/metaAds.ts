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
  exchangeCodeForLongLivedToken,
  getAuthorizeUrl,
  listAdAccounts,
  metaAdsConnector,
} from "../../modules/connectors/metaAds/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const metaAdsConnectionRouter = Router();

function redirectUri(): string {
  return `${env.BACKEND_URL}/connections/meta-ads/callback`;
}

// Step 1 — same shape as Shopify's /install: authenticated request returns
// the URL, the browser navigates there separately (can't redirect directly
// from a fetch() call).
metaAdsConnectionRouter.post("/install", ...requireAuth, async (req, res) => {
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    res.status(503).json({ error: "meta_ads_not_configured" });
    return;
  }
  const state = signOAuthState(req.auth!.organizationId);
  res.json({ url: getAuthorizeUrl(state, redirectUri()) });
});

// Step 2 — Meta redirects here directly, no Clerk session, org identity
// comes from the signed state (same mechanism as Shopify's callback). Unlike
// Shopify, one grant can list multiple ad accounts — a Connection is created
// per account rather than assuming exactly one.
metaAdsConnectionRouter.get("/callback", async (req, res) => {
  const { code, state } = req.query as Record<string, string>;

  try {
    if (!env.META_APP_ID || !env.META_APP_SECRET) throw new Error("meta_ads_not_configured");
    if (!code || !state) throw new Error("missing_params");

    const stateResult = verifyOAuthState(state);
    if (!stateResult) throw new Error("invalid_or_expired_state");

    const { accessToken, expiresAt } = await exchangeCodeForLongLivedToken(code, redirectUri());
    const adAccounts = await listAdAccounts(accessToken);
    if (adAccounts.length === 0) throw new Error("no_ad_accounts_found");

    const legalEntity = await getOrCreateDefaultLegalEntity(stateResult.organizationId);
    const credentialsRef = encryptSecret(encodeCredentials({ accessToken, expiresAt }));

    let totalRecords = 0;
    for (const account of adAccounts) {
      let connection = await prisma.connection.findFirst({
        where: { organizationId: stateResult.organizationId, provider: "META_ADS", externalAccountId: account.id },
      });
      connection = connection
        ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
        : await prisma.connection.create({
            data: {
              organizationId: stateResult.organizationId,
              legalEntityId: legalEntity.id,
              provider: "META_ADS",
              status: "ACTIVE",
              externalAccountId: account.id,
              credentialsRef,
            },
          });

      // Inline for now, same trade-off as every other connector's backfill — see cfo-docs/PROGRESS.md.
      const result = await metaAdsConnector.backfill(toConnectorContext(connection));
      await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
      totalRecords += result.recordsFetched;
    }

    logger.info({ organizationId: stateResult.organizationId, accounts: adAccounts.length, totalRecords }, "meta_ads_backfill_complete");
    await writeAudit({
      organizationId: stateResult.organizationId,
      actorType: "SYSTEM",
      actorId: "oauth_callback",
      action: "connection.credential_set",
      entityType: "CONNECTION",
      metadata: { provider: "META_ADS", adAccountIds: adAccounts.map((a) => a.id) },
    });
    res.redirect(`${env.FRONTEND_URL}/connections?metaAds=connected&accounts=${adAccounts.length}&records=${totalRecords}`);
  } catch (err) {
    logger.error({ err }, "meta_ads_oauth_callback_failed");
    res.redirect(`${env.FRONTEND_URL}/connections?metaAds=error`);
  }
});
