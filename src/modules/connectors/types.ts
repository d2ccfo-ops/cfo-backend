// Every data source (Shopify, Razorpay, Meta Ads, Google Ads, Shiprocket,
// bank feeds) implements this same shape. The rest of the system — sync
// scheduling, webhook routing, RawEvent storage — depends only on this
// interface, never on a provider's SDK directly.

export interface ConnectorContext {
  connectionId: string;
  organizationId: string;
  legalEntityId: string;
  credentialsRef: string;
  // Provider-side account identifier — e.g. a Shopify shop domain. Null for
  // providers that don't need one (API-key-only providers like Razorpay).
  externalAccountId: string | null;
  // Optional: lets a connector report real progress (records processed so
  // far, and a total if the provider's API can cheaply give one — e.g.
  // Shopify's orders/count.json — before it does a lot of work). Only
  // modules/queue/syncWorker.ts sets this, wiring it to a throttled
  // Connection.syncProgress* update — routes that build a ConnectorContext
  // just to call processEvent() (webhooks) leave it undefined, and
  // connectors must treat it as optional: call `ctx.reportProgress?.(...)`,
  // never assume it exists. A connector that never calls it just means that
  // provider's syncs show as "Syncing…" without a count, not an error.
  reportProgress?: (current: number, total: number | null) => Promise<void> | void;
}

export interface SyncResult {
  recordsFetched: number;
  cursor: string | null; // opaque pagination/since cursor for the next sync
}

export interface WebhookVerificationResult {
  valid: boolean;
  externalEventId: string;
  eventType: string;
}

export interface Connector {
  provider: string;

  /** Full historical pull on first connect. */
  backfill(ctx: ConnectorContext): Promise<SyncResult>;

  /** Incremental pull since the last cursor — used for scheduled repair syncs. */
  sync(ctx: ConnectorContext, sinceCursor: string | null): Promise<SyncResult>;

  /** Verify signature and extract idempotency key before the payload is persisted. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): WebhookVerificationResult;

  /** Turn a stored RawEvent payload into canonical rows (Order/Payment/etc). Idempotent. */
  processEvent(ctx: ConnectorContext, payload: unknown, eventType: string): Promise<void>;
}

export function toConnectorContext(connection: {
  id: string;
  organizationId: string;
  legalEntityId: string;
  credentialsRef: string;
  externalAccountId: string | null;
}): ConnectorContext {
  return {
    connectionId: connection.id,
    organizationId: connection.organizationId,
    legalEntityId: connection.legalEntityId,
    credentialsRef: connection.credentialsRef,
    externalAccountId: connection.externalAccountId,
  };
}
