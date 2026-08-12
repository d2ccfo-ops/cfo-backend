import { createRequire } from "node:module";
import { prisma } from "../../../lib/prisma.js";

const require = createRequire(import.meta.url);

// Bluedart's freight TAX INVOICE — what they charge you to carry a parcel.
//
// This is NOT the COD remittance MIS and must never be mistaken for it. The
// `Amount` column is a courier CHARGE, not cash collected from a customer. A
// COD parcel appears here for its freight and appears in the remittance for its
// ₹799 — reading one as the other would either double-count revenue or record a
// cost as income.
//
// Why a PDF parser at all: Bluedart bills as PDF. The shipment annexure has no
// CSV equivalent for most accounts, and `Shipment.freightAmount` — NULL on all
// 21,144 shipments on the live store — has no other source. Shipping cost is one
// of the two halves of contribution margin (COGS is the other), so this file is
// the difference between "we sold ₹2.6 Cr" and "we made or lost money doing it".
//
// The line grammar, verified against three real invoices:
//
//   01/07/2026 (R)80092970506 BENGALURU NDx 0.50 5.82\t1
//   └ ship date  └ AWB        └ dest    └ svc └ kg  └ amt └ s.no
//
//  - `(R)` marks a RETURN leg: the parcel came back and you were billed again.
//    Kept as its own flag, because an RTO costing freight twice is a real and
//    reportable cost, not a duplicate row to discard.
//  - Amounts can be NEGATIVE (credits/adjustments). Measured: −₹307.52 on one
//    row. Dropping the sign would silently inflate your shipping cost.

export interface InvoiceLine {
  awb: string;
  shipDate: Date;
  destination: string;
  serviceType: string;
  chargedWeightKg: number;
  /** paise, signed — negative rows are credits Bluedart issued back */
  amountPaise: bigint;
  /** True when the row carries Bluedart's (R) prefix: a return-leg charge. */
  isReturnLeg: boolean;
  serialNo: number;
}

export interface ParsedInvoice {
  invoiceNo: string;
  invoiceDate: Date | null;
  customerAccount: string | null;
  /** e.g. "Etail Air COD" / "Etail Air Prepaid" — the COD/prepaid split. */
  product: string | null;
  lines: InvoiceLine[];
  /** The "Total" that Bluedart states for the freight lines, in paise. */
  statedLineTotalPaise: bigint | null;
  /** Grand total including surcharges and GST — NOT the sum of the lines. */
  grandTotalPaise: bigint | null;
  /** Sum of the parsed lines, so a caller can compare it to the stated total. */
  summedLinePaise: bigint;
  warnings: string[];
}

// "01/07/2026" — Bluedart writes dd/MM/yyyy throughout. Parsed explicitly
// rather than through Date(), which reads it as the American month-first form
// and silently turns 07 January into 01 July for every row before the 13th.
function parseDdMmYyyy(value: string): Date | null {
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return Number.isNaN(date.getTime()) ? null : date;
}

// Rupees with optional sign and thousands separators → paise, as an integer.
// Never via parseFloat: 5.82 is not exactly representable, and 930 rows of
// accumulated float error is exactly the drift the checksum below would then
// fail to catch.
function rupeesToPaise(raw: string): bigint | null {
  const cleaned = raw.replace(/,/g, "").trim();
  const m = cleaned.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const [, sign, whole, frac = ""] = m;
  const paise = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, "0"));
  return sign === "-" ? -paise : paise;
}

// One shipment row. Anchored on the 11-digit AWB rather than on column
// positions: pdf text extraction reflows whitespace between releases, but the
// waybill is a fixed-width identifier that cannot be mistaken for a weight or
// an amount.
const LINE_RE =
  /^(\d{2}\/\d{2}\/\d{4})\s+(\(R\))?(\d{9,12})\s+(.+?)\s+([A-Za-z]+)\s+(\d+\.\d{2})\s+(-?[\d,]+\.\d{2})(?:\s|\t|$)/;

