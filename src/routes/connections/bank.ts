import { Router } from "express";
import { invalidateOrgReads } from "../../lib/orgReadCache.js";
import { checkCsv } from "../../lib/uploadGuard.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { writeAudit } from "../../lib/audit.js";
import { ingestStatement } from "../../modules/connectors/bank/index.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";

export const bankConnectionRouter = Router();

// No credential to validate against an external service — this just
// registers which account statements will be uploaded for. credentialsRef
// still goes through encryptSecret() for consistency with every other
// connector, even though bankName/accountLast4 aren't really secret.
bankConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  const { bankName, accountLast4 } = req.body ?? {};
  if (!bankName || !accountLast4) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }

  const organizationId = req.auth!.organizationId;
  const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
  const externalAccountId = `${bankName} •••${accountLast4}`;
  const credentialsRef = encryptSecret(JSON.stringify({ bankName, accountLast4 }));

  let connection = await prisma.connection.findFirst({
    where: { organizationId, provider: "BANK", externalAccountId },
  });
  connection = connection
    ? await prisma.connection.update({ where: { id: connection.id }, data: { credentialsRef, status: "ACTIVE" } })
    : await prisma.connection.create({
        data: {
          organizationId,
          legalEntityId: legalEntity.id,
          provider: "BANK",
          status: "ACTIVE",
          externalAccountId,
          credentialsRef,
        },
      });

  await writeAudit({
    organizationId,
    actorType: "USER",
    actorId: req.auth!.userId,
    action: "connection.credential_set",
    entityType: "CONNECTION",
    entityId: connection.id,
    metadata: { provider: "BANK", externalAccountId },
  });

  res.json({ connected: true, connectionId: connection.id });
});

// Opening-balance anchor is set via PATCH /connections/:connectionId/opening-balance
// on the generic connectionsRouter now (routes/connections/index.ts) — BANK_AA
// needs the exact same endpoint, so it moved there instead of being
// duplicated per provider.

bankConnectionRouter.post("/:connectionId/upload", ...requireAuth, async (req, res) => {
  const { csv } = req.body ?? {};
  if (!csv || typeof csv !== "string") {
    res.status(400).json({ error: "missing_csv" });
    return;
  }

  // §27 (P5.7). A portal export that silently returned a login page parses as
  // a one-column CSV perfectly happily, and the downstream failure is "0 rows"
  // — which everyone reads as "the account is empty". Checked here so the
  // error names the actual problem.
  const upload = checkCsv(csv);
  if (!upload.ok) {
    res.status(400).json({ error: "invalid_upload", message: upload.reason, detectedType: upload.detectedType ?? null });
    return;
  }

  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId, provider: "BANK" },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  try {
    const result = await ingestStatement(toConnectorContext(connection), csv);
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
    invalidateOrgReads(connection.organizationId);
    logger.info(
      { connectionId: connection.id, recordsFetched: result.recordsFetched, skipped: result.skipped },
      "bank_statement_ingested"
    );
    await writeAudit({
      organizationId: req.auth!.organizationId,
      actorType: "USER",
      actorId: req.auth!.userId,
      action: "import.bank_statement",
      entityType: "CONNECTION",
      entityId: connection.id,
      metadata: { recordsFetched: result.recordsFetched, skipped: result.skipped },
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "bank_statement_ingest_failed");
    res.status(500).json({ error: "ingest_failed" });
  }
});
