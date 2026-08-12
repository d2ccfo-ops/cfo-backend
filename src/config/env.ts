import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(1),
  OPENAI_API_KEY: z.string().optional(),

  // Used to encrypt every connector's stored credential (OAuth access token,
  // API key) — foundational for any connector, not Shopify-specific, so it's
  // required even though only Shopify uses it today. 32 bytes as hex.
  CREDENTIALS_ENCRYPTION_KEY: z.string().length(64),

  BACKEND_URL: z.string().default("http://localhost:4000"),
  FRONTEND_URL: z.string().default("http://localhost:3000"),

  // Optional: the domain inbound email addresses live on (e.g. "in.cfoos.app").
  // Absent until an inbound-email provider is pointed at the webhook; the
  // Connections page then shows the webhook URL instead of an address that
  // would bounce, and says which situation it is in.
  EMAIL_INGEST_DOMAIN: z.string().optional(),

  // Optional: absent until a Shopify Partner app exists. Routes that need
  // these check for their presence at request time and return a clear error
  // rather than the whole server failing to boot without them.
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  // Dev/testing only — caps how many orders and how many products a single
  // backfill/sync run pulls (each independently, not combined), so a store
  // with a large real history can be verified end-to-end in seconds instead
  // of minutes. Unset by default: a real deployment must never have this
  // set, since it would silently make backfill incomplete. See
  // modules/connectors/shopify/index.ts's pull()/pullOrders()/pullProducts().
  SHOPIFY_BACKFILL_MAX_RECORDS: z.coerce.number().positive().optional(),

  // Optional: absent until a Meta developer app exists. Same
  // check-at-request-time pattern as the Shopify vars above.
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),

  // Optional: absent until a Google Cloud OAuth client + an approved Google
  // Ads developer token exist — two separate approvals, not one (see
  // modules/connectors/googleAds). GOOGLE_ADS_LOGIN_CUSTOMER_ID is only
  // needed if credentials belong to a manager (MCC) account rather than a
  // standalone Ads account.
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),

  // Zoho Books (accounting). Create a "Server-based Application" in the Zoho
  // API console for the DATACENTER the merchant's account lives in
  // (api-console.zoho.in for India) and enable multi-DC if you need to serve
  // accounts in other regions — see modules/connectors/zohoBooks.
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),

  // Optional: absent until a Setu FIU (Account Aggregator) app exists on
  // Setu's Bridge console. Unlike every OAuth connector above, these three
  // are static request headers (x-client-id/x-client-secret/x-product-instance-id),
  // not a token to exchange — confirmed against Setu's docs before building
  // this (see modules/connectors/setu). SETU_BASE_URL defaults to their
  // sandbox host; production is a different subdomain issued after KYC.
  SETU_CLIENT_ID: z.string().optional(),
  SETU_CLIENT_SECRET: z.string().optional(),
  SETU_PRODUCT_INSTANCE_ID: z.string().optional(),
  SETU_BASE_URL: z.string().default("https://fiu-sandbox.setu.co"),
  // Setu has no documented webhook signature scheme (see routes/webhooks/setu.ts)
  // and — unlike Delhivery's per-connection URL token — the notification URL
  // is registered once, globally, in Setu's Bridge console, not per API call.
  // So this is a shared secret we mint ourselves, append as a query param to
  // the URL we register, and check on every inbound notification.
  SETU_WEBHOOK_SECRET: z.string().optional(),

  // How many connection-sync jobs a single worker process runs at once (see
  // src/worker.ts, modules/queue/syncWorker.ts). This is the actual knob
  // that bounds Prisma pool / outbound-connection usage under load — no
  // matter how many "Sync now" clicks land or how many orders a store has,
  // only this many syncs are ever running in parallel per worker process;
  // everything else waits safely in Redis instead of holding a DB
  // connection or an HTTP request open. Scale further by running more
  // worker processes, not by raising this indefinitely.
  SYNC_WORKER_CONCURRENCY: z.coerce.number().positive().default(3),

  // Optional: absent until an Amazon SP-API app is registered in Seller
  // Central's Developer Console. AMAZON_APP_ID is the SP-API application ID
  // (used in the /apps/authorize/consent redirect); AMAZON_LWA_CLIENT_ID/
  // SECRET are the Login-with-Amazon credentials issued alongside it, used
  // to exchange an authorization code (or refresh token) for an access
  // token. No AWS credentials needed — SP-API dropped SigV4 signing in 2023.
  // AMAZON_APP_DRAFT=true appends version=beta to the consent URL, required
  // while the app hasn't passed Amazon's app-review call yet (the normal
  // state for a new app being tested against your own seller account).
  AMAZON_APP_ID: z.string().optional(),
  AMAZON_LWA_CLIENT_ID: z.string().optional(),
  AMAZON_LWA_CLIENT_SECRET: z.string().optional(),
  AMAZON_APP_DRAFT: z.string().optional(),
});

export const env = schema.parse(process.env);
