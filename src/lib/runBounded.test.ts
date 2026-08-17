import { describe, expect, it } from "vitest";
import { runBounded } from "./runBounded.js";

// The batched overview leans on two properties that a successful response does
// not demonstrate: that the pool is actually protected, and that one broken
// metric leaves the other twelve intact.

const deferred = () => {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("runBounded", () => {
  it("never runs more than `limit` tasks at once", async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      key: `t${i}`,
      run: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return i;
      },
    }));

    const { ok, failed } = await runBounded(tasks, 4);

    // The whole point of the bound. Prisma's pool is 10 per child, so a
    // fan-out that ignored this could starve every other request on that child.
    expect(peak).toBe(4);
    expect(Object.keys(ok)).toHaveLength(20);
    expect(failed).toEqual({});
    expect(ok.t19).toBe(19);
  });

  it("keeps a rejecting task from taking the others down", async () => {
    const { ok, failed } = await runBounded(
      [
        { key: "good", run: async () => "fine" },
        { key: "bad", run: async () => { throw new Error("postgres said no"); } },
        { key: "alsoGood", run: async () => 42 },
      ],
      2,
    );

    expect(ok).toEqual({ good: "fine", alsoGood: 42 });
    // The real message, not a placeholder — whoever reads the 207 needs to know
    // which metric broke and why.
    expect(failed).toEqual({ bad: "postgres said no" });
  });

  it("reports a non-Error rejection rather than swallowing it", async () => {
    const { failed } = await runBounded([{ key: "odd", run: () => Promise.reject("just a string") }], 1);
    expect(failed.odd).toBe("just a string");
  });

  it("starts the next task as soon as a slot frees, not in lockstep batches", async () => {
    // A naive chunked implementation waits for all of batch N before starting
    // batch N+1, so the slowest task in each chunk sets the pace. With three
    // slots and one slow task, the two fast ones must be free to keep going.
    const slow = deferred();
    const order: string[] = [];
    const mk = (key: string, p?: Promise<unknown>) => ({
      key,
      run: async () => {
        if (p) await p;
        order.push(key);
        return key;
      },
    });

    const run = runBounded([mk("slow", slow.promise), mk("a"), mk("b"), mk("c")], 2);
    // a, b and c should all finish while `slow` is still pending.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["a", "b", "c"]);

    slow.resolve(null);
    const { ok, failed } = await run;
    expect(Object.keys(ok).sort()).toEqual(["a", "b", "c", "slow"]);
    expect(failed).toEqual({});
  });

  it("handles an empty task list without hanging", async () => {
    await expect(runBounded([], 4)).resolves.toEqual({ ok: {}, failed: {} });
  });
});
