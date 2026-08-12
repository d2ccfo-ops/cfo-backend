import { Router } from "express";
import { env } from "../../config/env.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  encodeCredentials,
  fetchToken,
  ingestCodRemittance,
  trackingLicenceKey as trackingLicenceKeyOf,
} from "../../modules/connectors/bluedart/index.js";
import { ingestInvoicePdfDocument } from "../../modules/connectors/bluedart/invoice.js";
import { serializeIngestResult } from "../../modules/connectors/remittance/statement.js";
import { toConnectorContext } from "../../modules/connectors/types.js";
import { EMAIL_INGEST_ACCOUNT } from "../../modules/ingest/inboundEmail.js";
import { getOrCreateDefaultLegalEntity } from "../../modules/orgs/legalEntity.js";
import crypto from "node:crypto";

export const bluedartConnectionRouter = Router();

// Same two-path split as GoKwik, for the same reason: tracking is an API whose
// shape is only as good as the published spec, while COD remittance is a
// document this repo defines the columns for.
//
// Bluedart issues up to four values, from two different places: the older
// loginId/licenceKey that an account manager sends, and a ClientID/clientSecret
// pair registered separately on the DHL developer portal.
//
// Only the first two are required. This route used to demand all four, which
// blocked a merchant who had been issued exactly the pair an account manager
// hands out — and the gateway mints a token without the ClientID pair at all.

