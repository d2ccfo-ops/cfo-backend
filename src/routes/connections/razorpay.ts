import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { encryptSecret } from "../../lib/crypto.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { encodeCredentials, razorpayConnector } from "../../modules/connectors/razorpay/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const razorpayConnectionRouter = Router();

// No OAuth — Razorpay is API-key based, so this is a single authenticated
// request rather than an install/callback redirect pair like Shopify's.
razorpayConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  const { keyId, keySecret, webhookSecret } = req.body ?? {};
  if (!keyId || !keySecret || !webhookSecret) {
    res.status(400).json({ error: "missing_credentials" });
    return;
  }

  // Validate the key pair actually works before saving anything.
  const testAuth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const testRes = await fetch("https://api.razorpay.com/v1/payments?count=1", {
    headers: { Authorization: testAuth },
  });
  if (!testRes.ok) {
    res.status(400).json({ error: "invalid_credentials" });
    return;
  }

  try {
    const organizationId = req.auth!.organizationId;
    const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
    const credentialsRef = encryptSecret(encodeCredentials({ keyId, keySecret, webhookSecret }));

    let connection = await prisma.connection.findFirst({
      where: { organizationId, provider: "RAZORPAY", externalAccountId: keyId },
    });
    connection = connection
      ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
      : await prisma.connection.create({
          data: {
            organizationId,
            legalEntityId: legalEntity.id,
            provider: "RAZORPAY",
            status: "ACTIVE",
            externalAccountId: keyId,
            credentialsRef,
          },
        });

    // Inline for now, same trade-off as Shopify's backfill — see cfo-docs/PROGRESS.md.
    const result = await razorpayConnector.backfill(toConnectorContext(connection));
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });

    logger.info({ connectionId: connection.id, recordsFetched: result.recordsFetched }, "razorpay_backfill_complete");
    res.json({ connected: true, recordsFetched: result.recordsFetched });
  } catch (err) {
    logger.error({ err }, "razorpay_connect_failed");
    res.status(500).json({ error: "connect_failed" });
  }
});
