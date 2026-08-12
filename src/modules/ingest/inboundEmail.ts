import crypto from "node:crypto";
import type { Prisma, Provider } from "@prisma/client";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { EXPECTED_COLUMNS as BANK_EXPECTED_COLUMNS, extractAccountIdentifier, ingestStatement } from "../connectors/bank/index.js";
import { BLUEDART_COD_STATEMENT, ingestCodRemittance } from "../connectors/bluedart/index.js";
import { ingestInvoicePdfDocument } from "../connectors/bluedart/invoice.js";
import { GOKWIK_SETTLEMENT_STATEMENT, ingestSettlementReport } from "../connectors/gokwik/index.js";
import type { StatementFormat } from "../connectors/remittance/statement.js";
import { serializeIngestResult } from "../connectors/remittance/statement.js";
import { toConnectorContext } from "../connectors/types.js";
import { getOrCreateDefaultLegalEntity } from "../orgs/legalEntity.js";

// Inbound email ingestion — the pipe that removes the merchant from document
// collection.
//
// Every Indian courier distributes its money documents by email: the freight
// tax invoice as a PDF, the COD remittance MIS as a CSV. None of them offers
// either over an API — that was verified against Bluedart, Delhivery and DTDC
// before this was built — so the alternative to this file is a human
// downloading attachments every month, which they do twice and then stop, and
// every number downstream silently goes stale.
//
// The merchant sets ONE forwarding rule per courier sender, once. Documents
// then land here via an inbound-email provider's webhook, are recognised by
// their CONTENT (never their filename or sender — both are chosen by whoever
// sent the mail), and flow into the same parsers the manual upload buttons
// use. Adding a tenth courier costs a format definition, not an integration.
//
// Security model, stated plainly: the address token is the ONLY credential an
// email carries. Sender addresses are trivially forged and no courier signs
// its mail, so the sender is recorded for the log but trusted for NOTHING.
// What bounds the damage of a leaked address:
//   - the token is 48 random hex chars, unguessable and rotatable;
//   - every document type it can feed is checksummed against its own stated
//     totals and idempotent on re-import, so the worst a malicious sender can
//     do with a VALID document is import it (which the merchant wanted), and
//     an invalid one is refused and logged;
//   - nothing here executes, renders, or follows anything inside an
//     attachment — bytes go to a parser that reads them as data or refuses;
//   - documents import under a DEDICATED per-provider connection, never the
//     merchant's real credentialed one, so a forged statement cannot overwrite
//     or delete a reconciled payout (see getOrCreateIngestConnection);
//   - the webhook rate-limits per token and caps each attachment's size.
//
// P1.2, done: pdf-parse used to run on the request thread, where a crafted
// PDF that makes pdfjs loop or allocate could stall the event loop despite
// the size cap. It now runs in modules/ingest/pdfWorker.ts on its own thread
// with a 20s wall-clock deadline (lib/workerTimeout.ts) — a breach kills the
// thread and surfaces as unreadable_pdf, same as any other unparseable file.

// ---------------------------------------------------------------------------
// Payload normalisation
// ---------------------------------------------------------------------------

export interface NormalizedAttachment {
  name: string;
  /** Raw bytes, already decoded from the provider's base64. */
  content: Buffer;
  contentType: string | null;
}

export interface NormalizedInboundEmail {
  from: string | null;
  /** Recipients split by trust: the envelope address that caused delivery, and
   * the visible To/Cc used only as a fallback. */
  recipients: { envelope: string[]; fallback: string[] };
  subject: string | null;
  messageId: string | null;
  attachments: NormalizedAttachment[];
  /** True when the body carried at least one email-identifying field. */
  looksLikeEmail: boolean;
}

// Providers cap attachments well below this; the cap here is a backstop
// against a hand-crafted payload, not a real-world limit.
const MAX_ATTACHMENTS = 40;

