import { Prisma, type Provider, type SettlementLineType } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { rupeesToPaise } from "../../calc/money.js";

// The shared remittance/settlement statement importer.
//
// WHY THIS IS ONE MODULE AND NOT FOUR
// -----------------------------------
// A Bluedart COD remittance MIS, a GoKwik settlement report, a Shiprocket COD
// statement and a Razorpay settlement recon report are the same document with
// different column headings: a payout total with a UTR, and the list of things
// that payout was for. The differences are entirely in the header names and the
// sign conventions, so those are the only thing a provider supplies here.
//
// This exists because none of these are pulled from an API in practice. Courier
// COD remittance is distributed as an emailed/SFTP'd MIS report, not an
// endpoint — verified for Bluedart and Delhivery, and the reason the bank
// connector is also a CSV upload rather than a poll. Building an API client for
// a document that arrives as a spreadsheet would be building the wrong thing.
//
// THE INVARIANT THAT MAKES THIS TRUSTWORTHY
// -----------------------------------------
// The lines must sum to the batch total. A statement whose lines do not add up
// is not partially usable — it means a column was misread, and a misread column
// produces a reconciliation that is confidently wrong. So an out-of-balance
// batch is REJECTED with the discrepancy stated, never imported with a warning.

export interface StatementColumnMap {
  /** Batch-level: the payout this row belongs to. */
  batchId: string[];
  utr?: string[];
  paidOn: string[];
  /** Line-level: what the money was for. */
  reference: string[];
  gross: string[];
  fee?: string[];
  /**
   * Deductions split across SEVERAL columns, all summed.
   *
   * GoKwik's real settlement ledger carries `Tax`, `Fee`, `Additional Fees`,
   * `Additional Tax` and `gokwik Deduction` as five separate columns. Picking
   * one (which is what `fee` does) would understate the deduction and make
   * every line fail its own gross − fee = net check. Every listed column that
   * is PRESENT is summed; absent ones are ignored.
   */
  feeParts?: string[];
  net?: string[];
  /**
   * The outflow side of a two-sided ledger.
   *
   * GoKwik's export has `Debit` and `Credit` columns: a sale credits the
   * merchant, a refund or chargeback debits them, and BOTH sit inside the same
   * payout. Without this a refund row reads as gross 500 / net 0, fails its own
   * gross − fee = net check, and rejects the entire payout — verified against
   * the real header. A debit row is instead recorded as a NEGATIVE line, which
   * is what it is: money that reduced the payout.
   */
  debit?: string[];
  /** Optional per-row batch total, for formats that repeat it on every line. */
  batchTotal?: string[];
}

export interface StatementFormat {
  provider: Provider;
  /** Default line type, used for every row the discriminator does not classify. */
  lineType: SettlementLineType;
  kind: "GATEWAY" | "COD_REMITTANCE";
  columns: StatementColumnMap;
  /**
   * Optional per-row discriminator. Accepted header spellings for the column
   * that says whether a row is a prepaid payment or COD cash — e.g. GoKwik's
   * "Payment Mode" / "Order Type". Without this every row takes `lineType`,
   * which is correct for a pure courier COD MIS and wrong for a checkout
   * platform's mixed payout.
   */
  lineTypeColumn?: string[];
  /** Normalised cell value → line type. Keys are matched case-insensitively. */
  lineTypeMap?: Record<string, SettlementLineType>;
  /** Human name, used in error messages and the UI. */
  label: string;
}

export interface ParsedLine {
  reference: string;
  grossPaise: bigint;
  feePaise: bigint;
  netPaise: bigint;
  /**
   * Resolved PER ROW, not per file. A checkout platform that owns the whole
   * funnel (GoKwik) settles prepaid card/UPI payments and remits COD cash in
   * the SAME payout, so one report legitimately mixes both. Falls back to the
   * format's own `lineType` when the file carries no discriminator column.
   */
  lineType: SettlementLineType;
  row: Record<string, string>;
}

export interface LineImbalance {
  batchId: string;
  reference: string;
  grossPaise: bigint;
  feePaise: bigint;
  netPaise: bigint;
}

