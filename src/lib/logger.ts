import pino from "pino";

// §12.2/§29. Logs are the one place a secret leaks without anyone attacking
// anything — they are shipped to a log aggregator, kept for months, and read by
// people who would never be granted the credential itself.
//
// ---------------------------------------------------------------------------
// WHAT WAS ACTUALLY LEAKING
// ---------------------------------------------------------------------------
// pino-http installs pino-std-serializers by default, which logs `req.headers`
// wholesale and `url` as req.originalUrl — the full path INCLUDING the query
// string. With no redact config, every request wrote:
//
//   · Authorization: Bearer <Clerk session JWT> — a replayable credential
//   · Cookie: __session=... — the same, in cookie form
//   · /webhooks/setu?key=<SETU_WEBHOOK_SECRET> — the shared secret that route
//     authenticates with, in plaintext, on every delivery
//   · /connections/*/callback?code=<OAuth authorization code>&state=... — the
//     code that exchanges for a provider access token
//
// So anyone with log access held live session tokens, a webhook secret, and
// OAuth codes. That is a credential store nobody meant to create.
//
// ---------------------------------------------------------------------------
// WHY PATHS ARE CENSORED RATHER THAN THE WHOLE URL DROPPED
// ---------------------------------------------------------------------------
// The path is the single most useful field in an HTTP log — dropping it to
// protect a query string would make the logs much worse at the job they exist
// for. So the serializer keeps the path and removes only the query string,
// replacing it with a marker so a reader can see that parameters were present
// rather than wondering whether the request had none.

/**
 * Header names never written to a log, in lowercase.
 *
 * Listed as what IS secret rather than what is safe: a header added by a future
 * middleware is logged by default, and the failure mode of the opposite policy
 * — an allowlist someone forgets to extend — is a missing debug field, not a
 * leaked token.
 */
const SECRET_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-shopify-access-token",
  "x-shopify-hmac-sha256",
  "x-razorpay-signature",
  "x-webhook-signature",
  "x-gokwik-signature",
  "svix-signature",
  "x-api-key",
  "api-key",
  "developer-token",
];

/** Query parameters whose VALUES are credentials. */
const SECRET_QUERY_PARAMS = new Set([
  "code", // OAuth authorization code — exchanges for an access token
  "key", // routes/webhooks/setu.ts authenticates on this
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "client_secret",
  "signature",
  "password",
  "api_key",
  "apikey",
]);

/**
 * A URL safe to log: full path, query string with secret values replaced.
 *
 * Exported so the redaction itself is unit-testable — a security control that
 * only runs inside a logger is one whose behaviour nobody can assert.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf("?");
  if (q === -1) return url;

  const path = url.slice(0, q);
  const params = new URLSearchParams(url.slice(q + 1));
  let touched = false;
  for (const name of [...params.keys()]) {
    if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) {
      params.set(name, "[REDACTED]");
      touched = true;
    }
  }
  // Re-encoding a query string that contained nothing sensitive would rewrite
  // it (escaping, ordering) and make logs disagree with what the client sent.
  return touched ? `${path}?${params.toString()}` : url;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      // Both shapes: pino-http nests under req/res, and direct logger calls in
      // route handlers pass headers at the top level.
      ...SECRET_HEADERS.flatMap((h) => [`req.headers["${h}"]`, `res.headers["${h}"]`, `headers["${h}"]`]),
      // Credential-shaped fields that appear in objects handed to the logger
      // directly — an error from a connector often carries the request it made.
      "*.accessToken",
      "*.refreshToken",
      "*.credentialsRef",
      "*.apiSecret",
      "*.appSecret",
      "*.clientSecret",
      "*.password",
      "accessToken",
      "refreshToken",
      "credentialsRef",
      "apiSecret",
      "appSecret",
      "clientSecret",
    ],
    censor: "[REDACTED]",
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true } },
});

/**
 * Serializers for pino-http, replacing pino-std-serializers' defaults.
 *
 * The default req serializer logs the raw originalUrl; this one strips secret
 * query values first. Headers are handled by the `redact` config above rather
 * than here, so a direct logger.info({ headers }) call is covered too.
 */
export const httpSerializers = {
  req(req: { id?: unknown; method?: string; url?: string; headers?: unknown; remoteAddress?: string }) {
    return {
      id: req.id,
      method: req.method,
      url: redactUrl(req.url),
      headers: req.headers,
      remoteAddress: req.remoteAddress,
    };
  },
};