// Per-attachment byte ceiling, checked before decode. A real courier invoice or
// remittance is well under a megabyte; 15MB is generous headroom and still far
// below the 50MB request cap, so one request cannot hold 40 × 50MB in memory.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Recipients in PRIORITY ORDER. The envelope recipient — the address that
// actually caused delivery — comes first, because that is the ingest address a
// forwarding rule delivered to, and it is the one that cannot be faked by
// what's written inside a forwarded message's visible To/Cc. Postmark reports
// it as OriginalRecipient; other providers as Delivered-To / recipient. The
// visible To/Cc are a fallback for providers that don't surface the envelope,
// and carry the original courier recipient a merchant forwarded FROM — so they
// must never win over the envelope.
function collectRecipients(body: Record<string, unknown>): { envelope: string[]; fallback: string[] } {
  const parse = (v: unknown): string[] => {
    const s = asString(v);
    return s ? s.split(",").map((p) => p.trim()).filter(Boolean) : [];
  };
  const envelope: string[] = [];
  const fallback: string[] = [];
  for (const key of ["OriginalRecipient", "Delivered-To", "DeliveredTo", "recipient"]) envelope.push(...parse(body[key]));
  for (const key of ["ToFull", "CcFull", "BccFull"]) {
    const arr = body[key];
    if (Array.isArray(arr)) for (const e of arr) fallback.push(...parse((e as Record<string, unknown>)?.Email));
  }
  for (const key of ["To", "Cc", "Bcc", "to", "cc"]) fallback.push(...parse(body[key]));
  return { envelope, fallback };
}

/**
 * Accepts Postmark's inbound JSON shape and a plain normalized shape, because
 * the point of a provider-agnostic webhook is that switching providers is a
 * relay configuration change, not a code change. Anything else can be adapted
 * to the plain shape by a few lines in the relay.
 *
 * Returns null when the body is not recognisably an email payload at all — so
 * a valid-token POST of arbitrary JSON (e.g. `{}`) is refused with a 400
 * upstream rather than logged as a phantom empty email. A genuine
 * attachment-less courier notice still passes: it carries From/Subject.
 */
const EMAIL_SHAPE_KEYS = [
  "From", "from", "FromFull", "sender", "To", "to", "ToFull", "Subject", "subject",
  "MessageID", "MessageId", "messageId", "Message-Id", "Attachments", "attachments",
  "OriginalRecipient", "recipient",
];

export function normalizeInboundPayload(body: unknown): NormalizedInboundEmail | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const looksLikeEmail = EMAIL_SHAPE_KEYS.some((k) => k in b);
  if (!looksLikeEmail) return null;

  const rawAttachments = (Array.isArray(b.Attachments) ? b.Attachments : Array.isArray(b.attachments) ? b.attachments : []) as Array<
    Record<string, unknown>
  >;
  const attachments: NormalizedAttachment[] = [];
  for (const a of rawAttachments.slice(0, MAX_ATTACHMENTS)) {
    if (!a || typeof a !== "object") continue;
    const base64 = asString(a.Content) ?? asString(a.contentBase64) ?? asString(a.content);
    if (!base64) continue;
    // Reject an oversized attachment BEFORE decoding it — a base64 string longer
    // than the cap allows decodes to a buffer past the per-attachment limit, and
    // decoding it first is the allocation we are trying to avoid. base64 is 4/3
    // the byte size, so the string-length gate is deliberately generous.
    if (base64.length > MAX_ATTACHMENT_BYTES * 1.4) continue;
    // Buffer.from never throws on base64; it silently drops invalid chars. An
    // empty decode of a non-empty string is base64 junk, not a document.
    const content = Buffer.from(base64, "base64");
    if (content.length === 0 || content.length > MAX_ATTACHMENT_BYTES) continue;
    attachments.push({
      name: asString(a.Name) ?? asString(a.name) ?? "attachment",
      content,
      contentType: asString(a.ContentType) ?? asString(a.contentType),
    });
  }

  const fromFull = b.FromFull as Record<string, unknown> | undefined;
  return {
    from: asString(fromFull?.Email) ?? asString(b.From) ?? asString(b.from) ?? asString(b.sender),
    recipients: collectRecipients(b),
    subject: asString(b.Subject) ?? asString(b.subject),
    messageId: asString(b.MessageID) ?? asString(b.MessageId) ?? asString(b.messageId) ?? asString(b["Message-Id"]),
    attachments,
    looksLikeEmail,
  };
}

// docs-<48 hex>@anything. Anchored and exact: the local part is the credential,
// and a lenient match ("any hex substring") would let a mangled forward
// resolve to the wrong org if two tokens ever shared a prefix.
const ADDRESS_TOKEN_RE = /^docs-([a-f0-9]{48})@/i;

