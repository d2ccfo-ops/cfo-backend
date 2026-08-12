import crypto from "node:crypto";
import { prisma } from "../../../lib/prisma.js";
import { rupeesToPaise } from "../../calc/money.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";

// A fourth shape, and the most different one yet: there is no bank API to
// poll or subscribe to at all. A real-time bank feed for Indian accounts
// means RBI-licensed Account Aggregator infrastructure — real regulatory and
// integration weight that doesn't belong in an MVP. Until that's worth
// building, a bank "connection" here just registers which account a founder
// will upload statements for; the actual data enters via a CSV upload
// (routes/connections/bank.ts's /:connectionId/upload), not backfill/sync.
// backfill() and sync() are no-ops that exist only to satisfy the Connector
// interface — the real entry point is ingestStatement() below, called
// directly from the upload route. There is also no webhook: nothing external
// ever calls us, so there's no routes/webhooks/bank.ts and verifyWebhook()
// is never actually invoked.

export interface ParsedBankRow {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // rupees, always positive — direction carries the sign
  direction: "CREDIT" | "DEBIT";
}

export interface ParseResult {
  rows: ParsedBankRow[];
  errors: string[]; // one message per skipped line, 1-indexed against the input
}

const EXPECTED_COLUMNS = ["date", "description", "amount", "type"];

// Minimal CSV line parser that handles double-quoted fields (so a
// comma-containing bank description like `"NEFT, salary credit"` doesn't get
// split in the wrong place) and `""`-escaped quotes within a quoted field.
// Not a full RFC 4180 parser, but correct for the cases a bank statement
// export actually produces.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// Expected format, documented to the user in cfo-frontend's upload UI and
// cfo-docs/ONBOARDING.md: a header row with `date,description,amount,type`
// (any order — matched by name), one transaction per line, `date` as
// YYYY-MM-DD, `amount` a positive decimal number, `type` CREDIT or DEBIT.
// Real Indian bank statement exports vary wildly by bank and aren't
// standardized enough to parse directly without sample exports to build
// against — this normalized format is the deliberate MVP scope boundary,
// not an oversight. See cfo-docs/ARCHITECTURE.md.
export function parseStatementCsv(csvText: string): ParseResult {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: ParsedBankRow[] = [];
  const errors: string[] = [];

  if (lines.length === 0) return { rows, errors: ["Empty file"] };

  const header = parseCsvLine(lines[0] ?? "").map((h) => h.toLowerCase());
  const colIndex = {
    date: header.indexOf("date"),
    description: header.indexOf("description"),
    amount: header.indexOf("amount"),
    type: header.indexOf("type"),
  };

  const missing = EXPECTED_COLUMNS.filter((c) => colIndex[c as keyof typeof colIndex] === -1);
  if (missing.length > 0) {
    return { rows, errors: [`Missing required column(s): ${missing.join(", ")}`] };
  }

  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const fields = parseCsvLine(lines[i] ?? "");
    const rawDate = fields[colIndex.date];
    const description = fields[colIndex.description];
    const rawAmount = fields[colIndex.amount];
    const rawType = fields[colIndex.type]?.toUpperCase();

    if (!rawDate || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      errors.push(`Line ${lineNumber}: invalid date "${rawDate}" (expected YYYY-MM-DD)`);
      continue;
    }
    const amount = Number(rawAmount);
    if (!rawAmount || Number.isNaN(amount) || amount <= 0) {
      errors.push(`Line ${lineNumber}: invalid amount "${rawAmount}"`);
      continue;
    }
    if (rawType !== "CREDIT" && rawType !== "DEBIT") {
      errors.push(`Line ${lineNumber}: type must be CREDIT or DEBIT, got "${fields[colIndex.type]}"`);
      continue;
    }

    rows.push({ date: rawDate, description: description || "", amount, direction: rawType });
  }

  return { rows, errors };
}

async function upsertTransaction(ctx: ConnectorContext, row: ParsedBankRow, externalTxnId: string) {
  await prisma.rawEvent.upsert({
    where: { connectionId_externalEventId: { connectionId: ctx.connectionId, externalEventId: externalTxnId } },
    create: {
      organizationId: ctx.organizationId,
      connectionId: ctx.connectionId,
      provider: "BANK",
      externalEventId: externalTxnId,
      eventType: "bank_txn.upload",
      payload: row as unknown as object,
      processedAt: new Date(),
      processingStatus: "PROCESSED",
    },
    update: {}, // a re-upload of the same statement is a no-op — see the externalTxnId comment below
  });
  await bankConnector.processEvent(ctx, { ...row, externalTxnId }, "bank_txn.upload");
}

// Called directly by routes/connections/bank.ts's upload route — not part of
// the Connector interface, same pattern as Shiprocket's exported login().
export async function ingestStatement(
  ctx: ConnectorContext,
  csvText: string
): Promise<{ recordsFetched: number; skipped: number; errors: string[] }> {
  const { rows, errors } = parseStatementCsv(csvText);

  let count = 0;
  for (const [i, row] of rows.entries()) {
    // Includes the row's position in this file so re-uploading the exact
    // same statement is idempotent (same content, same position -> same
    // hash -> no duplicate row), while two genuinely different transactions
    // that happen to share date/description/amount/direction on different
    // lines don't collide.
    const externalTxnId = crypto
      .createHash("sha256")
      .update(`${row.date}|${row.description}|${row.amount}|${row.direction}|${i}`)
      .digest("hex");
    await upsertTransaction(ctx, row, externalTxnId);
    count++;
  }

  return { recordsFetched: count, skipped: errors.length, errors };
}

export const bankConnector: Connector = {
  provider: "BANK",

  async backfill(_ctx: ConnectorContext): Promise<SyncResult> {
    return { recordsFetched: 0, cursor: null };
  },

  async sync(_ctx: ConnectorContext, _sinceCursor: string | null): Promise<SyncResult> {
    return { recordsFetched: 0, cursor: null };
  },

  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string>): WebhookVerificationResult {
    return { valid: false, externalEventId: "", eventType: "unknown" };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown, _eventType: string): Promise<void> {
    const row = payload as ParsedBankRow & { externalTxnId: string };
    await prisma.bankTransaction.upsert({
      where: { connectionId_externalTxnId: { connectionId: ctx.connectionId, externalTxnId: row.externalTxnId } },
      create: {
        organizationId: ctx.organizationId,
        legalEntityId: ctx.legalEntityId,
        connectionId: ctx.connectionId,
        externalTxnId: row.externalTxnId,
        amount: rupeesToPaise(row.amount),
        direction: row.direction,
        valueDate: new Date(row.date),
        description: row.description,
        raw: row as unknown as object,
      },
      update: {}, // bank transactions are treated as immutable once ingested
    });
  },
};
