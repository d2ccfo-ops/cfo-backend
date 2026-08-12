import { parentPort, workerData } from "node:worker_threads";
import { readSheet } from "read-excel-file/node";

// Same isolation as pdfWorker.ts, same reason: parsing an attacker-reachable
// email attachment. An .xlsx is a zip of XML — a crafted archive can make the
// XML parser loop or allocate far past what the compressed bytes suggest, so
// this runs on its own thread with the caller's hard deadline
// (lib/workerTimeout.ts) rather than on the request thread.
//
// Spawned via `new Worker(new URL("./xlsxWorker.js", import.meta.url), ...)`
// from xlsxToCsv.ts — see pdfWorker.ts's header comment for the tsx-vs-compiled
// execArgv wiring, reused identically here.

interface XlsxWorkerInput {
  bytes: Uint8Array;
}
// Raw cell values as read-excel-file returns them (string | number | boolean
// | Date | null) — deliberately not converted to CSV text here. The
// Date-to-"YYYY-MM-DD" and CSV-quoting logic lives in xlsxToCsv.ts as plain
// exported functions instead, so it's unit-testable without a worker thread
// or a real .xlsx fixture; this worker's only job is calling readSheet.
type XlsxWorkerOutput = { ok: true; rows: unknown[][] } | { ok: false; message: string };

async function convert({ bytes }: XlsxWorkerInput): Promise<XlsxWorkerOutput> {
  try {
    const rows = await readSheet(Buffer.from(bytes));
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

convert(workerData as XlsxWorkerInput).then((result) => {
  parentPort!.postMessage(result);
});
