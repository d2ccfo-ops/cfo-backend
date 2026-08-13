import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { shopFromPayload, shopifyConnector } from "../../modules/connectors/shopify/index.js";
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
  const shopDomain = (req.header("x-shopify-shop-domain") ?? "").toLowerCase();

  const verification = shopifyConnector.verifyWebhook(rawBody, headers);
  if (!verification.valid) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  // ---------------------------------------------------------------------------
  // TENANT BINDING — the signature alone does not decide whose books this is
  // ---------------------------------------------------------------------------
  // Shopify's HMAC covers the BODY. The shop-domain header does not, and under
  // the Partner-app model every merchant's webhook is signed with the SAME
  // app-wide secret. So a valid signature proves "some installer of this app
  // sent this", never "THIS shop sent this" — and picking the organisation from
  // the header let any installed merchant replay their own signed delivery with
  // a swapped header to write their orders into a competitor's books.
  //
  // Order payloads state their own shop inside the signed body
  // (order_status_url). Where they do, the header must agree with it, and a
  // disagreement is an attack rather than a quirk — Shopify never sends one.
  const payloadShop = shopFromPayload(payload);
  if (payloadShop && payloadShop !== shopDomain) {
    logger.warn(
      { headerShop: shopDomain, payloadShop, topic: verification.eventType },
      "shopify_webhook_shop_mismatch"
    );
    res.status(401).json({ error: "shop_mismatch" });
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

  // A payload that names no shop of its own (product webhooks) has nothing to
  // cross-check, so the header is the only tenant signal there is. That is
  // acceptable ONLY because the alternative is worse — refusing every product
  // webhook — and because the blast radius is catalogue data, not money. It is
  // recorded so the residual risk is visible in the log rather than implied by
  // the absence of one. The real fix is per-connection webhook secrets, which
  // the Custom App model supports; see verifyShopifyWebhook's note.
  if (!payloadShop) {
    logger.info(
      { shop: shopDomain, topic: verification.eventType, connectionId: connection.id },
      "shopify_webhook_shop_unverifiable_from_payload"
    );
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