function tokensIn(recipients: string[]): string[] {
  const found: string[] = [];
  for (const r of recipients) {
    // "Name <docs-…@d>" and bare "docs-…@d" both appear in real headers.
    const angle = r.match(/<([^>]+)>/)?.[1] ?? r;
    const m = angle.trim().match(ADDRESS_TOKEN_RE);
    if (m) found.push(m[1]!.toLowerCase());
  }
  return found;
}

/**
 * The ingest token for an email, or null to refuse it.
 *
 * The envelope recipient (the address delivery was actually made to) is
 * authoritative and checked first; the visible To/Cc are consulted only if the
 * envelope carried no token, because on a forwarded courier email the To/Cc
 * still name the ORIGINAL courier recipient, not the ingest address.
 *
 * Refuses (null) when the trusted level carries two DIFFERENT tokens — an email
 * addressed to two orgs' ingest addresses at once must not be silently filed
 * under whichever parsed first, since that would import one org's documents
 * into another's books.
 */
export function extractTokenFromRecipients(recipients: { envelope: string[]; fallback: string[] }): string | null {
  for (const level of [recipients.envelope, recipients.fallback]) {
    const tokens = [...new Set(tokensIn(level))];
    if (tokens.length === 1) return tokens[0]!;
    if (tokens.length > 1) return null; // ambiguous — refuse rather than guess
  }
  return null;
}

// ---------------------------------------------------------------------------
// Attachment recognition — by content, never by name or sender
// ---------------------------------------------------------------------------

interface CsvFormatEntry {
  provider: Provider;
  format: StatementFormat;
  // Headers that IDENTIFY this format — a batch or reference column spelling
  // that belongs to this provider's document and no other's. Detection is
  // decided on these, never on generic accounting words.
  //
  // The reason this is an explicit list and not "candidates claimed by exactly
  // one format": both formats accept generic fee/tax spellings ("Tax",
  // "Deduction", "Debit"), and "claimed by one format" made a lone "Tax" column
  // route a Bluedart MIS to GoKwik, and made "Settlement Id" + "Tax" read as an
  // ambiguous tie that refused a file the Bluedart importer accepts. An
  // identity header is a thing you would only ever see on THIS courier's
  // document.
  signature: string[];
}

// Every statement format the email pipe recognises. Adding a courier is one
// entry here once its StatementFormat exists — that is the whole point.
const CSV_FORMATS: CsvFormatEntry[] = [
  {
    provider: "BLUEDART",
    format: BLUEDART_COD_STATEMENT,
    signature: ["Remittance No", "RemittanceNo", "Waybill No", "WaybillNo", "Total Remittance", "COD Charges"],
  },
  {
    provider: "GOKWIK",
    format: GOKWIK_SETTLEMENT_STATEMENT,
    signature: ["Settlement UTR", "Merchant Order Id", "Total Settlement", "gokwik Deduction"],
  },
];

