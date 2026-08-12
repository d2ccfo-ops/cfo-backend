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
import { inventoryRouter } from "./routes/inventory.js";
import { legalEntitiesRouter } from "./routes/legalEntities.js";
import { organizationRouter } from "./routes/organization.js";
import { metricsRouter } from "./routes/metrics.js";
import { evidenceRouter } from "./routes/evidence.js";
import { auditRouter } from "./routes/audit.js";
import { anomaliesRouter } from "./routes/anomalies.js";
import { notificationsRouter } from "./routes/notifications.js";
import { reconciliationRouter } from "./routes/reconciliation.js";
import { settlementsRouter } from "./routes/settlements.js";
import { clerkWebhookRouter } from "./routes/webhooks/clerk.js";
import { clickpostWebhookRouter } from "./routes/webhooks/clickpost.js";
import { inboundEmailWebhookRouter } from "./routes/webhooks/inboundEmail.js";
import { delhiveryWebhookRouter } from "./routes/webhooks/delhivery.js";
import { razorpayWebhookRouter } from "./routes/webhooks/razorpay.js";
import { setuWebhookRouter } from "./routes/webhooks/setu.js";
import { shiprocketWebhookRouter } from "./routes/webhooks/shiprocket.js";
import { shopifyWebhookRouter } from "./routes/webhooks/shopify.js";
import { logger } from "./lib/logger.js";

export function createApp() {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(cors());

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

  // Everything mounted after this point can read Clerk session state via
  // getAuth(req)/requireAuth from middleware/auth.ts.
  app.use(clerkMiddleware());

  app.use("/organization", organizationRouter);
  app.use("/metrics", metricsRouter);
  app.use("/evidence", evidenceRouter);
  app.use("/audit", auditRouter);
  app.use("/anomalies", anomaliesRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/inventory", inventoryRouter);
  app.use("/costs", costsRouter);
  app.use("/preferences", preferencesRouter);
  app.use("/legal-entities", legalEntitiesRouter);
  app.use("/reconciliation", reconciliationRouter);
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
