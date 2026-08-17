/**
 * Runs named async tasks a fixed number at a time, keeping successes and
 * failures apart.
 *
 * Lives here rather than inside routes/metrics.ts so that the two behaviours
 * that matter can be tested directly, because neither is visible from a
 * happy-path response: that the concurrency bound is actually respected, and
 * that one throwing task cannot take the others down with it.
 */

export interface BoundedTask {
  key: string;
  run: () => Promise<unknown>;
}

export interface BoundedResult {
  ok: Record<string, unknown>;
  failed: Record<string, string>;
}

export async function runBounded(tasks: BoundedTask[], limit: number): Promise<BoundedResult> {
  const ok: Record<string, unknown> = {};
  const failed: Record<string, string> = {};
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const task = tasks[i];
      if (!task) return;
      try {
        ok[task.key] = await task.run();
      } catch (err) {
        // A failing metric is recorded, not thrown. Before the batched
        // endpoint existed each card failed alone; if one throw took the whole
        // response down, batching would have made the page more fragile than
        // the sixteen requests it replaced.
        failed[task.key] = err instanceof Error ? err.message : String(err);
      }
    }
  };

  // Never start more workers than there is work, or `limit` empty workers spin
  // up to immediately return on a two-task list.
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, () => worker()));
  return { ok, failed };
}
