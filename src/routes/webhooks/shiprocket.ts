import crypto from "node:crypto";
import { Router } from "express";
import { decryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { shiprocketConnector, type ShiprocketCredentials } from "../../modules/connectors/shiprocket/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";

export const shiprocketWebhookRouter = Router();

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

// Same shape as Razorpay's webhook problem — Shiprocket's webhook secret is a
// value the merchant picks themselves in their own panel, sent back as a
// header (`x-api-key`, per Shiprocket's support docs) rather than used to
// sign the body with HMAC. So there's no signature to compute — verification
// is a literal, timing-safe comparison against every active Shiprocket
// connection's stored secret. Same MPV-scale linear-scan caveat as Razorpay's
// webhook route; see cfo-docs/ARCHITECTURE.md.
shiprocketWebhookRouter.post("/", async (req, res) => {
  const rawBody = req.body as Buffer;
  const incomingKey = req.header("x-api-key") ?? "";

  if (!incomingKey) {
    res.status(401).json({ error: "missing_key" });
    return;
  }

  const candidates = await prisma.connection.findMany({
    where: { provider: "SHIPROCKET", status: "ACTIVE" },
  });

  const connection = candidates.find((c) => {
    try {
      const creds = JSON.parse(decryptSecret(c.credentialsRef)) as ShiprocketCredentials;
      return timingSafeStringEqual(incomingKey, creds.webhookToken);
    } catch {
      return false;
    }
  });

  if (!connection) {
    res.status(401).json({ error: "invalid_key" });
    return;
  }

  let order: unknown;
  try {
    order = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  try {
    await shiprocketConnector.processEvent(toConnectorContext(connection), order, "order.webhook");
  } catch (err) {
    logger.error({ err }, "shiprocket_webhook_processing_failed");
    // Idempotent (Shipment upsert keyed on externalShipmentId), safe to let Shiprocket retry.
    res.status(500).json({ error: "processing_failed" });
    return;
  }

  res.json({ received: true });
});
