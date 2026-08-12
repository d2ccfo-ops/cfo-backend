import { Router } from "express";
import type { Provider } from "@prisma/client";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { importAdSpendCsv } from "../../modules/connectors/adspend/csv.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const adSpendCsvRouter = Router();

// CSV-mode ad-spend connections, for Meta Ads and Google Ads.
//
// The OAuth connectors remain the right long-term path, but both are gated on
// an app that has cleared platform review. This lets a founder register an ad
// account and upload the export instead, writing the SAME AdSpend rows the API
// connectors write — so /metrics/ad-spend and the Expenses page cannot tell
// which route the numbers came from.
//
// A CSV-mode connection is deliberately given no credentials (an encrypted
// marker, mirroring the BANK connector) so the sync worker has nothing to poll
// with and will never silently overwrite imported rows with an empty API pull.

const SLUG_TO_PROVIDER: Record<string, Provider> = {
  "meta-ads": "META_ADS",
  "google-ads": "GOOGLE_ADS",
};

function resolveProvider(slug: string): Provider | null {
  return SLUG_TO_PROVIDER[slug] ?? null;
}

adSpendCsvRouter.post("/:slug/connect", ...requireAuth, async (req, res) => {
  const provider = resolveProvider(req.params.slug ?? "");
  if (!provider) {
    res.status(404).json({ error: "unknown_provider" });
    return;
  }
  // OPTIONAL. Nothing in an ad-spend export needs the user to name the account:
  // where the file states one it is read from the file, and where it does not,
  // a hand-typed id could not have been validated against the file anyway — it
  // would just be an unverifiable label that a typo silently corrupts. Kept only
  // as a way to separate several ad accounts by hand if someone wants to.
  const raw = (req.body ?? {}).accountId;
  const externalAccountId = typeof raw === "string" && raw.trim() ? raw.trim() : "csv-upload";

  try {
    const organizationId = req.auth!.organizationId;
    const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
    // Scoped by externalAccountId so a merchant running several ad accounts
    // gets one connection each rather than silently overwriting the first.
    let connection = await prisma.connection.findFirst({
      where: { organizationId, provider, externalAccountId },
    });
    connection =
      connection ??
      (await prisma.connection.create({
        data: {
          organizationId,
          legalEntityId: legalEntity.id,
          provider,
          status: "ACTIVE",
          externalAccountId,
          credentialsRef: encryptSecret(JSON.stringify({ mode: "csv" })),
        },
      }));

    logger.info({ connectionId: connection.id, provider }, "ad_spend_csv_connected");
    res.json({ connected: true, connectionId: connection.id, externalAccountId });
  } catch (err) {
    logger.error({ err }, "ad_spend_csv_connect_failed");
    res.status(500).json({ error: "connect_failed" });
  }
});

adSpendCsvRouter.post("/:slug/:connectionId/upload", ...requireAuth, async (req, res) => {
  const provider = resolveProvider(req.params.slug ?? "");
  if (!provider) {
    res.status(404).json({ error: "unknown_provider" });
    return;
  }
  const { csv } = req.body ?? {};
  if (!csv || typeof csv !== "string") {
    res.status(400).json({ error: "missing_csv" });
    return;
  }

  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId, provider },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  try {
    const result = await importAdSpendCsv(
      {
        connectionId: connection.id,
        organizationId: connection.organizationId,
        legalEntityId: connection.legalEntityId,
        externalAccountId: connection.externalAccountId ?? "",
        provider,
      },
      csv
    );
    // Only stamp a sync time when something actually landed — an import that
    // refused the file must not make the card read "synced just now".
    if (result.daysImported > 0) {
      await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
    }
    logger.info(
      { connectionId: connection.id, provider, days: result.daysImported, errors: result.errors.length },
      "ad_spend_csv_imported"
    );
    res.json({ ...result, totalSpendPaise: result.totalSpendPaise.toString() });
  } catch (err) {
    logger.error({ err }, "ad_spend_csv_import_failed");
    res.status(500).json({ error: "import_failed" });
  }
});
