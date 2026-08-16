import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";

// WHY THIS PROCESS FORKS, AND WHY THE WORKER DOES NOT.
//
// Node runs JavaScript on one thread. Every metric endpoint here computes money
// in JS — BigInt paise over tens of thousands of orders and line items — so a
// page that fires seventeen of them in parallel does not get seventeen
// computations at once. It gets one thread interleaving seventeen, and they all
// finish together at the end. Measured on the live box: fifteen requests began
// within 100ms of each other and every one returned at ~6.6s, while the same
// endpoint alone answered in 0.3s. Adding vCPUs did not help, because one
// process cannot use two cores.
//
// Forking does. Each child is a full Node instance with its own event loop, and
// the OS spreads them across cores. Requests are already independent — all
// state is in Postgres and Redis, nothing is held in process memory between
// requests — so there is nothing to share and no coordination to get wrong.
//
// The ceiling is the core count, not the worker count. On two vCPUs, two
// children is roughly twice the throughput and four is not better than two;
// they would just take turns. Hence the default below rather than a large
// number.
//
// WORKER_THREADS WAS THE WRONG TOOL for the same job. It shares memory inside
// one process, which would mean restructuring the calc modules to marshal
// paise arrays across a thread boundary — weeks of risk in the exact code that
// must never get money wrong, to buy what forking buys today for free.
//
// src/worker.ts is deliberately untouched. It is a different entrypoint from
// the same image, and it must stay a single process: it owns the five nightly
// schedules and SYNC_WORKER_CONCURRENCY, so a second copy would double sync
// concurrency and race the sweeps.
const requested = env.API_CLUSTER_WORKERS ?? availableParallelism();
// Never more children than cores. Over-forking costs context switches and
// memory (each child carries its own Prisma pool) and buys nothing.
const workers = Math.max(1, Math.min(requested, availableParallelism()));

if (cluster.isPrimary && workers > 1) {
  logger.info({ workers, cores: availableParallelism() }, "api_cluster_starting");

  // Declared before the exit handler that reads it, not after — the handler
  // only fires later so a hoisted `let` would work, but a reader should not
  // have to prove that.
  let shuttingDown = false;

  for (let i = 0; i < workers; i++) cluster.fork();

  // A child that dies takes its in-flight requests with it; replacing it keeps
  // capacity up. Guarded against a crash loop: if children are dying faster
  // than one a second, the fault is deterministic (a bad migration, a missing
  // env var) and respawning forever would bury the error under restart noise
  // instead of surfacing it.
  let recentExits = 0;
  setInterval(() => {
    recentExits = 0;
  }, 10_000).unref();

  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    recentExits += 1;
    if (recentExits > workers * 2) {
      logger.fatal({ code, signal, recentExits }, "api_cluster_crash_loop_giving_up");
      process.exit(1);
    }
    logger.error({ pid: worker.process.pid, code, signal }, "api_worker_died_respawning");
    cluster.fork();
  });

  // Cloud platforms and `docker compose down` send SIGTERM to the primary only.
  // Without this the children are left to be SIGKILLed after the grace period,
  // cutting live requests instead of letting them finish.
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "api_cluster_shutting_down");
    for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill(signal);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} else {
  // Imported here rather than at the top of the file so the primary never
  // builds an Express app, opens a Prisma pool, or connects to Redis. It
  // supervises; it does not serve.
  const { createApp } = await import("./app.js");
  const app = createApp();

  // Last-resort net for rejections outside the request cycle (fire-and-forget
  // syncs, timers), which express-async-errors cannot reach. Log loudly and keep
  // serving — one background failure must not take the API down for every page.
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled_rejection");
  });

  // Every child listens on the same port; the primary distributes connections.
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, pid: process.pid, clustered: workers > 1 }, "cfo-backend listening");
  });
}
