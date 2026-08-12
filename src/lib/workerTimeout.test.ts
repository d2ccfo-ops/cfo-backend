import { describe, expect, it } from "vitest";
import { runInWorkerWithTimeout } from "./workerTimeout.js";

// Real worker_threads, real OS timers — no mocking. The fixture is plain
// .mjs so this test needs no TS-in-worker loader (pdfWorker.ts's own tsx
// wiring is instead exercised by scripts/checkEmailIngest.ts's poison-PDF
// case and a live minimal-PDF check, since it needs pdf-parse itself).
const WORKER = new URL("./__fixtures__/echoOrHangWorker.mjs", import.meta.url);

describe("runInWorkerWithTimeout", () => {
  it("resolves with the worker's response when it finishes in time", async () => {
    const result = await runInWorkerWithTimeout<{ echo: string }, { echo: string }>(WORKER, { echo: "hi" }, 5000);
    expect(result).toEqual({ ok: true, value: { echo: "hi" } });
  });

  it("kills the worker and reports a timeout when it doesn't yield in time", async () => {
    const result = await runInWorkerWithTimeout(WORKER, { hangMs: 2000 }, 200);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
      expect(result.detail).toMatch(/200ms/);
    }
  }, 10_000);

  it("does not report a false timeout for fast work under the deadline", async () => {
    const result = await runInWorkerWithTimeout(WORKER, { hangMs: 20 }, 2000);
    expect(result.ok).toBe(true);
  });

  it("surfaces a bad worker path as worker_error, not a silent hang", async () => {
    const result = await runInWorkerWithTimeout(new URL("./__fixtures__/does-not-exist.mjs", import.meta.url), {}, 2000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("worker_error");
  });
});
