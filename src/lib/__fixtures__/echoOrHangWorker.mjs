// Plain .mjs, deliberately not TypeScript: workerTimeout.test.ts spawns this
// as a REAL worker_thread to exercise runInWorkerWithTimeout end to end (real
// OS thread, real message passing, real kill-on-timeout) without needing
// tsx's loader inside the test runner. Two behaviors, selected by input:
//   { hangMs: <n> }  — sleeps synchronously (busy-loop, not setTimeout) for
//                      n ms before responding, simulating a parser that
//                      won't yield the event loop — the exact failure mode
//                      the timeout exists to catch.
//   anything else    — echoes the input straight back.
import { parentPort, workerData } from "node:worker_threads";

if (typeof workerData?.hangMs === "number") {
  const until = Date.now() + workerData.hangMs;
  while (Date.now() < until) {
    /* busy-wait: blocks this thread's event loop on purpose */
  }
}
parentPort.postMessage(workerData);
