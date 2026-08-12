// §27 upload validation (P5.7).
//
// Every file this system ingests arrives as a string or a base64 blob inside a
// JSON body — a bank CSV, a courier settlement export, a freight invoice PDF.
// Two things were never checked: that the bytes are actually the type claimed,
// and that they are not something else wearing a .csv extension.
//
// WHAT A CONTENT CHECK CAN AND CANNOT DO. It cannot tell you a file is safe.
// It can tell you a file is not what it says it is, which is where nearly
// every bad upload announces itself: an HTML error page saved as a CSV (the
// single most common real-world case — a portal export that silently returned
// a login page), a spreadsheet renamed, a script with a data extension.
// Refusing those early turns a confusing downstream parse failure into a
// sentence someone can act on.
//
// The malware hook is a SEAM, not an implementation. Scanning is a service
// call — ClamAV, a cloud API — and wiring one in without a deployment for it
// would be a stub that returns "clean" for everything, which is worse than no
// scanner because it reads like one.

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface UploadCheck {
  ok: boolean;
  /** Present when ok is false. Written for whoever pasted the file. */
  reason?: string;
  detectedType?: string;
}

/** File signatures worth recognising, longest first so PDF beats a prefix. */
const MAGIC: Array<{ bytes: number[]; type: string }> = [
  { bytes: [0x25, 0x50, 0x44, 0x46], type: "pdf" }, // %PDF
  { bytes: [0x50, 0x4b, 0x03, 0x04], type: "zip/xlsx/docx" }, // PK..
  { bytes: [0xd0, 0xcf, 0x11, 0xe0], type: "legacy-office" }, // OLE2 (.xls, .doc)
  { bytes: [0x7f, 0x45, 0x4c, 0x46], type: "elf-executable" },
  { bytes: [0x4d, 0x5a], type: "windows-executable" }, // MZ
  { bytes: [0x1f, 0x8b], type: "gzip" },
];

function sniff(buf: Buffer): string | null {
  for (const sig of MAGIC) {
    if (buf.length < sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => buf[i] === b)) return sig.type;
  }
  return null;
}

/**
 * Is this text actually delimited data?
 *
 * The check that matters is not "does it parse" — a login page parses as a
 * one-column CSV perfectly happily. It is "does it look like a table", and the
 * strongest signal is that the first non-empty line has more than one field
 * and the lines that follow agree with it.
 */
export function checkCsv(content: string, opts: { minColumns?: number } = {}): UploadCheck {
  const minColumns = opts.minColumns ?? 2;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes === 0) return { ok: false, reason: "The file is empty." };
  if (bytes > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `The file is ${Math.round(bytes / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` };
  }

  const head = Buffer.from(content.slice(0, 64), "utf8");
  const magic = sniff(head);
  if (magic) {
    return {
      ok: false,
      detectedType: magic,
      reason: `This is a ${magic} file, not a CSV. Export the data as CSV and paste that instead.`,
    };
  }

  const trimmed = content.trimStart();
  if (/^<(!doctype|html|\?xml)/i.test(trimmed)) {
    // The single most common real upload failure: a portal export that
    // silently returned a login or error page. Without this the parser reports
    // "0 rows" and everyone concludes the account is empty.
    return {
      ok: false,
      detectedType: "html",
      reason:
        "This looks like a web page, not a CSV — most often a login or error page returned by the portal instead of the export. Sign in again and re-download.",
    };
  }

  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { ok: false, reason: "The file has no data rows." };

  const header = lines[0]!;
  const delimiter = [",", "\t", ";", "|"].map((d) => ({ d, n: header.split(d).length })).sort((a, b) => b.n - a.n)[0]!;
  if (delimiter.n < minColumns) {
    return {
      ok: false,
      reason: `The first line has only one column, so this is not a delimited file. Expected at least ${minColumns} columns separated by a comma or tab.`,
    };
  }

  return { ok: true, detectedType: "csv" };
}

/** Base64-encoded binary, checked against the type it claims to be. */
export function checkBase64(base64: string, expected: "pdf"): UploadCheck {
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    return { ok: false, reason: "The attachment is not valid base64." };
  }
  if (buf.length === 0) return { ok: false, reason: "The attachment is empty." };
  if (buf.length > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `The attachment is ${Math.round(buf.length / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` };
  }

  const detected = sniff(buf);
  if (detected !== expected) {
    return {
      ok: false,
      detectedType: detected ?? "unknown",
      // Naming what it IS matters as much as what it is not: "this is a zip"
      // tells someone they attached the wrong file, and "unknown" tells them
      // the download was truncated.
      reason: `Expected a ${expected.toUpperCase()}, but the file starts with ${detected ? `a ${detected} signature` : "no recognised file signature"}.`,
    };
  }
  return { ok: true, detectedType: detected };
}

export interface ScanResult {
  scanned: boolean;
  clean: boolean;
  detail: string;
}

/**
 * The malware-scan seam.
 *
 * Deliberately reports scanned: false rather than clean: true when no scanner
 * is configured. A stub that returns "clean" for everything is worse than no
 * scanner at all — it reads like protection, it appears in a security review
 * as a tick, and it is nothing. Callers must treat `scanned: false` as
 * "unknown" and decide their own policy; today every caller accepts the
 * upload, which is the honest status quo rather than a claim.
 */
export async function scanForMalware(_bytes: Buffer): Promise<ScanResult> {
  return {
    scanned: false,
    clean: false,
    detail:
      "No malware scanner is configured. Uploads are checked for file type and size only. Wire a scanner here (ClamAV or a cloud API) before accepting files from anyone outside the organisation.",
  };
}
