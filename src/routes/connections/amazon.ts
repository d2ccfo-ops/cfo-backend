import { Router } from "express";
import { env } from "../../config/env.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { signOAuthState, verifyOAuthState } from "../../lib/oauthState.js";
import { requireAuth } from "../../middleware/auth.js";
import { writeAudit } from "../../lib/audit.js";
import { amazonConnector, encodeCredentials, exchangeCodeForRefreshToken, getAuthorizeUrl } from "../../modules/connectors/amazon/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const amazonConnectionRouter = Router();

function redirectUri(): string {
  return `${env.BACKEND_URL}/connections/amazon/callback`;
}

// Step 1 — same shape as Shopify's/Meta's/Google's install.
amazonConnectionRouter.post("/install", ...requireAuth, async (req, res) => {
  if (!env.AMAZON_APP_ID || !env.AMAZON_LWA_CLIENT_ID || !env.AMAZON_LWA_CLIENT_SECRET) {
    res.status(503).json({ error: "amazon_not_configured" });
    return;
  }
  const state = signOAuthState(req.auth!.organizationId);
  res.json({ url: getAuthorizeUrl(state, redirectUri()) });
});

// Step 2 — Amazon redirects here directly, no Clerk session, org identity
// comes from the signed state (same mechanism as every other OAuth connector
// in this codebase). Unlike Shopify (one shop per install), a seller
// account has exactly one selling_partner_id per marketplace region, so —
// unlike Meta/Google's "one grant, many ad accounts" — this always creates
// or updates exactly one Connection.
amazonConnectionRouter.get("/callback", async (req, res) => {
  const { spapi_oauth_code: code, state, selling_partner_id: sellingPartnerId } = req.query as Record<string, string>;

  try {
    if (!env.AMAZON_APP_ID || !env.AMAZON_LWA_CLIENT_ID || !env.AMAZON_LWA_CLIENT_SECRET) throw new Error("amazon_not_configured");
    if (!code || !state) throw new Error("missing_params");

    const stateResult = verifyOAuthState(state);
    if (!stateResult) throw new Error("invalid_or_expired_state");

    const { refreshToken } = await exchangeCodeForRefreshToken(code);
    const legalEntity = await getOrCreateDefaultLegalEntity(stateResult.organizationId);
    const credentialsRef = encryptSecret(encodeCredentials({ refreshToken, sellingPartnerId }));

    let connection = await prisma.connection.findFirst({
      where: { organizationId: stateResult.organizationId, provider: "AMAZON" },
    });
    connection = connection
      ? await prisma.connection.update({
          where: { id: connection.id },
          data: { credentialsRef, status: "ACTIVE", externalAccountId: sellingPartnerId ?? connection.externalAccountId },
        })
      : await prisma.connection.create({
          data: {
            organizationId: stateResult.organizationId,
            legalEntityId: legalEntity.id,
            provider: "AMAZON",
            status: "ACTIVE",
            externalAccountId: sellingPartnerId ?? null,
            credentialsRef,
          },
        });

    // Inline for now, same trade-off as every other connector's backfill —
    // see cfo-docs/PROGRESS.md.
    const result = await amazonConnector.backfill(toConnectorContext(connection));
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });

    logger.info({ organizationId: stateResult.organizationId, recordsFetched: result.recordsFetched }, "amazon_backfill_complete");
    // No Clerk session on an OAuth redirect callback (see verifyOAuthState) —
    // the state only carries organizationId, so the actor is the OAuth flow
    // itself, not an identified user.
    await writeAudit({
      organizationId: stateResult.organizationId,
      actorType: "SYSTEM",
      actorId: "oauth_callback",
      action: "connection.credential_set",
      entityType: "CONNECTION",
      entityId: connection.id,
      metadata: { provider: "AMAZON" },
    });
    res.redirect(`${env.FRONTEND_URL}/connections?amazon=connected&records=${result.recordsFetched}`);
  } catch (err) {
    logger.error({ err }, "amazon_oauth_callback_failed");
    res.redirect(`${env.FRONTEND_URL}/connections?amazon=error`);
  }
});
