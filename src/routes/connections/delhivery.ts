import { Router } from "express";
import { env } from "../../config/env.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { encodeCredentials, generateWebhookToken } from "../../modules/connectors/delhivery/index.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const delhiveryConnectionRouter = Router();

// No OAuth, no self-service webhook-secret field the way Shiprocket has —
// Delhivery's webhook setup is a manual request to their onboarding/support
// team ("provide the endpoint scans should push to"), not a dashboard
// toggle. So instead of asking the merchant for a webhook secret, this
// generates one itself and returns the full webhook URL for the merchant to
// hand to Delhivery — the unguessable token in that URL is the only
// verification mechanism available, since Delhivery's push has no signature
// scheme (see modules/connectors/delhivery).
delhiveryConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  const { apiToken } = req.body ?? {};
  if (!apiToken || typeof apiToken !== "string") {
    res.status(400).json({ error: "missing_api_token" });
    return;
  }

  // Best-effort validation — Delhivery doesn't document a dedicated
  // "verify this token" endpoint, so this probes the track endpoint with a
  // placeholder waybill and only rejects on an auth-specific status.
  const probeUrl = new URL("https://track.delhivery.com/api/v1/packages/json/");
  probeUrl.searchParams.set("waybill", "0");
  const probeRes = await fetch(probeUrl, { headers: { Authorization: `Token ${apiToken}` } });
  if (probeRes.status === 401 || probeRes.status === 403) {
    res.status(400).json({ error: "invalid_credentials" });
    return;
  }

  try {
    const organizationId = req.auth!.organizationId;
    const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
    const webhookToken = generateWebhookToken();
    const credentialsRef = encryptSecret(encodeCredentials({ apiToken, webhookToken }));

    let connection = await prisma.connection.findFirst({
      where: { organizationId, provider: "DELHIVERY" },
    });
    connection = connection
      ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
      : await prisma.connection.create({
          data: {
            organizationId,
            legalEntityId: legalEntity.id,
            provider: "DELHIVERY",
            status: "ACTIVE",
            externalAccountId: "delhivery",
            credentialsRef,
          },
        });

    logger.info({ connectionId: connection.id }, "delhivery_connected");
    // No backfill call — see modules/connectors/delhivery's comment on why
    // there's nothing to pull yet. The webhook URL is what the merchant
    // actually needs next.
    res.json({ connected: true, webhookUrl: `${env.BACKEND_URL}/webhooks/delhivery/${webhookToken}` });
  } catch (err) {
    logger.error({ err }, "delhivery_connect_failed");
    res.status(500).json({ error: "connect_failed" });
  }
});
