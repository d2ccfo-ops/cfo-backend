// When a connection is due for another sync — pure functions and constants,
// with NO imports that open a socket. That separation is deliberate: this
// module sits beside syncScheduler.ts, which constructs a BullMQ Queue at
// module scope, so importing the scheduler to reach `isDue` would open a Redis
// connection and hang any process that only wanted to ask a question (the
// check script did exactly that before this split). Decision logic that can be
// imported and reasoned about without infrastructure is also the part most
// worth testing.

// How stale a connection's data may get before the sweep picks it up. Tuned to
// what the provider's data is actually worth re-asking for rather than one
// global number: re-walking Zoho Books hourly is pure waste (it has no
// incremental cursor, so every sync is a full re-walk), while ad platforms
// restate the current day's spend as conversions attribute late.
export const DEFAULT_INTERVAL_MINUTES = 60;
export const PROVIDER_INTERVAL_MINUTES: Record<string, number> = {
  SHOPIFY: 60,
  RAZORPAY: 60,
  SHIPROCKET: 60,
  DELHIVERY: 120,
  CLICKPOST: 120,
  META_ADS: 180,
  GOOGLE_ADS: 180,
  AMAZON: 120,
  FLIPKART: 120,
  ZOHO_BOOKS: 360,
  BANK_AA: 360,
  // Bluedart can only re-track waybills it already knows, so a tight cadence
  // buys nothing; the shipments it enriches arrive from the order side.
  BLUEDART: 120,
  // GoKwik's poll only refreshes COD/prepaid classification on existing orders.
  GOKWIK: 120,
};

// BANK is excluded outright, and not because syncing it would be expensive —
// its connector is a deliberate no-op (real data arrives through the statement
// CSV upload route). Running it would still set lastSyncedAt = now, which would
// make /metrics/freshness report a bank connection as freshly synced when the
// only thing that actually refreshes it is a human uploading a new statement.
// A green freshness badge over a two-month-old statement is worse than none.
export const EXCLUDED_PROVIDERS = new Set(["BANK"]);

// A connection whose last attempt FAILED is retried, but slowly. Most sync
// failures are a revoked token or a wrong key — conditions a retry cannot fix
// and only a human re-connecting will. Sweeping those on the normal cadence
// would burn a provider API call and write an error row every hour forever, for
// every broken connection, while achieving nothing. Six hours still recovers
// from the transient cases — a provider outage, an expired upstream — inside a
// working day.
export const FAILED_RETRY_MINUTES = 360;

export function intervalMinutesFor(provider: string, syncStatus: string): number {
  if (syncStatus === "FAILED") return FAILED_RETRY_MINUTES;
  return PROVIDER_INTERVAL_MINUTES[provider] ?? DEFAULT_INTERVAL_MINUTES;
}

export interface SweepCandidate {
  provider: string;
  syncStatus: string;
  lastSyncedAt: Date | null;
}

export function isDue(connection: SweepCandidate, now: Date = new Date()): boolean {
  if (EXCLUDED_PROVIDERS.has(connection.provider)) return false;
  // Already queued or running. The atomic claim would refuse it anyway, but
  // skipping here keeps the sweep's log honest about what was considered.
  if (connection.syncStatus === "QUEUED" || connection.syncStatus === "SYNCING") return false;
  // Never synced: due immediately. This is also what picks up a connection
  // whose first backfill failed, or one connected while the worker was down.
  if (connection.lastSyncedAt === null) return true;

  const ageMinutes = (now.getTime() - connection.lastSyncedAt.getTime()) / 60_000;
  return ageMinutes >= intervalMinutesFor(connection.provider, connection.syncStatus);
}
