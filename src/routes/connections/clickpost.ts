import { Router } from "express";
import { env } from "../../config/env.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { encodeCredentials, generateWebhookToken } from "../../modules/connectors/clickpost/index.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const clickpostConnectionRouter = Router();

// Same shape as Delhivery's connect route: no OAuth, and no merchant-supplied
// webhook secret either. ClickPost lets you set an arbitrary webhook URL per
// account in its dashboard but documents no signature scheme, so this
// generates an unguessable token itself and returns the full URL for the
// merchant to paste into ClickPost — that URL *is* the verification, shown
// once like an API secret rather than retrievable later via GET /connections.
clickpostConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  const { username, apiKey } = req.body ?? {};
  if (typeof username !== "string" || !username.trim() || typeof apiKey !== "string" || !apiKey.trim()) {
    res.status(400).json({ error: "missing_credentials" });
    return;
  }

  // ClickPost documents no dedicated "validate these credentials" endpoint,
  // so this probes the tracking endpoint with a placeholder waybill and only
  // rejects on an auth-specific status — same best-effort approach as
  // Delhivery's connect route, for the same reason. A 400/404 here means the
  // credentials were accepted and only the waybill was bad, which is exactly
  // what we want to see.
  const probeUrl = new URL("https://api.clickpost.in/api/v2/track-order/");
  probeUrl.searchParams.set("username", username.trim());
  probeUrl.searchParams.set("key", apiKey.trim());
  probeUrl.searchParams.set("waybill", "0");
  probeUrl.searchParams.set("cp_id", "1");

  try {
    const probe = await fetch(probeUrl);
    if (probe.status === 401 || probe.status === 403) {
      res.status(400).json({ error: "invalid_credentials" });
      return;
    }
  } catch (err) {
    logger.error({ err }, "clickpost_probe_failed");
    res.status(502).json({ error: "clickpost_unreachable" });
    return;
  }

  try {
    const organizationId = req.auth!.organizationId;
    const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
    const webhookToken = generateWebhookToken();
    const credentialsRef = encryptSecret(encodeCredentials({ username: username.trim(), apiKey: apiKey.trim(), webhookToken }));

    let connection = await prisma.connection.findFirst({ where: { organizationId, provider: "CLICKPOST" } });
    connection = connection
      ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
      : await prisma.connection.create({
          data: {
            organizationId,
            legalEntityId: legalEntity.id,
            provider: "CLICKPOST",
            status: "ACTIVE",
            externalAccountId: username.trim(),
            credentialsRef,
          },
        });

    logger.info({ connectionId: connection.id }, "clickpost_connected");
    // No backfill call — ClickPost has no endpoint that enumerates shipments,
    // so there is nothing to pull (see modules/connectors/clickpost). The
    // webhook URL is what the merchant actually needs next.
    res.json({ connected: true, webhookUrl: `${env.BACKEND_URL}/webhooks/clickpost/${webhookToken}` });
  } catch (err) {
    logger.error({ err }, "clickpost_connect_failed");
    res.status(500).json({ error: "connect_failed" });
  }
});
