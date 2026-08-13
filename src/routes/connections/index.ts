import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { readSyncHealth } from "../../modules/sync/health.js";
import { readDeadLetters } from "../../modules/sync/deadLetters.js";
import { requireAuth } from "../../middleware/auth.js";
import { writeAudit } from "../../lib/audit.js";
import { claimAndEnqueueSync } from "../../modules/queue/syncQueue.js";

export const connectionsRouter = Router();

// The CONNECTORS map / cursorFor() that used to live here moved to
// modules/queue/syncWorker.ts — that's the only place that still calls
// connector.sync() directly now (see the route below).

connectionsRouter.get("/", ...requireAuth, async (req, res) => {
  const connections = await prisma.connection.findMany({
    where: { organizationId: req.auth!.organizationId },
    select: {
      id: true,
      provider: true,
      status: true,
      externalAccountId: true,
      lastSyncedAt: true,
      createdAt: true,
      openingBalanceMinor: true,
      openingBalanceDate: true,
      syncStatus: true,
      lastSyncError: true,
      syncProgressCurrent: true,
      syncProgressTotal: true,
      syncStartedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  // BigInt doesn't serialize via JSON.stringify — express's res.json() would
  // throw on openingBalanceMinor otherwise.
  res.json({
    connections: connections.map((c) => ({
      ...c,
      openingBalanceMinor: c.openingBalanceMinor == null ? null : c.openingBalanceMinor.toString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /connections/health — the pattern across every connection (P5.5)
// ---------------------------------------------------------------------------
// Registered ABOVE the /:connectionId routes on purpose. Express matches in
// definition order, and a literal segment that lives below a parameterised one
// is a bug waiting for someone to add GET /:connectionId.
//
// What this answers that no single connection's status can: four consecutive
// runs that fetched nothing, on a store that takes orders daily, is a dead
// feed reporting success. syncStatus only ever describes the last attempt.
connectionsRouter.get("/health", ...requireAuth, async (req, res) => {
  const [connections, dlq] = await Promise.all([
    readSyncHealth(req.auth!.organizationId),
    readDeadLetters(req.auth!.organizationId),
  ]);
  res.json({ connections, deadLetters: dlq });
});

// Sets the balance anchor modules/calc/cash.ts's available-cash figure needs
// — meaningful for BANK and BANK_AA only (see Connection.openingBalanceMinor's
// schema comment), but kept provider-agnostic here rather than duplicated
// per provider. Separate from connecting since a founder often adds the
// account before they've looked up the exact balance for a specific date.
// Settable any time, not just once (correcting a typo, resetting the anchor
// to a more recent statement date).
connectionsRouter.patch("/:connectionId/opening-balance", ...requireAuth, async (req, res) => {
  const { balanceRupees, asOfDate } = req.body ?? {};
  // Number.isFinite, not just !isNaN: Infinity passes an isNaN check and then
  // throws inside BigInt() when the rupee figure is converted to paise,
  // turning a malformed request into a 500. The magnitude bound keeps a
  // plausible-but-absurd balance from becoming an unreadable paise integer.
  if (
    typeof balanceRupees !== "number" ||
    !Number.isFinite(balanceRupees) ||
    Math.abs(balanceRupees) > 1e14 ||
    !asOfDate
  ) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }
  const parsedDate = new Date(asOfDate);
  if (Number.isNaN(parsedDate.getTime())) {
    res.status(400).json({ error: "invalid_date" });
    return;
  }

  const connection = await prisma.connection.findFirst({
    where: {
      id: req.params.connectionId,
      organizationId: req.auth!.organizationId,
      provider: { in: ["BANK", "BANK_AA"] },
    },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await prisma.connection.update({
    where: { id: connection.id },
    data: { openingBalanceMinor: BigInt(Math.round(balanceRupees * 100)), openingBalanceDate: parsedDate },
  });

  await writeAudit({
    organizationId: connection.organizationId,
    actorType: "USER",
    actorId: req.auth!.userId,
    action: "connection.opening_balance_set",
    entityType: "CONNECTION",
    entityId: connection.id,
    metadata: { balanceRupees, asOfDate },
  });

  res.json({ updated: true });
});

// The manual "Sync now" path. No longer the ONLY path — modules/queue/
// syncScheduler.ts sweeps due connections on a timer — but still the one a
// founder uses when they want data refreshed right now rather than at the next
// sweep, so it stays.
//
// Used to run connector.sync() inline, synchronously, on this request — a
// real external API call (or several hundred/thousand of them, paginated)
// held open on a single HTTP request and one Prisma connection for as long
// as the sync took. That doesn't scale: enough concurrent "Sync now" clicks
// (or one connection with a very large history) would exhaust the Express
// server's request-handling capacity and Prisma's connection pool together.
// Now this route does almost nothing — it flips the connection to QUEUED
// (atomically, see below) and hands the real work to modules/queue/
// syncWorker.ts via BullMQ/Redis, returning immediately. The frontend polls
// GET /:connectionId/sync-status until the job settles (see connections/
// page.js's syncAndWait).
connectionsRouter.post("/:connectionId/sync", ...requireAuth, async (req, res) => {
  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Atomic conditional update, not a findFirst-then-update — the guard
  // against double-enqueueing (two browser tabs, a double-click racing the
  // frontend's own disabled-button state) has to happen at the database
  // level to actually be race-free; a plain `if (connection.syncStatus ===
  // "IDLE")` check above would have a TOCTOU gap between the read and the
  // write. Only IDLE/FAILED can transition to QUEUED — a connection that's
  // already QUEUED or SYNCING is left alone and reported back as-is.
  try {
    // The claim, the enqueue and the roll-back-on-Redis-failure now live in
    // modules/queue/syncQueue.ts, because the scheduler sweep performs the
    // exact same transition and two copies of a race-sensitive guard is one
    // copy too many.
    const claimed = await claimAndEnqueueSync(connection.id);
    if (!claimed) {
      res.status(202).json({ queued: false, syncStatus: connection.syncStatus, alreadyInFlight: true });
      return;
    }
    await writeAudit({
      organizationId: connection.organizationId,
      actorType: "USER",
      actorId: req.auth!.userId,
      action: "connection.sync_triggered",
      entityType: "CONNECTION",
      entityId: connection.id,
      metadata: { provider: connection.provider },
    });
    res.status(202).json({ queued: true, syncStatus: "QUEUED" });
  } catch (err) {
    logger.error({ err, connectionId: connection.id, provider: connection.provider }, "connection_sync_enqueue_failed");
    res.status(500).json({ error: "enqueue_failed" });
  }
});

// Polled by the frontend after enqueueing (see connections/page.js's
// syncAndWait) to find out when a background sync job actually finishes —
// deliberately its own lightweight endpoint rather than reusing GET / (which
// returns every connection for the org) so polling every ~1.5s doesn't
// re-fetch and re-render the whole connections list each time.
connectionsRouter.get("/:connectionId/sync-status", ...requireAuth, async (req, res) => {
  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId },
    select: {
      syncStatus: true,
      lastSyncedAt: true,
      lastSyncError: true,
      syncProgressCurrent: true,
      syncProgressTotal: true,
      syncStartedAt: true,
    },
  });
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(connection);
});

// ---------------------------------------------------------------------------
// GET /connections/:connectionId/runs — §26/§31 sync history (P5.5)
// ---------------------------------------------------------------------------
// Connection carries only the CURRENT sync state, every field overwritten by
// the next run. "Failed four nights running" and "failed once last Tuesday"
// are indistinguishable there, and only one of them is a dead feed.
connectionsRouter.get("/:connectionId/runs", ...requireAuth, async (req, res) => {
  const connection = await prisma.connection.findFirst({
    where: { id: req.params.connectionId, organizationId: req.auth!.organizationId },
    select: { id: true, provider: true },
  });
  // 404, not 403 — a valid id from another tenant must not be confirmed.
  if (!connection) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const runs = await prisma.syncRun.findMany({
    where: { connectionId: connection.id },
    orderBy: { startedAt: "desc" },
    take: 30,
    select: {
      id: true, trigger: true, status: true, recordsFetched: true,
      cursor: true, error: true, startedAt: true, finishedAt: true, durationMs: true,
    },
  });

  res.json({
    connectionId: connection.id,
    provider: connection.provider,
    runs: runs.map((r) => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
  });
});
