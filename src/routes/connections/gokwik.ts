import { Router } from "express";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { encodeCredentials, ingestSettlementReport } from "../../modules/connectors/gokwik/index.js";
import { serializeIngestResult } from "../../modules/connectors/remittance/statement.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { EMAIL_INGEST_ACCOUNT } from "../../modules/ingest/inboundEmail.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const gokwikConnectionRouter = Router();

// GoKwik has TWO independent paths, and they are worth keeping separate
// because only one of them is proven:
//
//   /connect            stores API credentials for order enrichment. The
//                       endpoint shapes come from GoKwik's published material
//                       and have not been exercised against a live merchant
//                       account, so this validates BEST-EFFORT (same posture as
//                       Delhivery) and never blocks on a non-auth failure.
//
//   /:id/settlement     imports the settlement / COD remittance report. This is
//                       the path that actually closes reconciliation, and it
//                       carries none of the above uncertainty — the columns are
//                       defined in this repo and the importer refuses anything
//                       that does not balance.
//
// The consequence, deliberately: a merchant can connect GoKwik and reconcile
// from day one WITHOUT working API credentials, because the settlement import
// needs none. Credentials only buy order enrichment on top.

// Must match the connector's default (production) — a probe that validates
// against one host while syncs run against another verifies nothing.
const GOKWIK_API_HOST = process.env.GOKWIK_API_HOST ?? "https://api.gokwik.co";

gokwikConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  const { merchantId, appId, appSecret } = req.body ?? {};
  if (!merchantId || !appId || !appSecret) {
    res.status(400).json({ error: "missing_credentials" });
    return;
  }

  // Best-effort probe. GoKwik documents no "verify these credentials"
  // endpoint, so this calls the order list with a tiny page and rejects ONLY
  // on an auth-specific status. A 404/5xx (or an unreachable sandbox host)
  // means we could not tell — and refusing the connection in that case would
  // block the settlement import, which does not need these credentials at all.
  let credentialsVerified = false;
  let probeNote: string | null = null;
  try {
    const probe = new URL(`${GOKWIK_API_HOST}/v1/order/list`);
    probe.searchParams.set("mid", String(merchantId));
    probe.searchParams.set("limit", "1");
    const probeRes = await fetch(probe, {
      headers: { appid: String(appId), appsecret: String(appSecret) },
      signal: AbortSignal.timeout(10_000),
    });
    if (probeRes.status === 401 || probeRes.status === 403) {
      res.status(400).json({ error: "invalid_credentials" });
      return;
    }
    // GoKwik returns HTTP 200 with the real outcome inside the body, so
    // `probeRes.ok` alone would report a working connection for a merchant
    // whose order API is not provisioned. Read the envelope.
    if (probeRes.ok) {
      const body = (await probeRes.json().catch(() => ({}))) as { statusCode?: number; statusMessage?: string };
      const code = body.statusCode;
      credentialsVerified = code === undefined || code === 200 || code === 201;
      if (!credentialsVerified) {
        probeNote = `GoKwik accepted the credentials but its order API returned "${body.statusMessage ?? `statusCode ${code}`}". Settlement-report import still works; ask GoKwik to enable order API access for this merchant if you want order enrichment too.`;
      }
    } else {
      probeNote = `GoKwik returned HTTP ${probeRes.status} — credentials stored but unverified.`;
    }
  } catch {
    probeNote = "Could not reach GoKwik to verify credentials — stored unverified. Settlement import works regardless.";
  }

  try {
    const organizationId = req.auth!.organizationId;
    const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
    const credentialsRef = encryptSecret(encodeCredentials({ merchantId, appId, appSecret }));

    // Exclude the email-ingest anchor: a real connect must target (or create)
    // the merchant's OWN credentialed connection, never take over the isolated
    // connection that emailed documents import under.
    let connection = await prisma.connection.findFirst({
      where: { organizationId, provider: "GOKWIK", NOT: { externalAccountId: EMAIL_INGEST_ACCOUNT } },
    });
    connection = connection
      ? await prisma.connection.update({
          where: { id: connection.id },
          data: { credentialsRef, status: "ACTIVE", externalAccountId: String(merchantId) },
        })
      : await prisma.connection.create({
          data: {
            organizationId,
            legalEntityId: legalEntity.id,
            provider: "GOKWIK",
            status: "ACTIVE",
            externalAccountId: String(merchantId),
            credentialsRef,
          },
        });

    logger.info({ connectionId: connection.id, credentialsVerified }, "gokwik_connected");
    res.json({ connected: true, connectionId: connection.id, credentialsVerified, note: probeNote });
  } catch (err) {
    logger.error({ err }, "gokwik_connect_failed");
    res.status(500).json({ error: "connect_failed" });
  }
});

// The reconciliation path. Each row is one COD order GoKwik collected for,
// grouped into the payout that carried the cash to the bank — which is what
// lets a delivered COD shipment be tied to a bank credit instead of guessed at.
gokwikConnectionRouter.post("/:connectionId/settlement", ...requireAuth, async (req, res) => {
  const { csv } = req.body ?? {};
  if (!csv || typeof csv !== "string") {
    res.status(400).json({ error: "missing_csv" });
    return;
  }

  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId, provider: "GOKWIK" },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  try {
    const result = await ingestSettlementReport(toConnectorContext(connection), csv);
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
    logger.info(
      {
        connectionId: connection.id,
        batchesImported: result.batchesImported,
        linesImported: result.linesImported,
        rejected: result.rejected.length,
      },
      "gokwik_settlement_ingested"
    );
    res.json(serializeIngestResult(result));
  } catch (err) {
    logger.error({ err }, "gokwik_settlement_ingest_failed");
    res.status(500).json({ error: "ingest_failed" });
  }
});
