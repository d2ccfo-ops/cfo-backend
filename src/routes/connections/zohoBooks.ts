import { Router } from "express";
import { env } from "../../config/env.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { signOAuthState, verifyOAuthState } from "../../lib/oauthState.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  accountsServerFor,
  encodeCredentials,
  exchangeCodeForTokens,
  getAuthorizeUrl,
  listOrganizations,
  zohoBooksConnector,
} from "../../modules/connectors/zohoBooks/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const zohoBooksConnectionRouter = Router();

function redirectUri(): string {
  return `${env.BACKEND_URL}/connections/zoho-books/callback`;
}

zohoBooksConnectionRouter.post("/install", ...requireAuth, async (req, res) => {
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) {
    res.status(503).json({
      error: "zoho_not_configured",
      message:
        "Add ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET to cfo-backend/.env (create a Server-based Application at api-console.zoho.in with redirect URI " +
        `${redirectUri()}), then restart the backend.`,
    });
    return;
  }
  const state = signOAuthState(req.auth!.organizationId);
  res.json({ url: getAuthorizeUrl(state, redirectUri()) });
});

// Zoho redirects here. Beyond `code` and `state` it also sends `location` and
// `accounts-server` identifying the user's datacenter — and the code is only
// redeemable at THAT accounts server. Exchanging against a hardcoded .com host
// fails for every Indian account, which is most of this product's users.
zohoBooksConnectionRouter.get("/callback", async (req, res) => {
  const query = req.query as Record<string, string>;
  const { code, state, location } = query;
  const accountsServerParam = query["accounts-server"];

  try {
    if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) throw new Error("zoho_not_configured");
    if (!code || !state) throw new Error("missing_params");

    const stateResult = verifyOAuthState(state);
    if (!stateResult) throw new Error("invalid_or_expired_state");

    const accountsServer = accountsServerFor(location, accountsServerParam);
    const { refreshToken, accessToken, apiDomain } = await exchangeCodeForTokens(
      code,
      redirectUri(),
      accountsServer
    );

    // Every Books API call needs an organization_id, and a Zoho login can own
    // several. One Connection per Zoho organisation, same "don't assume 1:1"
    // reasoning as Meta/Google ad accounts.
    const organizations = await listOrganizations(accessToken, apiDomain);
    if (organizations.length === 0) throw new Error("no_zoho_organizations_found");

    const legalEntity = await getOrCreateDefaultLegalEntity(stateResult.organizationId);
    let totalRecords = 0;

    for (const zohoOrg of organizations) {
      const credentialsRef = encryptSecret(
        encodeCredentials({
          refreshToken,
          accountsServer,
          apiDomain,
          zohoOrganizationId: zohoOrg.organization_id,
        })
      );

      const existing = await prisma.connection.findFirst({
        where: {
          organizationId: stateResult.organizationId,
          provider: "ZOHO_BOOKS",
          externalAccountId: zohoOrg.organization_id,
        },
      });

      const connection = existing
        ? await prisma.connection.update({
            where: { id: existing.id },
            data: { credentialsRef, status: "ACTIVE", lastSyncError: null },
          })
        : await prisma.connection.create({
            data: {
              organizationId: stateResult.organizationId,
              legalEntityId: legalEntity.id,
              provider: "ZOHO_BOOKS",
              status: "ACTIVE",
              externalAccountId: zohoOrg.organization_id,
              credentialsRef,
            },
          });

      try {
        const result = await zohoBooksConnector.backfill(toConnectorContext(connection));
        totalRecords += result.recordsFetched;
        await prisma.connection.update({
          where: { id: connection.id },
          data: { lastSyncedAt: new Date() },
        });
      } catch (err) {
        // One organisation failing to backfill must not abandon the others or
        // lose the credential we just stored — the connection stays, with the
        // error surfaced on the Connections page.
        logger.error({ err, zohoOrganizationId: zohoOrg.organization_id }, "zoho_backfill_failed");
        await prisma.connection.update({
          where: { id: connection.id },
          data: { status: "ERROR", lastSyncError: (err as Error).message.slice(0, 500) },
        });
      }
    }

    res.redirect(`${env.FRONTEND_URL}/connections?connected=zoho-books&records=${totalRecords}`);
  } catch (err) {
    logger.error({ err }, "zoho_callback_failed");
    res.redirect(`${env.FRONTEND_URL}/connections?error=${encodeURIComponent((err as Error).message)}`);
  }
});
