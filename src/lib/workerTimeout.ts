import { Worker } from "node:worker_threads";

// Runs one piece of untrusted-input work in an isolated worker thread with a
// hard wall-clock deadline, killing the thread if it's breached. Generic
// rather than PDF-specific: any future parser fed attacker-reachable bytes
// (an XLSX parser, say) needs the identical shape — spawn, deadline, kill,
// reject — and duplicating this per-parser is how one of the copies drifts
// and stops actually enforcing the timeout.
//
// One worker per call, not a pool: this guards a request-scoped operation
// (one attachment) at the traffic this system sees, and a pool's queueing and
// restart-on-crash machinery is complexity the plan didn't ask for.
export interface WorkerTimeoutResult<T> {
  ok: true;
  value: T;
}
export interface WorkerTimeoutError {
  ok: false;
  reason: "timeout" | "worker_error" | "worker_exit";
  detail: string;
}

export async function runInWorkerWithTimeout<TIn, TOut>(
  workerUrl: URL,
  data: TIn,
  timeoutMs: number,
  // tsx's dev loader doesn't propagate into a freshly spawned thread on its
  // own — see pdfWorker.ts's header comment for why this is conditional.
  execArgv: string[] = []
): Promise<WorkerTimeoutResult<TOut> | WorkerTimeoutError> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(workerUrl, { workerData: data, execArgv });

    const finish = (result: WorkerTimeoutResult<TOut> | WorkerTimeoutError) => {
      if (settled) return; // a message and a late error/exit racing must only resolve once
      settled = true;
      clearTimeout(timer);
      // Both branches: terminate is a no-op on an already-exited worker, and
      // awaiting it here would delay resolving on the happy path for no
      // reason — the thread's teardown doesn't gate the caller's answer.
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", detail: `worker exceeded ${timeoutMs}ms and was killed` });
    }, timeoutMs);

    worker.once("message", (value: TOut) => finish({ ok: true, value }));
    worker.once("error", (err) => finish({ ok: false, reason: "worker_error", detail: err.message }));
    worker.once("exit", (code) => {
      // A message already resolved this — a normal exit follows it and must
      // not overwrite a success with a manufactured failure.
      if (!settled) finish({ ok: false, reason: "worker_exit", detail: `worker exited with code ${code} before responding` });
    });
  });
}