bluedartConnectionRouter.post("/connect", ...requireAuth, async (req, res) => {
  const { clientId, clientSecret, licenceKey, trackingLicenceKey, loginId } = req.body ?? {};
  // Only two are genuinely required. Bluedart issues the ClientID/secret pair
  // separately from the developer portal and many merchants are given just the
  // licence key and login id by their account manager — and tracking works with
  // those two alone (see the note on BluedartCredentials). Demanding four was
  // blocking a connection that would have worked.
  if (!licenceKey || !loginId) {
    res.status(400).json({ error: "missing_credentials", need: ["licenceKey", "loginId"] });
    return;
  }
  // One without the other is a half-entered pair, not a choice. Storing it would
  // send exactly the header combination the gateway 401s on.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    res.status(400).json({ error: "incomplete_client_pair" });
    return;
  }

  const creds = {
    ...(clientId ? { clientId: String(clientId) } : {}),
    ...(clientSecret ? { clientSecret: String(clientSecret) } : {}),
    licenceKey: String(licenceKey),
    // Bluedart's onboarding sheet lists `tracking_license_key` as a field of
    // its own, distinct from `license_key`. Optional, because plenty of
    // accounts are issued only one.
    ...(trackingLicenceKey ? { trackingLicenceKey: String(trackingLicenceKey) } : {}),
    loginId: String(loginId),
  };

  // The token endpoint CANNOT verify these, and believing it could was wrong:
  // probed live, it mints a valid JWT to a caller sending no headers at all, so
  // "it returned 200" said nothing about the licence key — the only credential
  // that matters for tracking.
  //
  // So the probe now asks the tracking endpoint about a real waybill and reads
  // what comes back. `License Mismatch` is Bluedart telling us the key is wrong,
  // which is a genuine credential failure worth blocking on. Anything else is
  // stored, because a network hiccup must not be reported as a bad key.
  let credentialsVerified = false;
  let probeNote: string | null = null;
  try {
    const token = await fetchToken(creds);
    const probeAwb = await prisma.shipment.findFirst({
      where: { organizationId: req.auth!.organizationId, courierName: { contains: "luedart", mode: "insensitive" }, awbCode: { not: null } },
      select: { awbCode: true },
      orderBy: { createdAt: "desc" },
    });
    if (!probeAwb?.awbCode) {
      probeNote = "No Bluedart waybill exists yet to test the licence key against — credentials stored unverified.";
    } else {
      const url = new URL("https://apigateway.bluedart.com/in/transportation/tracking/v1");
      for (const [k, v] of Object.entries({
        // `verno` omitted deliberately — see the note in the connector: sending
        // it returns "License Mismatch" for every waybill, valid key or not.
        handler: "tnt", loginid: creds.loginId, numbers: probeAwb.awbCode, format: "xml",
        lickey: trackingLicenceKeyOf(creds), scan: "1", action: "custawbquery", awb: "awb",
      })) url.searchParams.set(k, v);

      const probeRes = await fetch(url, {
        headers: { JWTToken: token, Accept: "application/xml" },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await probeRes.text();
      const stated = text.match(/<Error>([^<]*)<\/Error>/)?.[1]?.trim();

      // NOTHING this endpoint returns can verify a credential, and two earlier
      // versions of this code claimed otherwise. Measured against the live
      // gateway with a deliberately invalid licence key, a garbage login id and
      // a waybill that does not exist — all six variants returned the SAME
      // 148-byte body:
      //
      //   <ShipmentData><Error>Incorrect waybill number or No information</Error></ShipmentData>
      //
      // So "no information" is not Bluedart accepting the licence, and
      // "License Mismatch" is not Bluedart rejecting it — that string appears
      // when `loginid` is omitted entirely or when `verno` is sent, and does
      // NOT appear for a bogus licence key. Blocking a connection on either
      // string would reject credentials that may be perfectly good.
      //
      // Everything is therefore stored, with a note that says plainly that the
      // probe proves nothing. An honest "unverified" beats a confident wrong
      // diagnosis sending the merchant to argue the wrong point with support.
      if (stated && /incorrect waybill|no information|license\s*mismatch/i.test(stated)) {
        probeNote =
          `Stored, but not verified — Bluedart's tracking endpoint cannot confirm credentials. ` +
          `It replied "${stated}" for waybill ${probeAwb.awbCode}, and returns that same response to a request ` +
          `carrying a deliberately invalid licence key, so it says nothing about whether yours is right. ` +
          `No shipment data has ever been returned by this API. Freight cost comes from the tax-invoice PDF upload ` +
          `and COD from the remittance MIS upload; both work regardless.`;
      } else if (stated) {
        probeNote = `Bluedart replied: "${stated}". Credentials stored unverified.`;
      } else if (!probeRes.ok) {
        probeNote = `Bluedart's gateway returned ${probeRes.status}. Credentials stored unverified — this is a gateway fault, not a rejected key.`;
      }
      credentialsVerified = probeRes.ok && !stated;
    }
  } catch (err) {
    probeNote = `Could not reach Bluedart to verify the licence key — stored unverified. COD MIS import works regardless. (${(err as Error).message})`;
  }

  try {
    const organizationId = req.auth!.organizationId;
    const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
    // Bluedart's push tracking carries no signature scheme, so an unguessable
    // URL token is the only verification available — same as Delhivery.
    const webhookToken = crypto.randomBytes(24).toString("hex");
    const credentialsRef = encryptSecret(encodeCredentials(creds));

    // Exclude the email-ingest anchor: a real connect targets (or creates) the
    // merchant's own credentialed connection, never the isolated one that
    // emailed documents import under.
    let connection = await prisma.connection.findFirst({
      where: { organizationId, provider: "BLUEDART", NOT: { externalAccountId: EMAIL_INGEST_ACCOUNT } },
    });
    connection = connection
      ? await prisma.connection.update({
          where: { id: connection.id },
          // externalAccountId must move with the credentials. Re-connecting
          // under a different login id used to leave the OLD one on the record,
          // and that field is what the Connections page prints as the account —
          // so the screen would keep naming an account the connector had stopped
          // using, which is the worst kind of stale: confidently specific.
          data: { credentialsRef, externalAccountId: creds.loginId, status: "ACTIVE" },
        })
      : await prisma.connection.create({
          data: {
            organizationId,
            legalEntityId: legalEntity.id,
            provider: "BLUEDART",
            status: "ACTIVE",
            externalAccountId: creds.loginId,
            credentialsRef,
          },
        });

    logger.info({ connectionId: connection.id, credentialsVerified }, "bluedart_connected");
    res.json({
      connected: true,
      connectionId: connection.id,
      credentialsVerified,
      note: probeNote,
      webhookUrl: `${env.BACKEND_URL}/webhooks/bluedart/${webhookToken}`,
    });
  } catch (err) {
    logger.error({ err }, "bluedart_connect_failed");
    res.status(500).json({ error: "connect_failed" });
  }
});

// The freight TAX INVOICE, as PDF. Bluedart bills as PDF and offers no CSV
// annexure for most accounts, and `Shipment.freightAmount` has no other source
// at all — so this is the only route by which shipping cost, the second half of
// contribution margin, ever enters the system.
//
// Deliberately a SEPARATE endpoint from /remittance. An invoice says what
// Bluedart charged us; a remittance says what Bluedart collected and paid us.
// Sharing a route would invite uploading one as the other, which turns a cost
// into income.
/**
 * Parses one PDF and applies it, or returns why it was refused.
 *
 * Returns a per-file outcome rather than throwing, because a batch of twelve
 * invoices where the ninth is a scan of a delivery note must still import the
 * other eleven — an all-or-nothing batch would make the merchant bisect their
 * own folder to find the bad file.
 *
 * The parse-check-apply pipeline itself lives in the invoice module
 * (ingestInvoicePdfDocument), shared with the inbound-email path so the
 * refusal rules exist exactly once.
 */
async function ingestOnePdf(
  connection: { id: string; organizationId: string; legalEntityId: string },
  pdfBase64: string,
  fileName: string | undefined
) {
  return ingestInvoicePdfDocument(connection, Buffer.from(pdfBase64, "base64"), fileName);
}

bluedartConnectionRouter.post("/:connectionId/invoice", ...requireAuth, async (req, res) => {
  const { pdfBase64 } = req.body ?? {};
  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    res.status(400).json({ error: "missing_pdf" });
    return;
  }

  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId, provider: "BLUEDART" },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  try {
    const outcome = await ingestOnePdf(connection, pdfBase64, undefined);
    if (!outcome.ok) {
      res.status(422).json(outcome);
      return;
    }
    logger.info(
      { connectionId: connection.id, invoiceNo: outcome.invoiceNo, linesParsed: outcome.linesParsed },
      "bluedart_invoice_ingested"
    );
    res.json(outcome);
  } catch (err) {
    logger.error({ err }, "bluedart_invoice_ingest_failed");
    res.status(500).json({ error: "ingest_failed" });
  }
});

