import { Router } from "express";
import { env } from "../../config/env.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  activateConsentConnection,
  createConsent,
  encodeCredentials,
  getConsentStatus,
  pollPendingDataSessions,
} from "../../modules/connectors/setu/index.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const setuConnectionRouter = Router();

const MOBILE_RE = /^[6-9]\d{9}$/; // Indian mobile numbers: 10 digits, starts 6-9

// Step 1 — create the consent request and hand back Setu's approval URL.
// Unlike every OAuth connector, the connection starts PENDING, not ACTIVE:
// nothing has actually been approved yet, and won't be until the founder
// finishes the approval flow in their own AA app at the returned URL.
setuConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  if (!env.SETU_CLIENT_ID || !env.SETU_CLIENT_SECRET || !env.SETU_PRODUCT_INSTANCE_ID) {
    res.status(503).json({ error: "setu_not_configured" });
    return;
  }

  const { mobileNumber } = req.body ?? {};
  if (typeof mobileNumber !== "string" || !MOBILE_RE.test(mobileNumber)) {
    res.status(400).json({ error: "invalid_mobile_number" });
    return;
  }

  const organizationId = req.auth!.organizationId;
  const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
  const dataRangeFrom = new Date(Date.now() - 12 * 30 * 24 * 60 * 60 * 1000);
  const redirectUrl = `${env.FRONTEND_URL}/connections?setu=return`;

  let consent;
  try {
    consent = await createConsent(mobileNumber, dataRangeFrom, redirectUrl);
  } catch (err) {
    logger.error({ err }, "setu_create_consent_failed");
    res.status(502).json({ error: "setu_unreachable" });
    return;
  }

  const credentialsRef = encryptSecret(encodeCredentials({ consentId: consent.id, vua: mobileNumber }));

  // externalAccountId carries the consentId in plaintext (not inside
  // credentialsRef) so routes/webhooks/setu.ts can look up the owning
  // Connection with a direct indexed query instead of a linear
  // decrypt-and-scan — same trick Meta Ads uses for ad account id.
  const connection = await prisma.connection.create({
    data: {
      organizationId,
      legalEntityId: legalEntity.id,
      provider: "BANK_AA",
      status: "PENDING",
      externalAccountId: consent.id,
      credentialsRef,
    },
  });

  res.json({ connectionId: connection.id, redirectUrl: consent.url });
});

// Fallback for when Setu's consent-notification webhook can't reach us (most
// commonly: local/sandbox dev with no public URL registered) — the frontend
// polls this after the founder returns from Setu's approval screen. Falls
// back to a live query against Setu itself rather than just re-reading our
// own possibly-stale Connection.status.
setuConnectionRouter.get("/:connectionId/status", ...requireAuth, async (req, res) => {
  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId, provider: "BANK_AA" },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  if (connection.status !== "PENDING") {
    // Already approved. Keep draining any data session that hasn't been
    // fetched yet — an FI session usually isn't ready at the moment the
    // consent flips ACTIVE, so without this the poll would return ACTIVE
    // immediately and never actually ingest anything on a local backend.
    if (connection.status === "ACTIVE") {
      try {
        const ingested = await pollPendingDataSessions(connection.id);
        res.json({ status: connection.status, ...ingested });
        return;
      } catch (err) {
        logger.error({ err }, "setu_data_session_poll_failed");
      }
    }
    res.json({ status: connection.status });
    return;
  }

  try {
    const consentStatus = await getConsentStatus(connection.externalAccountId ?? "");
    if (consentStatus.status === "ACTIVE") {
      await activateConsentConnection(connection);
      // activateConsentConnection only *requests* a data session — the data
      // itself normally arrives via Setu's FI notification, which cannot
      // reach a local/sandbox backend. Driving it from the poll too is what
      // makes this work without a public webhook URL. It's usually still
      // PENDING on this first call; the frontend keeps polling, and a later
      // call picks it up once the FIP has responded.
      const ingested = await pollPendingDataSessions(connection.id);
      res.json({ status: "ACTIVE", ...ingested });
      return;
    }
    if (["REJECTED", "EXPIRED"].includes(consentStatus.status)) {
      await prisma.connection.update({ where: { id: connection.id }, data: { status: "ERROR" } });
      res.json({ status: "ERROR" });
      return;
    }
    if (consentStatus.status === "REVOKED") {
      await prisma.connection.update({ where: { id: connection.id }, data: { status: "DISCONNECTED" } });
      res.json({ status: "DISCONNECTED" });
      return;
    }
    res.json({ status: "PENDING" });
  } catch (err) {
    logger.error({ err }, "setu_status_poll_failed");
    res.json({ status: "PENDING" }); // don't fail the poll — the founder will just see "still pending" and can retry
  }
});
