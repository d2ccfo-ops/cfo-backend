import { clerkMiddleware } from "@clerk/express";
import cors from "cors";
import express from "express";
// Express 4 does not forward async handler rejections to error middleware —
// they become unhandled rejections and kill the process. One thrown query in
// one route took the whole API down for every page. This import patches the
// router so async throws land in errorHandler as a 500 like sync ones do.
import "express-async-errors";
import { pinoHttp } from "pino-http";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { amazonConnectionRouter } from "./routes/connections/amazon.js";
import { adSpendCsvRouter } from "./routes/connections/adSpendCsv.js";
import { bankConnectionRouter } from "./routes/connections/bank.js";
import { bluedartConnectionRouter } from "./routes/connections/bluedart.js";
import { clickpostConnectionRouter } from "./routes/connections/clickpost.js";
import { delhiveryConnectionRouter } from "./routes/connections/delhivery.js";
import { flipkartConnectionRouter } from "./routes/connections/flipkart.js";
import { gokwikConnectionRouter } from "./routes/connections/gokwik.js";
import { googleAdsConnectionRouter } from "./routes/connections/googleAds.js";
import { connectionsRouter } from "./routes/connections/index.js";
import { emailIngestRouter } from "./routes/connections/emailIngest.js";
import { preferencesRouter } from "./routes/preferences.js";
import { costsRouter } from "./routes/costs.js";
import { metaAdsConnectionRouter } from "./routes/connections/metaAds.js";
import { razorpayConnectionRouter } from "./routes/connections/razorpay.js";
import { setuConnectionRouter } from "./routes/connections/setu.js";
import { shiprocketConnectionRouter } from "./routes/connections/shiprocket.js";
import { shopifyConnectionRouter } from "./routes/connections/shopify.js";
import { zohoBooksConnectionRouter } from "./routes/connections/zohoBooks.js";
import { healthRouter } from "./routes/health.js";
import { telemetryRouter } from "./routes/telemetry.js";
import { trackSession } from "./middleware/sessionTracker.js";
import { demoLoginRouter } from "./routes/demoLogin.js";
import { inventoryRouter } from "./routes/inventory.js";
import { legalEntitiesRouter } from "./routes/legalEntities.js";
import { organizationRouter } from "./routes/organization.js";
import { metricsRouter } from "./routes/metrics.js";
import { evidenceRouter } from "./routes/evidence.js";
import { auditRouter } from "./routes/audit.js";
import { aiRouter } from "./routes/ai.js";
import { anomaliesRouter } from "./routes/anomalies.js";
import { approvalsRouter } from "./routes/approvals.js";
import { notificationsRouter } from "./routes/notifications.js";
import { reconciliationRouter } from "./routes/reconciliation.js";
import { reportsRouter } from "./routes/reports.js";
import { settlementsRouter } from "./routes/settlements.js";
import { clerkWebhookRouter } from "./routes/webhooks/clerk.js";
import { clickpostWebhookRouter } from "./routes/webhooks/clickpost.js";
import { inboundEmailWebhookRouter } from "./routes/webhooks/inboundEmail.js";
import { delhiveryWebhookRouter } from "./routes/webhooks/delhivery.js";
import { razorpayWebhookRouter } from "./routes/webhooks/razorpay.js";
import { setuWebhookRouter } from "./routes/webhooks/setu.js";
import { shiprocketWebhookRouter } from "./routes/webhooks/shiprocket.js";
import { shopifyWebhookRouter } from "./routes/webhooks/shopify.js";
import { internalRouter } from "./routes/internal/index.js";
import { requestMetrics, startRequestMetricsFlush } from "./middleware/requestMetrics.js";
import { httpSerializers, logger } from "./lib/logger.js";

