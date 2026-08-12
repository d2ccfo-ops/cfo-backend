import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { encryptSecret } from "../../lib/crypto.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { writeAudit } from "../../lib/audit.js";
import { encodeCredentials, login, shiprocketConnector } from "../../modules/connectors/shiprocket/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const shiprocketConnectionRouter = Router();

// No OAuth, and not quite Razorpay's shape either — Shiprocket exchanges
// email+password for a bearer token instead of using the credentials
// directly on every call. This route validates by actually logging in.
shiprocketConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  const { email, password, webhookToken } = req.body ?? {};
  if (!email || !password || !webhookToken) {
    res.status(400).json({ error: "missing_credentials" });
    return;
  }

  try {
    await login({ email, password, webhookToken });
  } catch {
    res.status(400).json({ error: "invalid_credentials" });
    return;
  }

  try {
    const organizationId = req.auth!.organizationId;
    const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
    const credentialsRef = encryptSecret(encodeCredentials({ email, password, webhookToken }));

    let connection = await prisma.connection.findFirst({
      where: { organizationId, provider: "SHIPROCKET", externalAccountId: email },
    });
    connection = connection
      ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
      : await prisma.connection.create({
          data: {
            organizationId,
            legalEntityId: legalEntity.id,
            provider: "SHIPROCKET",
            status: "ACTIVE",
            externalAccountId: email,
            credentialsRef,
          },
        });

    // Inline for now, same trade-off as Shopify/Razorpay's backfill — see cfo-docs/PROGRESS.md.
    const result = await shiprocketConnector.backfill(toConnectorContext(connection));
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });

    logger.info({ connectionId: connection.id, recordsFetched: result.recordsFetched }, "shiprocket_backfill_complete");
    await writeAudit({
      organizationId,
      actorType: "USER",
      actorId: req.auth!.userId,
      action: "connection.credential_set",
      entityType: "CONNECTION",
      entityId: connection.id,
      metadata: { provider: "SHIPROCKET" },
    });
    res.json({ connected: true, recordsFetched: result.recordsFetched });
  } catch (err) {
    logger.error({ err }, "shiprocket_connect_failed");
    res.status(500).json({ error: "connect_failed" });
  }
});