// Many invoices at once. Bluedart bills monthly and per product line — this
// store has a COD invoice and a prepaid invoice every month — so catching up on
// a year means uploading a couple of dozen PDFs, and doing that one at a time
// through a single-file control is how a merchant gives up halfway.
//
// Files are processed SEQUENTIALLY rather than in parallel: two invoices in the
// same batch routinely bill the same AWB (outbound on one, return leg on the
// next), and the per-shipment freight total is recomputed from all lines, so
// concurrent applies would race on the same shipment row.
const MAX_FILES_PER_BATCH = 40;

bluedartConnectionRouter.post("/:connectionId/invoices", ...requireAuth, async (req, res) => {
  const { files } = req.body ?? {};
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "missing_files" });
    return;
  }
  if (files.length > MAX_FILES_PER_BATCH) {
    res.status(413).json({ error: "too_many_files", max: MAX_FILES_PER_BATCH, received: files.length });
    return;
  }

  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId, provider: "BLUEDART" },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  type Outcome =
    | Awaited<ReturnType<typeof ingestOnePdf>>
    | { ok: false; fileName?: string; error: string; detail?: string };
  const results: Outcome[] = [];
  for (const file of files) {
    const fileName = typeof file?.name === "string" ? file.name : undefined;
    if (!file?.pdfBase64 || typeof file.pdfBase64 !== "string") {
      results.push({ ok: false, fileName, error: "missing_pdf" });
      continue;
    }
    try {
      results.push(await ingestOnePdf(connection, file.pdfBase64, fileName));
    } catch (err) {
      // One unreadable PDF must not lose the invoices already applied above it.
      logger.error({ err, fileName }, "bluedart_invoice_ingest_failed");
      results.push({ ok: false, fileName, error: "unreadable_pdf", detail: (err as Error).message });
    }
  }

  const imported = results.filter((r): r is Extract<Outcome, { ok: true }> => r.ok);

  // Totals are computed over DISTINCT INVOICES, not over files.
  //
  // Selecting the same invoice twice — the same PDF picked twice, or a folder
  // holding a duplicate — is completely normal and the import handles it: the
  // second apply replaces the first, and the database ends up holding one
  // invoice. Summing per-file would then report double the freight for money
  // that was only ever charged once, which is exactly the failure this whole
  // feature exists to prevent. Measured on a real upload: two copies of one
  // invoice reported ₹1,24,950 across 1,166 shipments for what is really
  // ₹62,475 across 583.
  //
  // Last occurrence wins on the figures, because that is the write that
  // survived — but `replacedExisting` is taken from the FIRST, since a second
  // copy in the same batch always replaces the first one and reporting that as
  // "replaced an earlier upload" would claim the merchant had uploaded this
  // invoice before when they had not.
  const byInvoice = new Map<string, Extract<Outcome, { ok: true }>>();
  for (const r of imported) {
    const first = byInvoice.get(r.invoiceNo);
    byInvoice.set(r.invoiceNo, first ? { ...r, replacedExisting: first.replacedExisting } : r);
  }
  const distinct = [...byInvoice.values()];
  const duplicateFiles = imported.length - distinct.length;

  logger.info(
    { connectionId: connection.id, files: files.length, imported: imported.length, distinct: distinct.length },
    "bluedart_invoices_batch_ingested"
  );

  res.json({
    filesReceived: files.length,
    imported: imported.length,
    distinctInvoices: distinct.length,
    // Named so the merchant is told rather than left to notice the same invoice
    // number listed twice.
    duplicateFiles,
    failed: results.length - imported.length,
    totalFreightPaise: distinct.reduce((sum, r) => sum + BigInt(r.totalFreightPaise), 0n).toString(),
    shipmentsUpdated: distinct.reduce((sum, r) => sum + r.shipmentsUpdated, 0),
    unmatchedCount: distinct.reduce((sum, r) => sum + r.unmatchedCount, 0),
    // Deduped for display too, so one invoice is not listed twice with two
    // different "replaced an earlier upload" notes.
    results: [...distinct, ...results.filter((r) => !r.ok)],
  });
});

// The COD remittance MIS. Bluedart emails or SFTPs this — it is not an API at
// Bluedart or at any Indian courier — so the import is the only way to learn
// which delivered parcels a given payout actually paid for.
bluedartConnectionRouter.post("/:connectionId/remittance", ...requireAuth, async (req, res) => {
  const { csv } = req.body ?? {};
  if (!csv || typeof csv !== "string") {
    res.status(400).json({ error: "missing_csv" });
    return;
  }

  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId, provider: "BLUEDART" },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  try {
    const result = await ingestCodRemittance(toConnectorContext(connection), csv);
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
    logger.info(
      {
        connectionId: connection.id,
        batchesImported: result.batchesImported,
        linesImported: result.linesImported,
        rejected: result.rejected.length,
      },
      "bluedart_remittance_ingested"
    );
    res.json(serializeIngestResult(result));
  } catch (err) {
    logger.error({ err }, "bluedart_remittance_ingest_failed");
    res.status(500).json({ error: "ingest_failed" });
  }
});
