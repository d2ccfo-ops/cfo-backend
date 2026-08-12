import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { shopifyConnector } from "../../modules/connectors/shopify/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";

export const shopifyWebhookRouter = Router();

// Must be mounted with express.raw() (see app.ts) — signature verification
// needs the untouched raw body, same reasoning as the Clerk webhook.
shopifyWebhookRouter.post("/", async (req, res) => {
  const rawBody = req.body as Buffer;
  const headers = {
    "x-shopify-hmac-sha256": req.header("x-shopify-hmac-sha256") ?? "",
    "x-shopify-webhook-id": req.header("x-shopify-webhook-id") ?? "",
    "x-shopify-topic": req.header("x-shopify-topic") ?? "",
  };
  const shopDomain = req.header("x-shopify-shop-domain") ?? "";

  const verification = shopifyConnector.verifyWebhook(rawBody, headers);
  if (!verification.valid) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  const connection = await prisma.connection.findFirst({
    where: { provider: "SHOPIFY", externalAccountId: shopDomain },
  });
  if (!connection) {
    // Unknown shop (e.g. a leftover webhook after uninstall) — acknowledge so
    // Shopify stops retrying, but there's nothing to process it into.
    res.json({ received: true });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  try {
    await prisma.rawEvent.upsert({
      where: {
        connectionId_externalEventId: { connectionId: connection.id, externalEventId: verification.externalEventId },
      },
      create: {
        organizationId: connection.organizationId,
        connectionId: connection.id,
        provider: "SHOPIFY",
        externalEventId: verification.externalEventId,
        eventType: verification.eventType,
        payload: payload as object,
      },
      update: {},
    });

    await shopifyConnector.processEvent(toConnectorContext(connection), payload, verification.eventType);

    await prisma.rawEvent.updateMany({
      where: { connectionId: connection.id, externalEventId: verification.externalEventId },
      data: { processedAt: new Date(), processingStatus: "PROCESSED" },
    });
  } catch (err) {
    logger.error({ err }, "shopify_webhook_processing_failed");
    // Non-2xx on purpose, unlike the Clerk webhook: processing here is
    // idempotent (Order upsert keyed on externalOrderId), so it's safe and
    // correct to let Shopify's retry-with-backoff do its job on failure.
    res.status(500).json({ error: "processing_failed" });
    return;
  }

  res.json({ received: true });
});
