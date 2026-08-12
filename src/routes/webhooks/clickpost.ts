import crypto from "node:crypto";
import { Router } from "express";
import { decryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { clickpostConnector, type ClickPostCredentials } from "../../modules/connectors/clickpost/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";

export const clickpostWebhookRouter = Router();

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

// ClickPost's tracking webhook carries no signature or HMAC (confirmed
// against their docs — the auth options they document are for authenticating
// *to* your endpoint, not for proving a request came from them). Unlike Setu,
// whose notification URL is registered once globally, ClickPost lets you set
// the URL per account — so this uses Delhivery's approach: an unguessable
// token in the path, generated at connect time.
//
// This is also the only way shipments are ever discovered for this provider
// (there's no bulk listing endpoint — see modules/connectors/clickpost), so
// a dropped delivery here means a shipment we simply never learn about until
// a later status update for the same waybill arrives.
clickpostWebhookRouter.post("/:webhookToken", async (req, res) => {
  const rawBody = req.body as Buffer;
  const { webhookToken } = req.params;

  const candidates = await prisma.connection.findMany({ where: { provider: "CLICKPOST", status: "ACTIVE" } });

  // Linear scan across active ClickPost connections, same MVP-scale caveat
  // as Razorpay/Shiprocket/Delhivery's webhook routes (see ARCHITECTURE.md).
  const connection = candidates.find((c) => {
    try {
      const creds = JSON.parse(decryptSecret(c.credentialsRef)) as ClickPostCredentials;
      return timingSafeStringEqual(webhookToken, creds.webhookToken);
    } catch {
      return false;
    }
  });

  if (!connection) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  if (!payload || typeof payload !== "object" || !("waybill" in payload)) {
    // Acknowledge anything unrecognised rather than erroring — a 500 would
    // make ClickPost retry a payload we're never going to understand.
    logger.warn({ payload }, "clickpost_webhook_unrecognized_shape");
    res.json({ received: true });
    return;
  }

  try {
    await clickpostConnector.processEvent(toConnectorContext(connection), payload, "shipment.webhook");
  } catch (err) {
    logger.error({ err }, "clickpost_webhook_processing_failed");
    // Idempotent (Shipment upsert keyed on waybill), safe for ClickPost to retry.
    res.status(500).json({ error: "processing_failed" });
    return;
  }

  res.json({ received: true });
});
