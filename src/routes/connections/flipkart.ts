import { Router } from "express";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { writeAudit } from "../../lib/audit.js";
import { encodeCredentials, flipkartConnector, verifyCredentials } from "../../modules/connectors/flipkart/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const flipkartConnectionRouter = Router();

// No OAuth redirect — a Flipkart Self Access Application's appId/appSecret
// are created by the seller in their own Seller Dashboard and only ever
// authorize that one seller's own account, so this is a single authenticated
// request, same shape as Razorpay's connect route.
flipkartConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  const { appId, appSecret } = req.body ?? {};
  if (typeof appId !== "string" || !appId.trim() || typeof appSecret !== "string" || !appSecret.trim()) {
    res.status(400).json({ error: "missing_credentials" });
    return;
  }

  const creds = { appId, appSecret };
  try {
    await verifyCredentials(creds);
  } catch {
    res.status(400).json({ error: "invalid_credentials" });
    return;
  }

  try {
    const organizationId = req.auth!.organizationId;
    const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
    const credentialsRef = encryptSecret(encodeCredentials(creds));

    let connection = await prisma.connection.findFirst({
      where: { organizationId, provider: "FLIPKART", externalAccountId: appId },
    });
    connection = connection
      ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
      : await prisma.connection.create({
          data: {
            organizationId,
            legalEntityId: legalEntity.id,
            provider: "FLIPKART",
            status: "ACTIVE",
            externalAccountId: appId,
            credentialsRef,
          },
        });

    const result = await flipkartConnector.backfill(toConnectorContext(connection));
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });

    logger.info({ connectionId: connection.id, recordsFetched: result.recordsFetched }, "flipkart_connect_complete");
    await writeAudit({
      organizationId,
      actorType: "USER",
      actorId: req.auth!.userId,
      action: "connection.credential_set",
      entityType: "CONNECTION",
      entityId: connection.id,
      metadata: { provider: "FLIPKART" },
    });
    res.json({ connected: true, recordsFetched: result.recordsFetched });
  } catch (err) {
    logger.error({ err }, "flipkart_connect_failed");
    res.status(500).json({ error: "connect_failed" });
  }
});
