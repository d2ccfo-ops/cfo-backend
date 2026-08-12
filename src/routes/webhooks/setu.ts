import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { activateConsentConnection, processDataSession } from "../../modules/connectors/setu/index.js";

export const setuWebhookRouter = Router();

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

// Setu has no documented webhook signature scheme, and — unlike Delhivery's
// per-connection URL token — the notification URL for AA is registered once,
// globally, in Setu's Bridge console, not per connection. So the URL we
// register there is `${BACKEND_URL}/webhooks/setu?key=<SETU_WEBHOOK_SECRET>`
// — a shared secret we mint ourselves, checked on every inbound call. Same
// "bolted-on protection because the provider gives us none" situation as
// Delhivery, just platform-wide instead of per-resource.
//
// Setu sends two different notification shapes to the same URL: consent
// status updates and FI (data session) readiness. Field names below are
// best-effort against Setu's docs, which describe the payloads at a high
// level but don't give exact field names — NOT yet verified against a real
// webhook call. Check this against an actual sandbox delivery before relying
// on it in production (see cfo-docs/PROGRESS.md).
interface SetuWebhookPayload {
  consentId?: string;
  consentStatus?: string;
  dataSessionId?: string;
  sessionStatus?: string;
  status?: string; // some payload variants may carry either notification's status under a bare `status` key
}

setuWebhookRouter.post("/", async (req, res) => {
  const secret = env.SETU_WEBHOOK_SECRET;
  const key = typeof req.query.key === "string" ? req.query.key : "";
  if (!secret || !timingSafeStringEqual(key, secret)) {
    res.status(401).json({ error: "invalid_key" });
    return;
  }

  const rawBody = req.body as Buffer;
  let payload: SetuWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  try {
    if (payload.consentId) {
      await handleConsentNotification(payload.consentId, payload.consentStatus ?? payload.status ?? "");
    } else if (payload.dataSessionId) {
      await handleFiNotification(payload.dataSessionId, payload.sessionStatus ?? payload.status ?? "");
    } else {
      logger.warn({ payload }, "setu_webhook_unrecognized_shape");
    }
  } catch (err) {
    logger.error({ err }, "setu_webhook_processing_failed");
    // Idempotent (consent activation short-circuits if already ACTIVE;
    // BankTransaction upsert is keyed on externalTxnId) — safe for Setu to
    // retry, if they retry at all (their docs note retry policy is TBD).
    res.status(500).json({ error: "processing_failed" });
    return;
  }

  res.json({ received: true });
});

async function handleConsentNotification(consentId: string, status: string): Promise<void> {
  const connection = await prisma.connection.findFirst({ where: { provider: "BANK_AA", externalAccountId: consentId } });
  if (!connection) {
    logger.warn({ consentId }, "setu_consent_notification_no_matching_connection");
    return;
  }

  if (status === "ACTIVE") {
    await activateConsentConnection(connection);
  } else if (status === "REJECTED" || status === "EXPIRED") {
    await prisma.connection.update({ where: { id: connection.id }, data: { status: "ERROR" } });
  } else if (status === "REVOKED") {
    await prisma.connection.update({ where: { id: connection.id }, data: { status: "DISCONNECTED" } });
  }
  // PAUSED and anything unrecognized: leave connection status as-is, just log.
}

async function handleFiNotification(dataSessionId: string, sessionStatus: string): Promise<void> {
  const session = await prisma.bankAaDataSession.findUnique({ where: { id: dataSessionId } });
  if (!session) {
    logger.warn({ dataSessionId }, "setu_fi_notification_no_matching_session");
    return;
  }
  if (sessionStatus !== "PARTIAL" && sessionStatus !== "COMPLETED") {
    // FAILED/EXPIRED/PENDING: nothing to fetch, but still record what the
    // notification claimed so the session isn't left looking stuck.
    await prisma.bankAaDataSession.update({ where: { id: dataSessionId }, data: { status: sessionStatus } });
    return;
  }

  // All the actual work (fetch, flatten fips[].accounts[], ingest, set the
  // opening-balance anchor) lives in processDataSession so the status-poll
  // fallback in routes/connections/setu.ts runs exactly the same path.
  const result = await processDataSession(dataSessionId);
  if (result.processed && result.accounts === 0) {
    logger.warn({ dataSessionId, status: result.status }, "setu_fi_data_no_accounts_in_session");
  }
  logger.info({ dataSessionId, ...result }, "setu_fi_data_processed");
}