export function parseBluedartInvoiceText(text: string): ParsedInvoice {
  const lines = text.split("\n");
  const warnings: string[] = [];
  const out: InvoiceLine[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    const [, dateStr, retFlag, awb, dest, svc, weight, amount] = m;

    const shipDate = parseDdMmYyyy(dateStr!);
    const amountPaise = rupeesToPaise(amount!);
    if (!shipDate || amountPaise === null) {
      warnings.push(`unreadable row: ${raw.trim().slice(0, 80)}`);
      continue;
    }

    // The same AWB legitimately appears twice — once outbound, once as a
    // return leg — so the key includes the flag and the amount. Only an exact
    // repeat is a duplicate, which happens when a caller uploads the same
    // invoice twice.
    const key = `${awb}|${retFlag ?? ""}|${amountPaise}|${dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      awb: awb!,
      shipDate,
      destination: dest!.trim(),
      serviceType: svc!,
      chargedWeightKg: Number(weight),
      amountPaise,
      isReturnLeg: retFlag === "(R)",
      serialNo: out.length + 1,
    });
  }

  const header = (label: RegExp): string | null => {
    const idx = lines.findIndex((l) => label.test(l));
    if (idx === -1) return null;
    const inline = lines[idx]!.replace(label, "").replace(/^[:\s]+/, "").trim();
    if (inline) return inline;
    // Bluedart's layout puts several labels in a block and their values in a
    // following block, so the value is looked for on the next non-empty,
    // non-label line rather than assumed to sit on the same one.
    for (let i = idx + 1; i < Math.min(idx + 6, lines.length); i += 1) {
      const v = lines[i]!.trim();
      if (v && v !== ":" && !/^[A-Za-z ]+:$/.test(v)) return v;
    }
    return null;
  };

  const invoiceNo = lines.find((l) => /^\d{7}R\d{8}$/.test(l.trim()))?.trim() ?? header(/Invoice No\.?/) ?? "";
  const product = lines.find((l) => /^Etail\s+\w+/.test(l.trim()))?.trim() ?? null;
  const account = lines.find((l) => /^[A-Z]{3}\d{6}\s*\(/.test(l.trim()))?.trim().split(/\s+/)[0] ?? null;
  const invoiceDateRaw = lines.find((l) => /^Invoice Date/.test(l.trim()))?.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1];

  // "Total 62,474.83" — the freight subtotal Bluedart states for the annexure.
  // Compared against our sum below; a mismatch means a row was missed, which is
  // the failure this whole parser has to be able to detect.
  const statedTotal = (() => {
    for (const l of lines) {
      const m = l.match(/^Total\s+([\d,]+\.\d{2})$/);
      if (m) return rupeesToPaise(m[1]!);
    }
    return null;
  })();
  const grandTotal = (() => {
    for (const l of lines) {
      const m = l.match(/^Grand Total\s+([\d,]+\.\d{2})$/);
      if (m) return rupeesToPaise(m[1]!);
    }
    return null;
  })();

  const summed = out.reduce((sum, l) => sum + l.amountPaise, 0n);
  if (statedTotal !== null && statedTotal !== summed) {
    warnings.push(
      `line total mismatch: invoice states ₹${(Number(statedTotal) / 100).toFixed(2)}, parsed rows sum to ₹${(Number(summed) / 100).toFixed(2)}`
    );
  }
  if (out.length === 0) warnings.push("no shipment rows found — is this a Bluedart freight invoice?");

  return {
    invoiceNo,
    invoiceDate: invoiceDateRaw ? parseDdMmYyyy(invoiceDateRaw) : null,
    customerAccount: account,
    product,
    lines: out,
    statedLineTotalPaise: statedTotal,
    grandTotalPaise: grandTotal,
    summedLinePaise: summed,
    warnings,
  };
}

export async function parseBluedartInvoicePdf(data: Buffer | Uint8Array): Promise<ParsedInvoice> {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(data) });
  const result = await parser.getText();
  return parseBluedartInvoiceText(result.text);
}

export interface InvoiceApplyResult {
  invoiceId: string;
  invoiceNo: string;
  product: string | null;
  invoiceDate: Date | null;
  linesParsed: number;
  shipmentsMatched: number;
  shipmentsUpdated: number;
  /** AWBs the invoice bills for that this system has never seen. */
  unmatchedAwbs: string[];
  returnLegCount: number;
  returnLegPaise: bigint;
  creditCount: number;
  creditPaise: bigint;
  totalFreightPaise: bigint;
  /** True when this invoice number had already been imported and was replaced. */
  replacedExisting: boolean;
  warnings: string[];
}

/**
 * Persists a parsed invoice and writes freight cost onto the shipments it bills
 * for.
 *
 * A shipment can be billed more than once — outbound plus a return leg — so
 * `freightAmount` is the SUM of every line for that AWB rather than the last
 * one seen. An RTO that cost freight twice must read as twice the cost.
 *
 * Re-uploading the same invoice replaces it rather than adding to it. The
 * courier's own invoice number is the key, so a merchant who uploads the same
 * PDF twice — or uploads a folder containing it twice — does not end up paying
 * for the same parcel twice on paper.
 */
export async function applyInvoice(
  organizationId: string,
  legalEntityId: string,
  connectionId: string,
  parsed: ParsedInvoice,
  fileName?: string
): Promise<InvoiceApplyResult> {
  // The invoice number is the dedupe key. Without one, every invoice would
  // collide on the empty string and each upload would DELETE the last — which
  // is exactly what happened the first time this was tested. The route refuses
  // these earlier, but a function that silently destroys data when its caller
  // forgets a check is the wrong shape.
  if (!parsed.invoiceNo) {
    throw new Error("cannot apply a freight invoice with no invoice number — it is the key re-uploads dedupe on");
  }

  const byAwb = new Map<string, bigint>();
  for (const line of parsed.lines) {
    byAwb.set(line.awb, (byAwb.get(line.awb) ?? 0n) + line.amountPaise);
  }

  const awbs = [...byAwb.keys()];
  // Chunked: `IN` with 930 parameters is fine, but a year of invoices uploaded
  // at once would push a single query past what the driver will bind.
  const idByAwb = new Map<string, string>();
  for (let i = 0; i < awbs.length; i += 1000) {
    const found = await prisma.shipment.findMany({
      where: { organizationId, awbCode: { in: awbs.slice(i, i + 1000) } },
      select: { id: true, awbCode: true },
    });
    for (const s of found) idByAwb.set(s.awbCode!, s.id);
  }

  const existing = await prisma.freightInvoice.findUnique({
    where: { organizationId_invoiceNo: { organizationId, invoiceNo: parsed.invoiceNo } },
    select: { id: true },
  });

  // Header and lines in one transaction: an invoice whose lines half-wrote
  // would state a total its rows do not sum to, which is precisely the
  // condition the upload refuses on.
  const invoice = await prisma.$transaction(async (tx) => {
    if (existing) {
      // Lines cascade on delete, so replacing is a clean swap rather than a
      // merge that could leave rows from a superseded parse behind.
      await tx.freightInvoice.delete({ where: { id: existing.id } });
    }
    const created = await tx.freightInvoice.create({
      data: {
        organizationId,
        legalEntityId,
        connectionId,
        invoiceNo: parsed.invoiceNo,
        invoiceDate: parsed.invoiceDate,
        customerAccount: parsed.customerAccount,
        product: parsed.product,
        carrier: "bluedart",
        statedTotal: parsed.statedLineTotalPaise,
        grandTotal: parsed.grandTotalPaise,
        lineTotal: parsed.summedLinePaise,
        lineCount: parsed.lines.length,
        fileName: fileName ?? null,
      },
      select: { id: true },
    });
    await tx.freightInvoiceLine.createMany({
      data: parsed.lines.map((l) => ({
        organizationId,
        invoiceId: created.id,
        awb: l.awb,
        // Null here is the finding, not a gap: the courier billed for a parcel
        // this system has no record of.
        shipmentId: idByAwb.get(l.awb) ?? null,
        shipDate: l.shipDate,
        destination: l.destination,
        serviceType: l.serviceType,
        chargedWeightKg: l.chargedWeightKg,
        amount: l.amountPaise,
        isReturnLeg: l.isReturnLeg,
      })),
    });
    return created;
  });

  // Freight is now derived from ALL invoices covering a shipment, not just this
  // one. Uploading the prepaid invoice after the COD invoice must not erase the
  // charge the first one recorded.
  let updated = 0;
  const matchedAwbs = awbs.filter((a) => idByAwb.has(a));
  for (let i = 0; i < matchedAwbs.length; i += 500) {
    const chunk = matchedAwbs.slice(i, i + 500);
    const totals = await prisma.freightInvoiceLine.groupBy({
      by: ["awb"],
      where: { organizationId, awb: { in: chunk } },
      _sum: { amount: true },
    });
    for (const t of totals) {
      const id = idByAwb.get(t.awb);
      if (!id) continue;
      await prisma.shipment.update({
        where: { id },
        data: { freightAmount: t._sum.amount ?? 0n },
      });
      updated += 1;
    }
  }

  const returnLegs = parsed.lines.filter((l) => l.isReturnLeg);
  const credits = parsed.lines.filter((l) => l.amountPaise < 0n);

  return {
    invoiceId: invoice.id,
    invoiceNo: parsed.invoiceNo,
    product: parsed.product,
    invoiceDate: parsed.invoiceDate,
    linesParsed: parsed.lines.length,
    shipmentsMatched: idByAwb.size,
    shipmentsUpdated: updated,
    // Reported, never silently dropped: an AWB Bluedart billed us for and this
    // system has no record of means a parcel was shipped outside the connected
    // store, which is a finding rather than noise.
    unmatchedAwbs: awbs.filter((a) => !idByAwb.has(a)),
    returnLegCount: returnLegs.length,
    returnLegPaise: returnLegs.reduce((s, l) => s + l.amountPaise, 0n),
    creditCount: credits.length,
    creditPaise: credits.reduce((s, l) => s + l.amountPaise, 0n),
    totalFreightPaise: parsed.summedLinePaise,
    replacedExisting: existing !== null,
    warnings: parsed.warnings,
  };
}

// The parse-check-apply pipeline as one call, shared by the Connections-page
// upload route and the inbound-email path. The refusal rules live HERE, once:
// two copies of "refuse on total mismatch" is how one of them stops refusing.
export type InvoicePdfOutcome =
  | ({ ok: true; fileName?: string } & ReturnType<typeof serializeApplyResult>)
  | {
      ok: false;
      fileName?: string;
      error: "total_mismatch" | "no_shipment_rows" | "no_invoice_number" | "unreadable_pdf";
      statedPaise?: string;
      summedPaise?: string;
      linesParsed?: number;
      warnings?: string[];
      detail?: string;
    };

export async function ingestInvoicePdfDocument(
  // A resolver is accepted as well as a row, so a caller that would have to
  // CREATE the connection (the email path auto-creates a provenance anchor)
  // only does so once the document has passed every refusal check — a rejected
  // PDF must not leave a connection behind as a side effect.
  connection:
    | { id: string; organizationId: string; legalEntityId: string }
    | (() => Promise<{ id: string; organizationId: string; legalEntityId: string }>),
  pdf: Buffer,
  fileName?: string
): Promise<InvoicePdfOutcome> {
  let parsed: ParsedInvoice;
  try {
    parsed = await parseBluedartInvoicePdf(pdf);
  } catch (err) {
    return { ok: false, fileName, error: "unreadable_pdf", detail: (err as Error).message };
  }

  // "No rows" is checked FIRST. A total-vs-sum comparison is only meaningful
  // once at least one row was read — otherwise a non-Bluedart PDF that merely
  // contains a "Total 5,900.00" line reads as a checksum failure ("rows sum to
  // a different total") rather than the truthful "this isn't a freight invoice".
  if (parsed.lines.length === 0) {
    return { ok: false, fileName, error: "no_shipment_rows", warnings: parsed.warnings };
  }
  // Refused, not imported with a warning. A freight invoice whose rows do not
  // sum to its own stated total means the parser missed lines, and a partial
  // cost silently understates every margin computed from it.
  if (parsed.statedLineTotalPaise !== null && parsed.statedLineTotalPaise !== parsed.summedLinePaise) {
    return {
      ok: false,
      fileName,
      error: "total_mismatch",
      statedPaise: parsed.statedLineTotalPaise.toString(),
      summedPaise: parsed.summedLinePaise.toString(),
      linesParsed: parsed.lines.length,
    };
  }
  if (!parsed.invoiceNo) {
    // Without the courier's invoice number there is no key to dedupe on, so a
    // re-upload would silently double the freight on every parcel it covers.
    return { ok: false, fileName, error: "no_invoice_number", warnings: parsed.warnings };
  }

  const conn = typeof connection === "function" ? await connection() : connection;
  const result = await applyInvoice(conn.organizationId, conn.legalEntityId, conn.id, parsed, fileName);
  return { ok: true, fileName, ...serializeApplyResult(result) };
}

export function serializeApplyResult(r: InvoiceApplyResult) {
  return {
    ...r,
    returnLegPaise: r.returnLegPaise.toString(),
    creditPaise: r.creditPaise.toString(),
    totalFreightPaise: r.totalFreightPaise.toString(),
    unmatchedAwbs: r.unmatchedAwbs.slice(0, 50),
    unmatchedCount: r.unmatchedAwbs.length,
  };
}
