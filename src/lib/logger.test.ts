import { describe, expect, it } from "vitest";
import { redactUrl } from "./logger.js";

// pino-http's default req serializer logs originalUrl WITH the query string, so
// /webhooks/setu?key=<secret> and /connections/*/callback?code=<oauth code>
// were written in plaintext on every request.

describe("redactUrl", () => {
  it("censors credential-bearing params and keeps the rest", () => {
    expect(redactUrl("/x?code=abc&key=s3cret&page=2")).toBe("/x?code=[REDACTED]&key=[REDACTED]&page=2");
  });

  it("leaves a clean url byte-identical", () => {
    // Re-encoding an untouched query string would make logs disagree with what
    // the client actually sent, which is worse than useless when debugging.
    expect(redactUrl("/metrics/revenue?from=2026-01-01&to=2026-01-31")).toBe(
      "/metrics/revenue?from=2026-01-01&to=2026-01-31"
    );
    expect(redactUrl("/health")).toBe("/health");
    expect(redactUrl(undefined)).toBeUndefined();
  });

  it("keeps the PATH, because that is what makes a log useful", () => {
    expect(redactUrl("/connections/zoho-books/callback?code=x&state=y")).toContain("/connections/zoho-books/callback");
  });

  it("writes a marker a human can read, not a percent-encoded one", () => {
    expect(redactUrl("/x?token=abc")).toBe("/x?token=[REDACTED]");
  });

  it("matches param names case-insensitively", () => {
    expect(redactUrl("/x?CODE=abc&Api_Key=z")).toBe("/x?CODE=[REDACTED]&Api_Key=[REDACTED]");
  });
});