export function createApp() {
  const app = express();

  // Express 4 routes case-insensitively by default, so /Connections/x/connect
  // reached the same handler as /connections/x/connect while missing every
  // lowercase policy prefix in middleware/rbac.ts — a role that must never
  // touch credentials could set one by capitalising a letter. The policy
  // matcher normalises case now too; this makes the mismatch impossible rather
  // than merely handled, and costs nothing because every path this API and its
  // frontend use is lowercase.
  app.set("case sensitive routing", true);
  // A trailing slash is the same idea in a different disguise: /connections/
  // and /connections are one route, and only one of them matches a prefix
  // written without the slash.
  app.set("strict routing", false);

  // EXACTLY ONE TRUSTED HOP, because there is exactly one: Caddy, on the same
  // box, proxying to this container.
  //
  // Without this, req.ip is the Docker bridge address for every caller on
  // earth. That is not only wrong for the session records this now feeds — it
  // was already wrong for the rate limiter, which keys anonymous and
  // unauthenticated traffic on req.ip and was therefore putting the entire
  // internet in one bucket. Any single client could exhaust everyone's budget,
  // and the graph of who was being limited was meaningless.
  //
  // The number matters and `true` would be a bug. Caddy APPENDS the peer
  // address to X-Forwarded-For, so with one trusted hop Express takes the
  // rightmost entry — the one Caddy wrote. `true` trusts the whole chain and
  // takes the LEFTMOST, which is whatever the client typed: a caller could send
  // `X-Forwarded-For: 1.2.3.4` and be rate-limited, logged and geolocated as
  // that address instead of their own.
  app.set("trust proxy", 1);

  // serializers, not just `logger`: pino-http installs pino-std-serializers by
  // default, whose req serializer logs originalUrl WITH the query string — so
  // OAuth `?code=` and the Setu webhook's `?key=<secret>` were written in
  // plaintext on every request. See lib/logger.ts.
  app.use(pinoHttp({ logger, serializers: httpSerializers }));

  // Before every route and after the logger, so it sees webhooks, uploads and
  // health checks too — an endpoint's traffic is not less real for being
  // machine-generated, and a webhook flood is exactly the kind of thing this
  // exists to make visible. It records on the response's 'finish' event, so
  // nothing here sits between the request and its answer; see
  // middleware/requestMetrics.ts.
  app.use(requestMetrics());
  startRequestMetricsFlush();
  // maxAge, because the dashboard is on a DIFFERENT origin from this API and
  // every call carries an Authorization header — which makes each one a
  // "non-simple" request the browser must ask permission for first. Without a
  // cached answer it re-asks constantly: measured on the live deployment, 115
  // preflights served 78 real requests, each one a wasted round trip before the
  // request that mattered could even start.
  //
  // 24h is the ceiling Chrome honours (Firefox caps at 24h too; Safari is
  // lower). Nothing here is a security trade — a preflight answer says which
  // methods and headers are allowed, and those change only when this file does.
  //
  // origin is still open. That is deliberate for now and wrong for later: it
  // should be env.FRONTEND_URL once the marketing site and dashboard origins
  // settle. Bearer tokens mean this is not the session-hijack risk it would be
  // with cookies, but there is no reason to allow the whole internet either.
  //
  // exposedHeaders because the dashboard is cross-origin, and a browser can
  // only read the handful of CORS-safelisted response headers unless the
  // server names the others. X-Calc-Cache says whether a metric response was
  // computed or replayed (middleware/calcCache.ts), and without this line it
  // is invisible to anything but the server's own logs — which is how a cache
  // sitting in front of money figures ends up unverifiable from the outside.
  app.use(cors({ maxAge: 86400, exposedHeaders: ["X-Calc-Cache"] }));

  // Needs the raw body for svix signature verification, so it's mounted with
  // its own raw parser and BEFORE the global express.json() below — once
  // express.json() consumes the body, the original raw bytes are gone and
  // the signature can no longer be verified. Webhook auth is the svix
  // signature, not a Clerk session, so this stays outside clerkMiddleware.
  app.use("/webhooks/clerk", express.raw({ type: "application/json" }), clerkWebhookRouter);
  app.use("/webhooks/shopify", express.raw({ type: "application/json" }), shopifyWebhookRouter);
  app.use("/webhooks/razorpay", express.raw({ type: "application/json" }), razorpayWebhookRouter);
  app.use("/webhooks/shiprocket", express.raw({ type: "application/json" }), shiprocketWebhookRouter);
  app.use("/webhooks/delhivery", express.raw({ type: "application/json" }), delhiveryWebhookRouter);
  app.use("/webhooks/setu", express.raw({ type: "application/json" }), setuWebhookRouter);
  app.use("/webhooks/clickpost", express.raw({ type: "application/json" }), clickpostWebhookRouter);
  // Inbound email carries whole PDFs as base64, so this one webhook gets the
  // upload-sized limit — the default raw cap would 413 every real invoice.
  //
  // type: () => true captures EVERY content-type as a raw Buffer. Inbound-email
  // providers post with all sorts of Content-Type (application/json,
  // 'application/json; charset=utf-8', sometimes none); with the default
  // 'application/json' filter, a charset suffix or a missing header left the
  // body as {} and a real email was silently acknowledged as empty and lost.
  // The handler does its own JSON.parse and returns 400 on non-JSON.
  app.use("/webhooks/inbound-email", express.raw({ type: () => true, limit: "50mb" }), inboundEmailWebhookRouter);

  // STATEMENT UPLOADS NEED A BIGGER BODY THAN EVERYTHING ELSE.
  //
  // Statements arrive as a CSV posted inside a JSON body, and express.json()'s
  // default cap is 100 KB — measured, a GoKwik settlement export of 1,500 rows
  // is ~108 KB, so real files were failing with 413 before the handler ever
  // ran. A quarter's export is several hundred KB.
  //
  // Mounted BEFORE the global parser and scoped to the upload routes only:
  // body-parser marks the request once consumed, so the general express.json()
  // below no-ops for these paths. The cap stays tight everywhere else — a 50 MB
  // body limit on every endpoint is a cheap way to be memory-DoS'd, and no
  // other route in this app has any business receiving one.
  const UPLOAD_BODY_LIMIT = "50mb";
  for (const p of ["/connections/bank", "/connections/gokwik", "/connections/bluedart", "/connections/ad-spend"]) {
    app.use(p, express.json({ limit: UPLOAD_BODY_LIMIT }));
  }

  app.use(express.json());

  // Public, no Clerk dependency — a health check must not be able to fail
  // because of a misconfigured or outaged third-party auth provider.
  app.use(healthRouter);

  // Also before clerkMiddleware, and necessarily so: this route's whole job is
  // to get a visitor who has NO session a way in, so requiring one would be
  // circular. It authorises itself — see routes/demoLogin.ts — and is inert
  // unless DEMO_LOGIN_EMAIL names an account.
  app.use(demoLoginRouter);

  // Everything mounted after this point can read Clerk session state via
  // getAuth(req)/requireAuth from middleware/auth.ts.
  app.use(clerkMiddleware());

  // WHO IS ON THE PRODUCT RIGHT NOW. Mounted here rather than inside
  // requireAuth, so a user who has signed in but not yet chosen an organisation
  // — the whole of onboarding — is visible too. Writes presence to Redis on
  // every request and a durable row at most once a minute; nothing it does is
  // awaited and nothing it does can fail a request. See sessionTracker.ts.
  app.use(trackSession);

  // §27 rate limiting is NOT mounted here. It lives inside the requireAuth
  // chain (middleware/auth.ts), because a limiter mounted before
  // resolveOrgContext has no organisation to key on and silently degrades to
  // per-IP — which on a multi-tenant API means one office's NAT looks like one
  // customer, and a mobile network looks like thousands. Same reasoning as the
  // RBAC guard: anything that authenticates is also limited, and a route
  // written tomorrow is covered the moment it authenticates.
  //
  // Webhooks are deliberately outside it: they are mounted above
  // clerkMiddleware, carry no org claim, and throttling a provider's delivery
  // attempts converts our load problem into their retry storm.

  // The operations console. Mounted after clerkMiddleware because it needs a
  // verified session, but NOT part of the requireAuth family: it authenticates
  // a person against an allowlist rather than resolving a tenant, which is the
  // whole point of it. See routes/internal/index.ts. Inert — 404 on every path
  // — unless INTERNAL_ADMIN_USER_IDS names somebody.
  // Beacons from the customer's browser. After clerkMiddleware so a signed-in
  // caller is identifiable, but deliberately NOT behind requireOrganization —
  // a page that fails to render is exactly the case where there is no usable
  // session context, and that is the report worth having.
  app.use(telemetryRouter);

  app.use("/internal", internalRouter);

  app.use("/organization", organizationRouter);
  app.use("/metrics", metricsRouter);
  app.use("/evidence", evidenceRouter);
  app.use("/audit", auditRouter);
  app.use("/ai", aiRouter);
  app.use("/anomalies", anomaliesRouter);
  app.use("/approvals", approvalsRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/inventory", inventoryRouter);
  app.use("/costs", costsRouter);
  app.use("/preferences", preferencesRouter);
  app.use("/legal-entities", legalEntitiesRouter);
  app.use("/reconciliation", reconciliationRouter);
  app.use("/reports", reportsRouter);
  app.use("/settlements", settlementsRouter);
  app.use("/connections/shopify", shopifyConnectionRouter);
  app.use("/connections/razorpay", razorpayConnectionRouter);
  app.use("/connections/shiprocket", shiprocketConnectionRouter);
  app.use("/connections/bank", bankConnectionRouter);
  app.use("/connections/meta-ads", metaAdsConnectionRouter);
  app.use("/connections/google-ads", googleAdsConnectionRouter);
  app.use("/connections/delhivery", delhiveryConnectionRouter);
  app.use("/connections/bank-aa", setuConnectionRouter);
  app.use("/connections/amazon", amazonConnectionRouter);
  app.use("/connections/flipkart", flipkartConnectionRouter);
  app.use("/connections/clickpost", clickpostConnectionRouter);
  app.use("/connections/zoho-books", zohoBooksConnectionRouter);
  app.use("/connections/bluedart", bluedartConnectionRouter);
  app.use("/connections/gokwik", gokwikConnectionRouter);
  app.use("/connections/ad-spend", adSpendCsvRouter);
  app.use("/connections/email-ingest", emailIngestRouter);
  app.use("/connections", connectionsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