// Same normalisation the statement importer applies to headers, duplicated as
// one expression so detection and import cannot disagree about what a header
// "is". checkEmailIngest.ts asserts the two agree on every candidate spelling.
function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** First line of a CSV as cells, honouring quoted commas. */
function headerCells(csv: string): string[] {
  const firstLine = csv.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

export interface CsvDetection {
  provider: Provider;
  format: StatementFormat;
  label: string;
}

/**
 * Which statement format a CSV is, decided from its header row.
 *
 * Two gates, both required:
 *   1. The format's required columns (batchId, paidOn, reference, gross) are all
 *      present. This is necessary but NOT sufficient — both formats accept
 *      generic spellings like "Settlement Id" and "COD Amount", so a Bluedart
 *      MIS passes GoKwik's required gate too.
 *   2. Exactly ONE format's identity signature is present. A signature header is
 *      one that only ever appears on that courier's document ("Remittance No"
 *      is Bluedart's, "Settlement UTR" is GoKwik's). Deciding on these instead
 *      of on "headers claimed by one format's whole vocabulary" is what stops a
 *      lone generic "Tax" column from routing courier cash to the gateway
 *      ledger, and stops "Settlement Id + Tax" from reading as a false tie.
 *
 * Zero signatures → refused (unknown export). Both signatures → refused
 * (genuinely ambiguous — a file that is somehow both is not one we may guess
 * at, because importing an MIS under the wrong provider files courier cash as
 * gateway cash).
 */
export function detectCsvFormat(csv: string): { detected: CsvDetection | null; reason: string } {
  const headers = new Set(headerCells(csv).map(normHeader).filter(Boolean));
  if (headers.size === 0) return { detected: null, reason: "no header row" };

  const REQUIRED: Array<keyof StatementFormat["columns"]> = ["batchId", "paidOn", "reference", "gross"];

  const matches = CSV_FORMATS.filter((entry) => {
    const cols = entry.format.columns;
    const hasRequired = REQUIRED.every((slot) => (cols[slot] ?? []).some((cand) => headers.has(normHeader(cand))));
    const hasSignature = entry.signature.some((cand) => headers.has(normHeader(cand)));
    return hasRequired && hasSignature;
  });

  if (matches.length === 0) {
    // Distinguish "no signature" from "signature but missing a required column",
    // so the log tells a merchant whether they sent the wrong file or a broken
    // export.
    const anySignature = CSV_FORMATS.some((e) => e.signature.some((c) => headers.has(normHeader(c))));
    return {
      detected: null,
      reason: anySignature
        ? "a courier's identity column is present but a required column (payout id, date, reference, or amount) is missing"
        : "headers match no known statement format",
    };
  }
  if (matches.length > 1) {
    return {
      detected: null,
      reason: `ambiguous — headers carry the signature of both ${matches[0]!.format.label} and ${matches[1]!.format.label}`,
    };
  }
  const only = matches[0]!;
  return { detected: { provider: only.provider, format: only.format, label: only.format.label }, reason: "ok" };
}

// Bank statements don't fit CsvFormatEntry: they're a flat per-transaction
// format (routes/connections/bank.ts's parseStatementCsv), not a
// payout-grouped StatementFormat. Detected separately, and only after
// detectCsvFormat has had first refusal — "date,description,amount,type" are
// plain enough words that trying courier signatures FIRST is what keeps a
// generic-looking bank export from ever pre-empting a real courier MIS.
//
// All four are required, matched exactly (no candidate-spelling list, unlike
// the courier formats) — this is a format cfo-backend itself defined, not a
// document scraped from a bank's own export, so there is exactly one accepted
// spelling per column.
function looksLikeBankStatementCsv(csv: string): boolean {
  const headers = new Set(headerCells(csv).map(normHeader).filter(Boolean));
  return BANK_EXPECTED_COLUMNS.every((c) => headers.has(c));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface AttachmentOutcome {
  name: string;
  /** What the content was recognised as. */
  kind: "bluedart-invoice-pdf" | "statement-csv" | "unrecognised";
  ok: boolean;
  /** Human-readable result or refusal, shown verbatim in the log. */
  detail: string;
  /** Present for statement CSVs: which format matched. */
  format?: string;
}

// The account id every email-ingest connection carries, and the thing that
// keeps it separate from a merchant's real credentialed connection.
export const EMAIL_INGEST_ACCOUNT = "email-ingest";

/**
 * The connection an emailed document imports under — a DEDICATED one, never the
 * merchant's real credentialed connection.
 *
 * This isolation is a security boundary, not tidiness. Settlements are keyed on
 * (connectionId, externalSettlementId); the statement importer UPDATES an
 * existing settlement's amounts in place and DELETES lines a re-import omits.
 * If an emailed CSV landed on the merchant's live GoKwik/Bluedart connection, a
 * forged document sent to a leaked address could overwrite and delete real,
 * reconciled payouts. Pinned to its own connection, the worst a forged document
 * can do is write rows under the ingest connection — visibly email-sourced, and
 * unable to touch anything the real connection reconciled. That is the bounded
 * "it can import a document" damage the module header promises.
 *
 * Keyed on (organizationId, provider, externalAccountId) — the same unique the
 * schema enforces — so concurrent emails converge on ONE connection rather than
 * racing to create duplicates. Status PENDING keeps it out of the sync
 * scheduler's ACTIVE sweep (it holds no credentials to sync with) and renders
 * honestly on the Connections page: documents flow, nothing was connected.
 */
async function getOrCreateIngestConnection(organizationId: string, provider: Provider) {
  const select = { id: true, organizationId: true, legalEntityId: true, credentialsRef: true, externalAccountId: true };
  const existing = await prisma.connection.findFirst({
    where: { organizationId, provider, externalAccountId: EMAIL_INGEST_ACCOUNT },
    select,
  });
  if (existing) return existing;

  const legalEntity = await getOrCreateDefaultLegalEntity(organizationId);
  try {
    return await prisma.connection.create({
      data: {
        organizationId,
        legalEntityId: legalEntity.id,
        provider,
        status: "PENDING",
        externalAccountId: EMAIL_INGEST_ACCOUNT,
        // A real ciphertext of an empty object, not "": anything that later
        // decrypts this gets {} and fails on a missing field with a readable
        // message, instead of a crypto error that reads as data corruption.
        credentialsRef: encryptSecret(JSON.stringify({})),
      },
      select,
    });
  } catch (err) {
    // A concurrent email created it first; the unique constraint fired. Re-read
    // the winner rather than surfacing a race as a failure.
    if ((err as { code?: string }).code === "P2002") {
      const won = await prisma.connection.findFirst({
        where: { organizationId, provider, externalAccountId: EMAIL_INGEST_ACCOUNT },
        select,
      });
      if (won) return won;
    }
    throw err;
  }
}

// Bank statements are the one email-ingested document that must land on the
// merchant's REAL credentialed connection, not an isolated placeholder like
// Bluedart/GoKwik's forged-document sandbox: cash-received and available-cash
// sum bank transactions by organizationId, not by connection, so isolation
// would buy no protection while creating exactly the failure the plan calls
// out — the same statement forwarded by email AND uploaded by hand would land
// on two different connections and double the cash on the books. Resolution
// therefore either lands on the one unambiguous connection, or refuses and
// imports nothing; it never falls back to creating a connection of its own.
async function resolveBankConnectionForEmail(
  organizationId: string,
  csv: string
): Promise<{
  connection: { id: string; organizationId: string; legalEntityId: string; credentialsRef: string; externalAccountId: string | null } | null;
  reason: string;
}> {
  const connections = await prisma.connection.findMany({
    where: { organizationId, provider: "BANK", status: "ACTIVE" },
    select: { id: true, organizationId: true, legalEntityId: true, credentialsRef: true, externalAccountId: true },
  });
  if (connections.length === 0) {
    return { connection: null, reason: "no bank account is connected yet — add one on the Connections page, then forward the statement again" };
  }
  if (connections.length === 1) {
    return { connection: connections[0]!, reason: "ok" };
  }

  const { identifier, ambiguous } = extractAccountIdentifier(csv);
  const known = connections.map((c) => c.externalAccountId).join(", ");
  if (ambiguous) {
    return { connection: null, reason: "the statement's account column names more than one account — split it into one file per account" };
  }
  if (!identifier) {
    return {
      connection: null,
      reason: `${connections.length} bank accounts are connected (${known}) and this statement does not say which one it is — add an "Account" column with the account number or last 4 digits`,
    };
  }

  const digits = identifier.replace(/\D/g, "");
  const last4 = digits.length >= 4 ? digits.slice(-4) : null;
  const matches = connections.filter(
    (c) => c.externalAccountId && (c.externalAccountId.includes(identifier) || (last4 && c.externalAccountId.endsWith(last4)))
  );
  if (matches.length === 0) {
    return { connection: null, reason: `no connected account matches "${identifier}" — connected accounts: ${known}` };
  }
  if (matches.length > 1) {
    return { connection: null, reason: `"${identifier}" matches more than one connected account (${known}) — ambiguous` };
  }
  return { connection: matches[0]!, reason: "ok" };
}

function looksLikeText(buf: Buffer): boolean {
  // A CSV is overwhelmingly printable ASCII; a binary format is not. Checking
  // the first 2KB is enough to reject xlsx/zip/pdf bytes without decoding 50MB.
  const sample = buf.subarray(0, 2048);
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable += 1;
  }
  return sample.length > 0 && printable / sample.length > 0.95;
}

async function processAttachment(organizationId: string, att: NormalizedAttachment): Promise<AttachmentOutcome> {
  // PDF first, by magic bytes — the one unambiguous signature here. The
  // connection is a resolver, not a row: a refused PDF must not auto-create a
  // PENDING connection as a side effect of having been looked at.
  if (att.content.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    const outcome = await ingestInvoicePdfDocument(
      () => getOrCreateIngestConnection(organizationId, "BLUEDART"),
      att.content,
      att.name
    );
    if (outcome.ok) {
      return {
        name: att.name,
        kind: "bluedart-invoice-pdf",
        ok: true,
        detail:
          `Invoice ${outcome.invoiceNo}${outcome.product ? ` (${outcome.product})` : ""}: ` +
          `${outcome.linesParsed} lines, freight written to ${outcome.shipmentsUpdated} shipments` +
          `${outcome.replacedExisting ? ", replaced an earlier import" : ""}` +
          `${outcome.unmatchedCount > 0 ? `, ${outcome.unmatchedCount} waybills match no shipment` : ""}`,
      };
    }
    const reasons: Record<string, string> = {
      total_mismatch: `refused — rows sum to a different total than the invoice states (${outcome.linesParsed ?? 0} lines read)`,
      no_shipment_rows: "not a Bluedart freight invoice — no shipment rows found",
      no_invoice_number: "refused — no invoice number, so a re-send could not be deduplicated",
      unreadable_pdf: `could not be read as a PDF${outcome.detail ? ` (${outcome.detail})` : ""}`,
    };
    return {
      name: att.name,
      kind: outcome.error === "no_shipment_rows" || outcome.error === "unreadable_pdf" ? "unrecognised" : "bluedart-invoice-pdf",
      ok: false,
      detail: reasons[outcome.error] ?? outcome.error,
    };
  }

  // Excel is refused by name rather than silently failing text detection,
  // because "export as CSV" is an instruction the merchant can act on.
  if (/\.xlsx?$/i.test(att.name) || att.content.subarray(0, 2).toString("latin1") === "PK") {
    return {
      name: att.name,
      kind: "unrecognised",
      ok: false,
      detail: "Excel files are not supported — export the report as CSV and forward that",
    };
  }

  if (looksLikeText(att.content)) {
    const csv = att.content.toString("utf8");
    const { detected, reason } = detectCsvFormat(csv);

    if (!detected) {
      // Tried only after both courier signatures miss — see
      // looksLikeBankStatementCsv's comment on why the ordering matters.
      if (looksLikeBankStatementCsv(csv)) {
        const { connection, reason: resolveReason } = await resolveBankConnectionForEmail(organizationId, csv);
        if (!connection) {
          return { name: att.name, kind: "unrecognised", ok: false, detail: `Bank statement refused: ${resolveReason}` };
        }
        const ctx = toConnectorContext(connection);
        const result = await ingestStatement(ctx, csv);
        await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
        // Unlike the courier payouts below, bank rows are independent — one
        // malformed line doesn't invalidate the transactions around it, so
        // "ok" tracks whether anything actually landed, not zero errors.
        const ok = result.recordsFetched > 0;
        return {
          name: att.name,
          kind: "statement-csv",
          format: "Bank statement",
          ok,
          detail:
            `Bank statement: ${result.recordsFetched} transaction${result.recordsFetched === 1 ? "" : "s"} imported` +
            `${result.skipped > 0 ? `, ${result.skipped} row${result.skipped === 1 ? "" : "s"} skipped` : ""}` +
            `${result.errors.length > 0 ? ` — ${result.errors[0]}` : ""}`,
        };
      }
      return { name: att.name, kind: "unrecognised", ok: false, detail: `CSV not recognised: ${reason}` };
    }

    const connection = await getOrCreateIngestConnection(organizationId, detected.provider);
    const ctx = toConnectorContext(connection);
    const result =
      detected.provider === "BLUEDART" ? await ingestCodRemittance(ctx, csv) : await ingestSettlementReport(ctx, csv);

    // Mirrors what the manual upload route does after an import.
    await prisma.connection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });

    const s = serializeIngestResult(result);
    // ok requires COMPLETENESS, not "something got in". A 10-payout file where
    // 9 were rejected as out-of-balance and 1 imported must NOT read as
    // imported — that reports partial cash as reconciled and hides the nine the
    // merchant needs to look at. Any rejection or error makes the attachment
    // not-ok, which the email's status then renders as PARTIAL or FAILED.
    const ok = result.rejected.length === 0 && result.errors.length === 0;
    return {
      name: att.name,
      kind: "statement-csv",
      format: detected.label,
      ok,
      detail:
        `${detected.label}: ${result.batchesImported} payouts, ${result.linesImported} lines` +
        `${result.linesUnresolved > 0 ? `, ${result.linesUnresolved} unresolved` : ""}` +
        `${result.rejected.length > 0 ? `, ${result.rejected.length} batches refused (out of balance)` : ""}` +
        `${result.errors.length > 0 ? ` — ${result.errors[0]}` : ""}` +
        (typeof s.amountImportedPaise === "string" && s.amountImportedPaise !== "0"
          ? ` — ₹${(Number(s.amountImportedPaise) / 100).toLocaleString("en-IN")}`
          : ""),
    };
  }

  return {
    name: att.name,
    kind: "unrecognised",
    ok: false,
    detail: "not a PDF or CSV — only courier invoices (PDF) and statement exports (CSV) are read",
  };
}

