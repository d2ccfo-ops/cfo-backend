import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

// The isolated half of the P1.2 hardening: pdf-parse runs HERE, on its own
// thread, never on the request thread. A crafted PDF that makes pdfjs loop or
// allocate can stall this thread — see lib/workerTimeout.ts — but the event
// loop handling the next inbound email is unaffected, and the caller's
// deadline kills this thread outright if it doesn't respond in time.
//
// Spawned via `new Worker(new URL("./pdfWorker.js", import.meta.url), ...)`
// from invoice.ts. Under `tsx watch` that URL resolves back to THIS .ts file
// (tsx's loader honours the .js-for-.ts convention the whole codebase already
// uses for imports), but worker_threads does NOT inherit the parent's loader
// hooks automatically — a worker spawned without help sees a raw .ts file and
// fails to parse it. Passing `execArgv: ["--import", "tsx"]` (done only when
// the parent detected it is itself running from a .ts file — see invoice.ts)
// re-registers tsx's hook inside this thread before it runs. In production,
// tsc has already compiled this to dist/.../pdfWorker.js, so no execArgv or
// TS loader is involved at all — the worker just runs.
const require = createRequire(import.meta.url);

interface PdfWorkerInput {
  bytes: Uint8Array;
}
type PdfWorkerOutput = { ok: true; text: string } | { ok: false; message: string };

async function extractText({ bytes }: PdfWorkerInput): Promise<PdfWorkerOutput> {
  try {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: bytes });
    const result = await parser.getText();
    return { ok: true, text: result.text };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

extractText(workerData as PdfWorkerInput).then((result) => {
  parentPort!.postMessage(result);
});