export interface ParsedBatch {
  batchId: string;
  utr: string | null;
  paidOn: Date;
  lines: ParsedLine[];
  /** Sum of line net. The batch total as stated, when the format carries one. */
  netPaise: bigint;
  statedTotalPaise: bigint | null;
  /** Lines where gross − fee did not equal the stated net. */
  imbalances: LineImbalance[];
}

export interface StatementParseResult {
  batches: ParsedBatch[];
  errors: string[];
  /** Payment modes that matched no key and no family — imported as ADJUSTMENT. */
  unknownModes?: string[];
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// Same minimal quote-aware parser as the bank statement importer, for the same
// reason: a courier's narration field contains commas.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

// Resolves one of several accepted header spellings to its column index.
// Providers rename columns between report versions far more often than they
// change meaning, so each field accepts a list.
function resolveColumns(headers: string[], map: StatementColumnMap) {
  const normalised = headers.map(normaliseHeader);
  const find = (candidates: string[] | undefined) => {
    if (!candidates) return -1;
    for (const c of candidates) {
      const i = normalised.indexOf(normaliseHeader(c));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    batchId: find(map.batchId),
    utr: find(map.utr),
    paidOn: find(map.paidOn),
    reference: find(map.reference),
    gross: find(map.gross),
    fee: find(map.fee),
    feeParts: (map.feeParts ?? []).map((c) => find([c])).filter((i) => i >= 0),
    net: find(map.net),
    debit: find(map.debit),
    batchTotal: find(map.batchTotal),
  };
}

// Statements express money as "1,234.56", "₹1,234.56", "(1,234.56)" for
// negative, or "-1234.56". All four appear in real Indian courier MIS files.
function parseMoney(raw: string | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[₹,\s]/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  const negative = /^\(.*\)$/.test(cleaned);
  const n = Number(negative ? cleaned.slice(1, -1) : cleaned);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

// Accepts the formats these reports actually use: ISO, DD-MM-YYYY, DD/MM/YYYY.
// Ambiguous MM/DD is NOT guessed at — an Indian courier report is DD first, and
// a wrong guess silently shifts a payout by months.
function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Family classification for payment-mode values a format's exact map missed.
// Substring, because providers suffix endlessly ("upi-ba", "upi_intent",
// "card-emi") but the family word is always in there.
//
// COD IS CHECKED FIRST. "cod" appearing anywhere wins over a payment word,
// because "ppcod" and "cod-upi" are cash-on-delivery arrangements that merely
// mention a payment rail — reading those as prepaid would count cash the
// merchant has not received.
// Values that mean "no value", not "a value we failed to understand".
const PLACEHOLDER_VALUES = new Set(["na", "n/a", "-", "--", "none", "null", "nil", "not applicable", "notapplicable"]);

export function classifyByFamily(raw: string): SettlementLineType | null {
  const v = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!v) return null;
  // Partially-prepaid COD stays deliberately unclassified — it has money in
  // BOTH ledgers and cannot be assigned to one from a mode string.
  if (v.includes("ppcod") || v.includes("partial")) return null;
  if (v.includes("cod") || v.includes("cashondelivery") || v.includes("cashon")) return "SHIPMENT_COD";
  const prepaid = ["upi", "card", "netbanking", "netbank", "wallet", "emi", "paylater", "prepaid", "online", "credit", "debit", "snapmint", "simpl", "lazypay", "paytm", "phonepe", "gpay", "razorpay", "cashfree"];
  if (prepaid.some((p) => v.includes(p))) return "PAYMENT";
  const adjust = ["refund", "chargeback", "commission", "fee", "tds", "tax", "adjustment", "reversal", "penalty"];
  if (adjust.some((a) => v.includes(a))) return "ADJUSTMENT";
  return null;
}

export function parseStatement(csv: string, format: StatementFormat): StatementParseResult {
  const errors: string[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { batches: [], errors: ["file has no data rows"] };

  const headers = parseCsvLine(lines[0]!);
  const col = resolveColumns(headers, format.columns);

  // Optional — a file without it simply uses the format's default line type.
  const normalisedHeaders = headers.map(normaliseHeader);
  // EVERY matching discriminator column, in the format's own priority order —
  // not just the first one found.
  //
  // GoKwik's export has both "Payment Mode" and "Transaction Type", and on real
  // rows Payment Mode is frequently BLANK while Transaction Type says
  // "Payment". Reading only the first column meant those rows fell through to
  // the format default — SHIPMENT_COD — filing prepaid captures as cash
  // collected on delivery. Each column is tried until one yields a value that
  // classifies.
  const lineTypeIdxs = (format.lineTypeColumn ?? [])
    .map((c) => normalisedHeaders.indexOf(normaliseHeader(c)))
    .filter((i) => i >= 0);
  const lineTypeLookup = new Map<string, SettlementLineType>(
    Object.entries(format.lineTypeMap ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v])
  );
  // Payment-mode vocabularies are open-ended. A real GoKwik export contained
  // "upi-ba", which is plainly UPI but matched no exact key — and refusing the
  // row blocked the entire file over a naming variant.
  //
  // So classification is now: exact key, then FAMILY match on the shape of the
  // value, then give up. The families are deliberately narrow — "upi", "card",
  // "netbanking", "wallet", "emi", "paylater" and the like are prepaid however
  // they are suffixed; anything containing "cod" or "cash on delivery" is cash
  // collected on delivery.
  const unknownModes = new Set<string>();

  const required: { label: string; index: number; accepted: string[] }[] = [
    { label: "batch id", index: col.batchId, accepted: format.columns.batchId },
    { label: "paid-on date", index: col.paidOn, accepted: format.columns.paidOn },
    { label: "reference", index: col.reference, accepted: format.columns.reference },
    { label: "gross amount", index: col.gross, accepted: format.columns.gross },
  ];
  for (const r of required) {
    if (r.index < 0) {
      // Naming BOTH what was expected and what was actually in the file — a
      // "missing column" error that does not show the headers it saw leaves
      // the reader to guess at a spelling difference.
      errors.push(
        `could not find a ${r.label} column. Expected one of: ${r.accepted.join(", ")}. Found: ${headers.join(", ")}`
      );
    }
  }
  if (errors.length > 0) return { batches: [], errors };

  const byBatch = new Map<string, ParsedBatch>();

  for (let i = 1; i < lines.length; i += 1) {
    const f = parseCsvLine(lines[i]!);
    const rowNo = i + 1;

    const batchId = f[col.batchId]?.trim();
    if (!batchId) {
      errors.push(`row ${rowNo}: no batch id`);
      continue;
    }
    const paidOn = parseDate(f[col.paidOn]);
    if (!paidOn) {
      errors.push(`row ${rowNo}: unreadable date "${f[col.paidOn] ?? ""}"`);
      continue;
    }
    const reference = f[col.reference]?.trim();
    if (!reference) {
      errors.push(`row ${rowNo}: no reference (AWB / payment id)`);
      continue;
    }
    const gross = parseMoney(f[col.gross]);
    if (gross === null) {
      errors.push(`row ${rowNo}: unreadable amount "${f[col.gross] ?? ""}"`);
      continue;
    }

    // Which ledger this row belongs to. A prepaid capture and a COD collection
    // sit in the same GoKwik payout but reconcile against completely different
    // things, so getting this wrong is worse than not importing the row.
    let lineType = format.lineType;
    if (lineTypeIdxs.length > 0) {
      // ONLY A BLANK COLUMN ADVANCES TO THE NEXT ONE.
      //
      // A blank carries no information, so the next discriminator is a genuine
      // improvement. A column that is POPULATED but unrecognised carries real
      // information — "this is something we do not understand" — and must stop
      // the search. Otherwise a row whose Payment Mode says "PPCOD" (money in
      // both ledgers, deliberately unclassifiable) would fall through to
      // Transaction Type "Sale" and be filed as prepaid, which is the precise
      // misattribution this discriminator exists to prevent.
      let cell = "";
      let mapped: SettlementLineType | null = null;
      for (const idx of lineTypeIdxs) {
        const v = (f[idx] ?? "").trim().toLowerCase();
        // A PLACEHOLDER is a blank wearing a costume. GoKwik writes "na" in
        // Payment Mode on refund rows, where the concept genuinely does not
        // apply — the mode of a reversal is not a mode. Treating it as an
        // unknown vocabulary word produced a warning asking the merchant to
        // explain "na", when the honest reading is "no value stated, look at
        // the next column" (Transaction Type: Refund, which classifies fine).
        if (!v || PLACEHOLDER_VALUES.has(v)) continue;
        cell = v;
        mapped = lineTypeLookup.get(v) ?? classifyByFamily(v);
        break;
      }
      if (mapped) {
        lineType = mapped;
      } else if (cell) {
        // NOT an error, and NOT the format default either.
        //
        // Refusing blocked a whole export over one naming variant; defaulting
        // would file an unknown mode as COD (GoKwik's default) and attribute
        // prepaid money to a parcel. ADJUSTMENT is the honest third option: the
        // money still counts toward the payout total so the batch balances, but
        // it is attached to no shipment and no payment, so nothing is
        // misattributed. Reported as a warning so the vocabulary can be filled in.
        unknownModes.add(cell);
        lineType = "ADJUSTMENT";
      }
    }
    // Summed across every deduction column the format lists and the file has.
    const feeFromParts = col.feeParts.reduce((sum, idx) => sum + Math.abs(parseMoney(f[idx]) ?? 0), 0);
    const fee = col.feeParts.length > 0 ? feeFromParts : col.fee >= 0 ? (parseMoney(f[col.fee]) ?? 0) : 0;

    // A debited row is an outflow. Both sides are negated so the line still
    // satisfies gross − fee = net, and so the batch total nets the refund out
    // rather than counting it as money received.
    const debit = col.debit >= 0 ? Math.abs(parseMoney(f[col.debit]) ?? 0) : 0;
    const isOutflow = debit > 0;
    // Net is derived when the report does not state it. Deducted, never added:
    // every one of these reports expresses fees as a positive deduction.
    const net = isOutflow
      ? -(debit)
      : col.net >= 0
        ? (parseMoney(f[col.net]) ?? gross - Math.abs(fee))
        : gross - Math.abs(fee);

    // LINE-LEVEL CONSISTENCY. The batch total only validates NET, so a misread
    // GROSS column balances perfectly and still attributes the wrong amount to
    // every shipment in the payout — caught here instead. Only checked when the
    // report states all three; a format that omits net has nothing to disagree
    // with, since net was derived from the other two.
    const hasFeeColumn = col.fee >= 0 || col.feeParts.length > 0;
    // An outflow's gross is negated to match its negative net.
    const signedGross = isOutflow ? -Math.abs(gross) : gross;
    const lineImbalanced =
      col.net >= 0 && hasFeeColumn && Math.abs(signedGross - (isOutflow ? -Math.abs(fee) : Math.abs(fee)) - net) > 0.005;

    const existing = byBatch.get(batchId);
    const line: ParsedLine = {
      reference,
      grossPaise: rupeesToPaise(signedGross),
      feePaise: rupeesToPaise(Math.abs(fee)),
      netPaise: rupeesToPaise(net),
      lineType,
      row: Object.fromEntries(headers.map((h, k) => [h, f[k] ?? ""])),
    };

    if (existing) {
      existing.lines.push(line);
      existing.netPaise += line.netPaise;
      if (lineImbalanced) {
        existing.imbalances.push({
          batchId,
          reference,
          grossPaise: line.grossPaise,
          feePaise: line.feePaise,
          netPaise: line.netPaise,
        });
      }
    } else {
      const statedTotal = col.batchTotal >= 0 ? parseMoney(f[col.batchTotal]) : null;
      byBatch.set(batchId, {
        batchId,
        utr: col.utr >= 0 ? (f[col.utr]?.trim() || null) : null,
        paidOn,
        lines: [line],
        netPaise: line.netPaise,
        statedTotalPaise: statedTotal === null ? null : rupeesToPaise(statedTotal),
        imbalances: lineImbalanced
          ? [{ batchId, reference, grossPaise: line.grossPaise, feePaise: line.feePaise, netPaise: line.netPaise }]
          : [],
      });
    }
  }

  return { batches: [...byBatch.values()], errors, unknownModes: [...unknownModes] };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface IngestResult {
  batchesImported: number;
  linesImported: number;
  /** Lines whose reference matched nothing we hold. Reported, never dropped. */
  linesUnresolved: number;
  amountImportedPaise: bigint;
  /**
   * Payment modes the format did not recognise. Those lines were imported as
   * ADJUSTMENT — counted in the payout, attached to nothing — rather than
   * refused or guessed at. Surfaced so the vocabulary can be extended.
   */
  unknownModes: string[];
  /** Stale lines removed because a re-import reclassified or dropped them. */
  linesReplaced: number;
  /** Batches refused because their lines did not sum to the stated total. */
  rejected: { batchId: string; reason: "total_mismatch" | "line_mismatch"; statedPaise: bigint; summedPaise: bigint; detail: string }[];
  errors: string[];
}

/**
 * JSON-safe view of an IngestResult.
 *
 * Every amount here is a bigint of paise, and `res.json()` THROWS on a bigint
 * rather than serialising it — so a successful import would have returned a 500
 * to the browser. Shared by every upload route so that conversion cannot be
 * done correctly in one and forgotten in another.
 */
export function serializeIngestResult(r: IngestResult) {
  return {
    ...r,
    amountImportedPaise: r.amountImportedPaise.toString(),
    rejected: r.rejected.map((x) => ({
      ...x,
      statedPaise: x.statedPaise.toString(),
      summedPaise: x.summedPaise.toString(),
    })),
  };
}

export interface IngestContext {
  connectionId: string;
  organizationId: string;
  legalEntityId: string;
}

// Postgres refuses a prepared statement carrying more than 32,767 bind
// variables, and every element of an `in` list is one. The reference lookups
// below pass two `in` lists built from the same array, so a statement with
// more than about 5,400 references blew up with "too many bind variables" —
// after the file had parsed, and after earlier batches had already been
// written. A monthly courier MIS or a marketplace payout file clears that
// easily; this was a hard ceiling on statement size, not a rare edge.
//
// 4,000 keeps the worst case (two `in` lists of the same chunk, plus the
// scalar predicates) around 8,000 bind variables — well inside the limit with
// room for a future third lookup, and few enough round trips that a 35,000-row
// statement costs nine queries instead of one.
const LOOKUP_CHUNK = 4_000;

// A NUL separator, not a hyphen: references come from a provider's CSV and can
// contain anything, so a printable separator could be forged by a reference
// that happens to contain it and collide two different lines onto one payment.
function refGrossKey(reference: string, grossPaise: bigint): string {
  return `${reference} ${grossPaise}`;
}

async function inChunks<T, R>(items: T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  if (items.length <= LOOKUP_CHUNK) return fn(items);
  const out: R[] = [];
  for (let i = 0; i < items.length; i += LOOKUP_CHUNK) {
    out.push(...(await fn(items.slice(i, i + LOOKUP_CHUNK))));
  }
  return out;
}

export async function ingestStatement(
  ctx: IngestContext,
  csv: string,
  format: StatementFormat
): Promise<IngestResult> {
  const parsed = parseStatement(csv, format);
  const result: IngestResult = {
    batchesImported: 0,
    linesImported: 0,
    linesUnresolved: 0,
    unknownModes: parsed.unknownModes ?? [],
    linesReplaced: 0,
    amountImportedPaise: 0n,
    rejected: [],
    errors: parsed.errors,
  };
  if (parsed.batches.length === 0) return result;

  // Resolve every reference in one pass rather than per line — a COD MIS for a
  // week is thousands of AWBs, and a query each would be thousands of queries.
  const references = [...new Set(parsed.batches.flatMap((b) => b.lines.map((l) => l.reference)))];

  const shipmentByRef = new Map<string, string>();
  // Keyed by reference, and ALSO by refGrossKey(reference, gross) for orders
  // whose reference covers more than one capture. The specific key is tried
  // first at write time so a split payment reaches the right capture.
  const paymentByRef = new Map<string, string>();

  // Which lookups to run is decided by what the FILE actually contains, not by
  // the format's default. A GoKwik payout carrying both prepaid and COD rows
  // needs both maps built; a courier MIS needs only the shipment one.
  const presentTypes = new Set(parsed.batches.flatMap((b) => b.lines.map((l) => l.lineType)));

  if (presentTypes.has("SHIPMENT_COD")) {
    // AWB first — it is what a courier statement states. externalShipmentId is
    // the fallback for providers that reference their own shipment id instead.
    const shipments = await inChunks(references, (refs) =>
      prisma.shipment.findMany({
        where: {
          organizationId: ctx.organizationId,
          OR: [{ awbCode: { in: refs } }, { externalShipmentId: { in: refs } }],
        },
        select: { id: true, awbCode: true, externalShipmentId: true },
      })
    );
    for (const s of shipments) {
      if (s.awbCode) shipmentByRef.set(s.awbCode, s.id);
      shipmentByRef.set(s.externalShipmentId, s.id);
    }

    // ORDER-NUMBER FALLBACK. Not every COD remitter is a courier. A checkout
    // platform (GoKwik) collects the cash but never handles the parcel, so it
    // states the MERCHANT'S ORDER NUMBER — it may not know the AWB at all.
    // Without this, every such line resolved to nothing and the payout imported
    // as an unattributable lump: the exact failure the COD leg was built to end.
    const unresolved = references.filter((r) => !shipmentByRef.has(r));
    if (unresolved.length > 0) {
      // Shopify order numbers appear as "#1042" or "1042" depending on which
      // side exported them; try both spellings rather than assume one.
      const candidates = new Map<string, string>();
      for (const r of unresolved) {
        const bare = r.replace(/^#/, "");
        candidates.set(bare, r);
        candidates.set(`#${bare}`, r);
        candidates.set(r, r);
      }
      // BOTH identifiers, because which one a provider states is not knowable
      // from the column name. GoKwik's "Merchant Order Id" holds Shopify's
      // numeric order id (Order.externalOrderId) while its "Platform Order Id"
      // holds the order NAME (#25367) — the opposite of what the names suggest.
      // Matching only orderNumber resolved 0 of 200 real references; matching
      // both resolves them regardless of which column the format picked.
      const keys = [...candidates.keys()];
      const orders = await inChunks(keys, (k) =>
        prisma.order.findMany({
          where: {
            organizationId: ctx.organizationId,
            OR: [{ orderNumber: { in: k } }, { externalOrderId: { in: k } }],
          },
          select: { orderNumber: true, externalOrderId: true, shipments: { select: { id: true } } },
        })
      );
      for (const o of orders) {
        // A split order has several parcels and the statement says nothing about
        // which one the cash belongs to. Guessing would attribute real money to
        // the wrong shipment, so an ambiguous order stays unresolved and gets
        // reported — the same rule the balance check follows.
        if (o.shipments.length !== 1) continue;
        const ref = candidates.get(o.orderNumber) ?? candidates.get(o.externalOrderId);
        if (ref) shipmentByRef.set(ref, o.shipments[0]!.id);
      }
    }
  }

  if (presentTypes.has("PAYMENT")) {
    const payments = await inChunks(references, (refs) =>
      prisma.payment.findMany({
        where: { organizationId: ctx.organizationId, externalPaymentId: { in: refs } },
        select: { id: true, externalPaymentId: true },
      })
    );
    for (const p of payments) paymentByRef.set(p.externalPaymentId, p.id);

    // ORDER-NUMBER FALLBACK for prepaid lines, mirroring the COD one above and
    // for the same reason: a checkout platform states the merchant's order
    // number, not the gateway's payment id — it may be settling through an
    // underlying PG whose ids we hold under a different provider entirely.
    const stillMissing = references.filter((r) => !paymentByRef.has(r));
    if (stillMissing.length > 0) {
      const candidates = new Map<string, string>();
      for (const r of stillMissing) {
        const bare = r.replace(/^#/, "");
        candidates.set(bare, r);
        candidates.set(`#${bare}`, r);
        candidates.set(r, r);
      }
      const keys = [...candidates.keys()];
      const orders = await inChunks(keys, (k) =>
        prisma.order.findMany({
          where: {
            organizationId: ctx.organizationId,
            OR: [{ orderNumber: { in: k } }, { externalOrderId: { in: k } }],
          },
          select: { orderNumber: true, externalOrderId: true, payments: { select: { id: true, amount: true } } },
        })
      );
      // EVERY gross a reference appears with, not just one.
      //
      // A partly-prepaid order produces TWO payout lines under ONE order id
      // (₹21 taken at checkout, ₹16,307 on delivery — this is how PPCOD lands
      // from Shopify, and the GoKwik connector notes it is 448 of the live
      // store's last 60 days). One gross per reference would keep whichever
      // line was parsed last and leave the other permanently unmatchable.
      const grossesByRef = new Map<string, bigint[]>();
      for (const b of parsed.batches) {
        for (const l of b.lines) {
          if (l.lineType !== "PAYMENT") continue;
          const seen = grossesByRef.get(l.reference);
          if (seen) seen.push(l.grossPaise);
          else grossesByRef.set(l.reference, [l.grossPaise]);
        }
      }
      for (const o of orders) {
        const ref = candidates.get(o.orderNumber) ?? candidates.get(o.externalOrderId);
        if (!ref) continue;
        if (o.payments.length === 1) {
          paymentByRef.set(ref, o.payments[0]!.id);
          continue;
        }
        // MULTI-CAPTURE ORDERS ARE RESOLVABLE WHEN THE AMOUNT IS UNAMBIGUOUS.
        //
        // This used to `continue` on any order with more than one payment, on
        // the grounds that a payout row cannot be pinned to one of several
        // captures. True in general — but not when the row's gross matches
        // exactly one of them. Both PPCOD lines went unresolved, so the fee on
        // real money was attributed to nothing.
        //
        // Resolved per (reference, gross) rather than per reference, because
        // both lines share the order id and must reach DIFFERENT payments.
        //
        // Exactly one match required. Two captures of the same amount are
        // genuinely ambiguous, and this keeps refusing those — the point is to
        // resolve what is certain, not to lower the bar.
        for (const gross of grossesByRef.get(ref) ?? []) {
          const exact = o.payments.filter((p) => p.amount === gross);
          if (exact.length === 1) paymentByRef.set(refGrossKey(ref, gross), exact[0]!.id);
        }
      }
    }
  }

  // A payout's kind follows the lines it actually contains. A GoKwik batch of
  // pure prepaid captures is a GATEWAY settlement even though the format's
  // default says COD_REMITTANCE; one carrying any prepaid line is reported as
  // GATEWAY so the diagnostic count in reconciliation.ts sees it.
  const kindOf = (b: (typeof parsed.batches)[number]) =>
    b.lines.some((l) => l.lineType === "PAYMENT") ? "GATEWAY" : format.kind;

  for (const batch of parsed.batches) {
    // THE BALANCE CHECK. A statement whose lines do not sum to its stated total
    // means a column was misread, and importing it anyway produces a
    // reconciliation that is confidently wrong — the worst possible outcome for
    // this table. Refuse and say by how much.
    if (batch.imbalances.length > 0) {
      const first = batch.imbalances[0]!;
      result.rejected.push({
        batchId: batch.batchId,
        reason: "line_mismatch",
        statedPaise: first.netPaise,
        summedPaise: first.grossPaise - first.feePaise,
        detail: `${batch.imbalances.length} line(s) where gross − fee ≠ net, first: ${first.reference}`,
      });
      continue;
    }
    if (batch.statedTotalPaise !== null) {
      const diff = batch.statedTotalPaise - batch.netPaise;
      if (diff !== 0n) {
        result.rejected.push({
          batchId: batch.batchId,
          reason: "total_mismatch",
          statedPaise: batch.statedTotalPaise,
          summedPaise: batch.netPaise,
          detail: `stated total and summed lines differ by ${Number(diff) / 100} rupees`,
        });
        continue;
      }
    }

    const settlement = await prisma.settlement.upsert({
      where: {
        connectionId_externalSettlementId: {
          connectionId: ctx.connectionId,
          externalSettlementId: batch.batchId,
        },
      },
      create: {
        organizationId: ctx.organizationId,
        legalEntityId: ctx.legalEntityId,
        connectionId: ctx.connectionId,
        externalSettlementId: batch.batchId,
        amount: batch.netPaise,
        feeAmount: batch.lines.reduce((a, l) => a + l.feePaise, 0n),
        utr: batch.utr,
        status: "processed",
        settledAt: batch.paidOn,
        provider: format.provider,
        kind: kindOf(batch),
        raw: { source: "statement_import", label: format.label, lineCount: batch.lines.length } as Prisma.InputJsonValue,
      },
      update: {
        amount: batch.netPaise,
        feeAmount: batch.lines.reduce((a, l) => a + l.feePaise, 0n),
        utr: batch.utr,
        settledAt: batch.paidOn,
        provider: format.provider,
        kind: kindOf(batch),
      },
    });

    // Track what this file says the payout contains, so anything left over
    // from a previous import can be removed below.
    const seenKeys = new Set<string>();

    for (const line of batch.lines) {
      // A COD row must only ever resolve to a shipment and a prepaid row only
      // to a payment. Reading both maps for both types would let an order
      // number that exists on both sides attach a card capture to a parcel.
      const shipmentId = line.lineType === "SHIPMENT_COD" ? (shipmentByRef.get(line.reference) ?? null) : null;
      // Amount-specific first, then the plain reference. The specific key only
      // exists for orders with several captures, so for the ordinary one-line
      // one-payment case this is the same lookup it always was.
      const paymentId =
        line.lineType === "PAYMENT"
          ? (paymentByRef.get(refGrossKey(line.reference, line.grossPaise)) ?? paymentByRef.get(line.reference) ?? null)
          : null;
      if (line.lineType !== "ADJUSTMENT" && shipmentId === null && paymentId === null) {
        result.linesUnresolved += 1;
      }
      await prisma.settlementLine.upsert({
        where: {
          settlementId_type_externalReference: {
            settlementId: settlement.id,
            type: line.lineType,
            externalReference: line.reference,
          },
        },
        create: {
          organizationId: ctx.organizationId,
          settlementId: settlement.id,
          type: line.lineType,
          externalReference: line.reference,
          shipmentId,
          paymentId,
          grossAmount: line.grossPaise,
          feeAmount: line.feePaise,
          netAmount: line.netPaise,
          raw: line.row as Prisma.InputJsonValue,
        },
        update: {
          shipmentId,
          paymentId,
          grossAmount: line.grossPaise,
          feeAmount: line.feePaise,
          netAmount: line.netPaise,
        },
      });
      seenKeys.add(`${line.lineType}\u0000${line.reference}`);
      result.linesImported += 1;
    }

    // RE-IMPORT REPLACES A PAYOUT'S LINES, it does not merely add to them.
    //
    // SettlementLine is unique on (settlementId, type, externalReference), so a
    // line whose TYPE changes between imports — which is exactly what happens
    // when classification improves, e.g. a row that used to fall back to
    // SHIPMENT_COD now correctly reading as PAYMENT — upserts as a NEW row and
    // leaves the old one behind, double-counting the payout. Anything this file
    // did not mention is removed.
    const stale = await prisma.settlementLine.findMany({
      where: { settlementId: settlement.id },
      select: { id: true, type: true, externalReference: true },
    });
    const staleIds = stale
      .filter((l) => !seenKeys.has(`${l.type}\u0000${l.externalReference}`))
      .map((l) => l.id);
    if (staleIds.length > 0) {
      // Chunked for the same bind-variable ceiling as the lookups above. This
      // one is per-batch rather than per-file so it takes a much larger payout
      // to reach, but a marketplace's monthly settlement is exactly that.
      for (let i = 0; i < staleIds.length; i += LOOKUP_CHUNK) {
        await prisma.settlementLine.deleteMany({ where: { id: { in: staleIds.slice(i, i + LOOKUP_CHUNK) } } });
      }
      result.linesReplaced += staleIds.length;
    }

    result.batchesImported += 1;
    result.amountImportedPaise += batch.netPaise;
  }

  return result;
}
