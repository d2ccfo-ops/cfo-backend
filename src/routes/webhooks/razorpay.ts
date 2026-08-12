import { Router } from "express";
import { decryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { razorpayConnector, verifyRazorpaySignature, type RazorpayCredentials } from "../../modules/connectors/razorpay/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";

export const razorpayWebhookRouter = Router();

// Razorpay has no platform-wide signing secret (see modules/connectors/razorpay/
// for why) — each connection has its own, set by the merchant in their own
// Razorpay dashboard. There's no cheap way to know which connection a given
// delivery belongs to before verifying, so this tries every active Razorpay
// connection's secret. Fine at MVP scale (tens/hundreds of connections); if
// that stops being true, this needs Razorpay's account_id (present in the
// payload) matched against a stored value instead of a linear scan.
razorpayWebhookRouter.post("/", async (req, res) => {
  const rawBody = req.body as Buffer;
  const signature = req.header("x-razorpay-signature") ?? "";

  const candidates = await prisma.connection.findMany({
    where: { provider: "RAZORPAY", status: "ACTIVE" },
  });

  const connection = candidates.find((c) => {
    try {
      const creds = JSON.parse(decryptSecret(c.credentialsRef)) as RazorpayCredentials;
      return verifyRazorpaySignature(rawBody, signature, creds.webhookSecret);
    } catch {
      return false;
    }
  });

  if (!connection) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  let body: { event?: string; payload?: Record<string, { entity?: unknown }> };
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  const eventName = body.event ?? "unknown";
  const entityKind = eventName.startsWith("payment.") ? "payment" : eventName.startsWith("settlement.") ? "settlement" : null;
  const entity = entityKind ? body.payload?.[entityKind]?.entity : null;

  if (!entityKind || !entity || typeof entity !== "object" || !("id" in entity)) {
    // Acknowledge events we don't map yet (refunds, disputes, ...) rather than erroring.
    res.json({ received: true });
    return;
  }

  const externalEventId = `${entityKind}_${(entity as { id: string }).id}`;

  try {
    await prisma.rawEvent.upsert({
      where: { connectionId_externalEventId: { connectionId: connection.id, externalEventId } },
      create: {
        organizationId: connection.organizationId,
        connectionId: connection.id,
        provider: "RAZORPAY",
        externalEventId,
        eventType: eventName,
        payload: entity as object,
      },
      update: {},
    });

    await razorpayConnector.processEvent(toConnectorContext(connection), entity, `${entityKind}.webhook`);

    await prisma.rawEvent.updateMany({
      where: { connectionId: connection.id, externalEventId },
      data: { processedAt: new Date(), processingStatus: "PROCESSED" },
    });
  } catch (err) {
    logger.error({ err }, "razorpay_webhook_processing_failed");
    // Idempotent (Payment/Settlement upsert), so it's safe to let Razorpay retry.
    res.status(500).json({ error: "processing_failed" });
    return;
  }

  res.json({ received: true });
});
