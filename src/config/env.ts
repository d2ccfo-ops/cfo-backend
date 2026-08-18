import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),

  // Read through the schema rather than process.env so the one place that
  // decides "is this production" is validated like everything else. index.ts
  // uses it to pick a default cluster size, which is the difference between
  // one Node process and one per core.
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // How many API processes to fork. Unset means one per core IN PRODUCTION and
  // exactly one in development — see the note in src/index.ts for why the
  // development default is not the core count. Set it lower than the core count
  // when the machine is shared with the worker and Postgres, as it is on the
  // single-VM deployment.
  //
  // This is the knob that decides whether the metric endpoints can use more
  // than one core. Node runs JS on a single thread, so an unclustered API
  // serves seventeen parallel metric requests by interleaving them on one core
  // no matter how many the machine has — see the header of src/index.ts for the
  // measurement. Raising it past the core count does nothing but add context
  // switches and Prisma pools; index.ts clamps it for that reason.
  //
  // Each child opens its own pool, so total DB connections are
  // API_CLUSTER_WORKERS x the connection_limit in DATABASE_URL, plus the
  // worker's. Keep that product under Postgres's max_connections.
  API_CLUSTER_WORKERS: z.coerce.number().int().positive().optional(),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(1),

  // Used to encrypt every connector's stored credential (OAuth access token,
  // API key) — foundational for any connector, not Shopify-specific, so it's
  // required even though only Shopify uses it today. 32 bytes as hex.
  CREDENTIALS_ENCRYPTION_KEY: z.string().length(64),

  // The showcase account POST /auth/demo-login signs in, as an email address.
  //
  // Its PRESENCE is the feature switch, deliberately — a separate boolean flag
  // could be left on while the email changed, and "demo login enabled" with no
  // named account is not a state worth being able to represent. Unset (the
  // default, and what every real deployment should have) means the route 404s.
  //
  // Setting this makes one organisation's books readable by anyone who can
  // reach the login page. The route re-checks that the account cannot write
  // before it issues anything — see routes/demoLogin.ts.
  DEMO_LOGIN_EMAIL: z.string().email().optional(),

  // Comma-separated Clerk user IDs allowed to read /internal — the operations
  // console, and the only surface in this API that reads across tenants.
  //
  // Its PRESENCE is the feature switch, same as DEMO_LOGIN_EMAIL above: unset
  // means /internal 404s entirely, which is what every deployment should look
  // like until somebody deliberately turns it on.
  //
  // Deliberately NOT a MembershipRole and deliberately NOT a database flag.
  // MembershipRole is per-organisation, so granting a role inside one tenant
  // must never be able to grant reads across all of them; and a row anybody
  // with database access can flip is not a boundary. See
  // middleware/requireSuperAdmin.ts. To find your own Clerk user id, call any
  // /internal route while signed in and read it out of the denial log line.
  INTERNAL_ADMIN_USER_IDS: z.string().optional(),

  // P4 AI CFO. Optional: absent means /ai returns a clear "not configured"
  // rather than a 500, and every other route is unaffected. Same
  // check-at-use pattern as every connector credential below.
  ANTHROPIC_API_KEY: z.string().optional(),
  // Overridable without a deploy, so a model can be swapped after an eval run
  // rather than on a hunch.
  //
  // The default was claude-opus-5 on the reasoning that this model "reads
  // financial statements, and a wrong answer costs more than a token". That
  // was measured and found to be paying for work this system deliberately does
  // not ask the model to do: §1 says the LLM never calculates money. Every
  // figure in an answer is read out of a tool result that calc/ already
  // computed, and answers.ts verifies each one against those results before
  // the answer is stored. The model's actual job is picking the right tool
  // from TOOLS and building a date range from a vague question — which Sonnet
  // does reliably, at roughly a fifth of the cost. Two real questions cost
  // $1.12 on Opus against ~$0.22 on Sonnet for the same 59k tokens.
  //
  // Going a tier lower (Haiku) is a real option but not a free one: a weaker
  // tool choice spends EXTRA turns, and each turn resends the whole prompt, so
  // a cheaper model can bill more than a dearer one. Change it here only with
  // an eval run behind it — `npm run eval`.
  AI_MODEL: z.string().default("claude-sonnet-5"),

  // The daily brief is a DIFFERENT job from the agentic loop above and should
  // not inherit its model. dailyBrief.ts states the difference in its own
  // header: the model gets the snapshot diff as pre-formatted text, it has no
  // tools, and every figure it writes is verified against that same text
  // before the brief is stored. There is no tool to choose and no period to
  // reason about — it is summarisation of a fixed input, with a verifier
  // behind it that rejects the narrative outright if a figure does not check
  // out. That is the cheapest tier's natural work.
  //
  // It also runs once per organisation per day forever, so unlike a question
  // somebody chose to ask, its cost compounds on its own. Separate variable
  // rather than a shared one, so raising the AI CFO's tier for harder
  // questions does not silently raise this too.
  // The alias, not the dated snapshot id: aliases are complete as-is and
  // track the current build, while a pinned date silently ages.
  AI_BRIEF_MODEL: z.string().default("claude-haiku-4-5"),

  // P3.3 email digests. Optional: absent means the digest feature is OFF, not
  // broken — the sweep skips sending and says so in its result rather than
  // throwing per organisation. Same check-at-use pattern as every connector
  // credential below.
  RESEND_API_KEY: z.string().optional(),
  // Must be a domain verified in the Resend dashboard. Defaulted to nothing
  // rather than a plausible-looking address: a From that has not been verified
  // fails at send time with an error nobody reads, and a wrong default would
  // make that look like a code bug.
  DIGEST_FROM_EMAIL: z.string().optional(),

  // Where internal alerts go. BOTH OPTIONAL, and alerting works without either:
  // evaluation stores and resolves alerts regardless, and the console shows
  // them. These only decide whether anything is pushed to a human.
  //
  // A webhook is one URL and reaches Slack, Discord or anything else that
  // accepts a JSON body with a `text` field. Email is the second channel
  // because the two fail differently — the webhook host can be the thing that
  // is down.
  INTERNAL_ALERT_WEBHOOK: z.string().url().optional(),
  INTERNAL_ALERT_EMAIL: z.string().optional(),

  // The BigQuery dataset holding the Cloud Billing export, when one exists.
  //
  // Optional and expected to be absent: the export is a Cloud Console setting
  // on the BILLING ACCOUNT with no configuration API, so it cannot be turned on
  // from code. Absent means /internal/economics/billing reports "not
  // configured" with the steps rather than an empty chart — see
  // modules/observability/billingExport.ts on why those two must not look the
  // same. The table name is discovered inside the dataset, because it embeds a
  // billing account id this process has no way to know.
  GCP_BILLING_BQ_DATASET: z.string().optional(),

  // Turning a customer's IP address into a place means sending that address to
  // a third party. That is ordinary for operational session logging and it is
  // still a disclosure, so it is a switch rather than an assumption. Off, the
  // session record keeps the address and carries no place — it degrades, it does
  // not break. IP_GEO_TOKEN buys a paid tier from the same provider; without one
  // the free tier answers about a thousand distinct addresses a day, which is
  // far more than this product will produce.
  IP_GEO_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false")
    .pipe(z.boolean()),
  IP_GEO_TOKEN: z.string().optional(),

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
