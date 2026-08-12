import { runInWorkerWithTimeout } from "../../lib/workerTimeout.js";

// Converts an .xlsx attachment's first sheet into the same CSV text shape
// every downstream parser already expects (detectCsvFormat,
// looksLikeBankStatementCsv, parseStatementCsv) — one converter in front of
// the existing text pipeline, rather than a second copy of every format's
// parsing logic that only reads cells instead of CSV lines.
const XLSX_PARSE_TIMEOUT_MS = 20_000;
const RUNNING_FROM_TS_SOURCE = import.meta.url.endsWith(".ts");
const XLSX_WORKER_URL = new URL(RUNNING_FROM_TS_SOURCE ? "./xlsxWorker.ts" : "./xlsxWorker.js", import.meta.url);

export type XlsxToCsvResult = { ok: true; csv: string } | { ok: false; detail: string };

// Excel stores dates as serial numbers with a formatting template, not a
// real date type — read-excel-file already resolved that ambiguity into a JS
// Date for us. Rendered here as YYYY-MM-DD, the exact format
// parseStatementCsv (and every courier CSV format) requires.
export function cellToCsvSafe(value: unknown): string | number | boolean | null {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return value as string | number | boolean | null;
}

function csvField(value: unknown): string {
  const safe = cellToCsvSafe(value);
  if (safe === null || safe === undefined) return "";
  const s = String(safe);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\n");
}

export async function convertXlsxToCsv(data: Buffer | Uint8Array): Promise<XlsxToCsvResult> {
  const result = await runInWorkerWithTimeout<{ bytes: Uint8Array }, { ok: true; rows: unknown[][] } | { ok: false; message: string }>(
    XLSX_WORKER_URL,
    { bytes: new Uint8Array(data) },
    XLSX_PARSE_TIMEOUT_MS,
    RUNNING_FROM_TS_SOURCE ? ["--import", "tsx"] : []
  );
  if (!result.ok) {
    return {
      ok: false,
      detail: result.reason === "timeout" ? `Excel parsing timed out after ${XLSX_PARSE_TIMEOUT_MS}ms` : result.detail,
    };
  }
  if (!result.value.ok) {
    return { ok: false, detail: result.value.message };
  }
  if (result.value.rows.length === 0) {
    return { ok: false, detail: "the spreadsheet's first sheet is empty" };
  }
  return { ok: true, csv: rowsToCsv(result.value.rows) };
}
