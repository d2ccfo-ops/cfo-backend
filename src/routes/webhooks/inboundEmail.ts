import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import {
  extractTokenFromRecipients,
  normalizeInboundPayload,
  processInboundEmail,
} from "../../modules/ingest/inboundEmail.js";

export const inboundEmailWebhookRouter = Router();

// Where forwarded courier documents arrive. Mounted auth-free (an email
// provider cannot hold a Clerk session); the credential is the address token,
// either in the URL path or inside the docs-<token>@… recipient address.
//
// Two shapes on purpose:
//   POST /webhooks/inbound-email/:token — for providers that take a custom
//     webhook URL per address, and for testing with curl.
//   POST /webhooks/inbound-email — the realistic production shape: providers
//     let you register ONE webhook per inbound domain and post every message
//     to it, so the org is resolved from the docs-<token>@… recipient.
//
// Response discipline: a recognised email whose token is valid always gets 200,
// INCLUDING when all of its attachments were refused — the refusals are
// recorded per attachment in the log the merchant reads, and a non-200 would
// make the provider retry a payload that fails identically forever. Non-200 is
// reserved for what a retry could fix (a transient 500 from an infrastructure
// fault) or should never retry (401 unknown/absent token, 400 not an email).

// A lightweight per-token rate limiter. The webhook is unauthenticated beyond
// the token, and a leaked token could otherwise be used to hammer the parser;
// this bounds the blast radius to a fixed rate without a Redis dependency. The
// window is deliberately generous — a real inbox forwards a handful of
// documents a day, not dozens a minute.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map<string, number[]>();

function rateLimited(token: string): boolean {
  const now = Date.now();
  const recent = (hits.get(token) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(token, recent);
  // Opportunistic cleanup so the map cannot grow without bound from probing.
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k);
  }
  return recent.length > RATE_MAX;
}

async function tokenIsLive(token: string): Promise<boolean> {
  const address = await prisma.emailIngestAddress.findUnique({ where: { token }, select: { disabledAt: true } });
  return Boolean(address) && !address!.disabledAt;
}

async function handle(rawBody: unknown, tokenFromPath: string | null, res: import("express").Response) {
  // When the token is in the URL, verify it is live BEFORE parsing or decoding
  // anything — a stranger hammering the endpoint with a bogus token and 40 huge
  // base64 attachments is rejected without a single JSON.parse or base64 decode.
  if (tokenFromPath) {
    if (!(await tokenIsLive(tokenFromPath))) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    if (rateLimited(tokenFromPath)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
  }

  // With express.raw the body is always a Buffer; an empty POST gives an empty
  // one. Parse defensively.
  let body: unknown;
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : typeof rawBody === "string" ? rawBody : null;
    body = text && text.trim() ? JSON.parse(text) : rawBody;
  } catch {
    res.status(400).json({ error: "not_json" });
    return;
  }

  const payload = normalizeInboundPayload(body);
  if (!payload) {
    res.status(400).json({ error: "not_an_email_payload" });
    return;
  }

  const token = tokenFromPath ?? extractTokenFromRecipients(payload.recipients);
  if (!token) {
    res.status(401).json({ error: "no_ingest_address" });
    return;
  }

  // For the pathless route the token came from the body, so its checks happen
  // here (the path route already did them above).
  if (!tokenFromPath) {
    if (!(await tokenIsLive(token))) {
      // Unknown and disabled tokens answer identically — a rotated-away address
      // may be in hostile hands, and confirming it once worked is information.
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    if (rateLimited(token)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
  }

  const result = await processInboundEmail(token, payload);
  if (!result) {
    // Raced with a rotation between the liveness check and processing.
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  res.json({
    received: true,
    duplicate: result.duplicate,
    status: result.status,
    attachments: result.outcomes.map((o) => ({ name: o.name, kind: o.kind, ok: o.ok, detail: o.detail })),
  });
}

inboundEmailWebhookRouter.post("/:token", async (req, res) => {
  try {
    await handle(req.body, req.params.token.toLowerCase(), res);
  } catch (err) {
    logger.error({ err }, "inbound_email_webhook_failed");
    // 500 so the provider retries: an infrastructure fault is ours, not the
    // payload's, and the message-id dedupe makes the retry safe.
    res.status(500).json({ error: "processing_failed" });
  }
});

inboundEmailWebhookRouter.post("/", async (req, res) => {
  try {
    await handle(req.body, null, res);
  } catch (err) {
    logger.error({ err }, "inbound_email_webhook_failed");
    res.status(500).json({ error: "processing_failed" });
  }
});