// ---------------------------------------------------------------------------
// The entry point the webhook calls
// ---------------------------------------------------------------------------

export interface InboundEmailResult {
  accepted: boolean;
  duplicate: boolean;
  status: "PROCESSED" | "PARTIAL" | "FAILED" | "EMPTY";
  outcomes: AttachmentOutcome[];
}

export async function processInboundEmail(token: string, payload: NormalizedInboundEmail): Promise<InboundEmailResult | null> {
  const address = await prisma.emailIngestAddress.findUnique({ where: { token } });
  // A disabled address is indistinguishable from an unknown one on the wire —
  // rotation exists precisely because the old address may be in hostile hands,
  // and "disabled" confirms it once worked.
  if (!address || address.disabledAt) return null;

  // Providers retry deliveries; the same email must not import twice. The
  // importers themselves are idempotent, so this dedupe is about not writing a
  // second log row that would make one email look like two.
  if (payload.messageId) {
    const prior = await prisma.inboundEmail.findUnique({
      where: { organizationId_messageId: { organizationId: address.organizationId, messageId: payload.messageId } },
    });
    if (prior) {
      return {
        accepted: true,
        duplicate: true,
        status: prior.status,
        outcomes: (prior.outcomes as unknown as AttachmentOutcome[]) ?? [],
      };
    }
  }

  const outcomes: AttachmentOutcome[] = [];
  for (const att of payload.attachments) {
    // NOT wrapped in a catch. A document the parser cannot use is already
    // returned as an ok:false outcome without throwing — a throw here means an
    // INFRASTRUCTURE fault (the database is down, a query timed out), which
    // must propagate to the webhook handler so it answers 500 and the provider
    // RETRIES. Swallowing it and logging FAILED would answer 200, tell the
    // provider never to retry, and lose a real document to a transient blip —
    // the imports are idempotent and message-id-deduped, so the retry is safe.
    outcomes.push(await processAttachment(address.organizationId, att));
  }

  const okCount = outcomes.filter((o) => o.ok).length;
  const status: InboundEmailResult["status"] =
    outcomes.length === 0 ? "EMPTY" : okCount === outcomes.length ? "PROCESSED" : okCount > 0 ? "PARTIAL" : "FAILED";

  try {
    await prisma.inboundEmail.create({
      data: {
        organizationId: address.organizationId,
        addressId: address.id,
        messageId: payload.messageId,
        fromAddress: payload.from,
        subject: payload.subject,
        attachmentCount: payload.attachments.length,
        status,
        outcomes: outcomes as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // Unique violation = a concurrent retry beat us to the log row. The
    // imports above are idempotent, so the only thing duplicated was effort.
    if ((err as { code?: string }).code !== "P2002") throw err;
  }

  logger.info(
    { organizationId: address.organizationId, from: payload.from, attachments: payload.attachments.length, status },
    "inbound_email_processed"
  );
  return { accepted: true, duplicate: false, status, outcomes };
}

export function generateIngestToken(): string {
  return crypto.randomBytes(24).toString("hex");
}