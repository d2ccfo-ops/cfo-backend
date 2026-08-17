import { describe, expect, it } from "vitest";
import { classifySyncError } from "./syncErrorClass.js";

// EVERY STRING IN THE FIRST BLOCK IS A REAL MESSAGE, taken verbatim from
// sync_runs on the development database along with how many rows carried it.
// They are here because the first version of this classifier was written from
// imagination and got the biggest category completely wrong.

describe("the messages actually in the database", () => {
  it("classifies Node's decrypt failure, which says neither 'decrypt' nor 'auth_tag'", () => {
    // 2,691 rows + 822 rows. Between them, more than 80% of all failures.
    expect(classifySyncError("Invalid authentication tag length: 0")).toBe("credential_decrypt");
    expect(classifySyncError("Invalid authentication tag length: 2")).toBe("credential_decrypt");
  });

  it("separates a connector that was never set up from one that is broken", () => {
    // 207 rows. Nothing is failing here; the connector has no credentials yet.
    expect(classifySyncError("google_ads_not_configured")).toBe("not_configured");
  });

  it("reads a status code out of a parenthesised suffix", () => {
    // 204 rows.
    expect(
      classifySyncError("gokwik order/list failed (statusCode 500): Unable to get order details, Please try agian!"),
    ).toBe("provider_5xx");
  });

  it("reads a status code out of an HTTP prefix", () => {
    // 204 rows.
    expect(classifySyncError("gokwik orders request failed: HTTP 400")).toBe("provider_4xx");
  });

  // The case a \b-anchored regex silently misses: the digits are preceded by an
  // underscore, which IS a word character, so there is no word boundary there.
  it("reads a status code embedded in a snake_case token", () => {
    // 202 rows.
    expect(classifySyncError("meta_insights_request_failed_400")).toBe("provider_4xx");
  });

  it("classifies a concurrent bulk operation as a conflict, not a failure", () => {
    // 9 rows.
    expect(
      classifySyncError("Shopify bulk operation rejected: A bulk query operation for this app and shop is already in progress"),
    ).toBe("conflict");
  });

  it("classifies bare transport failures as network", () => {
    // 2 rows and 1 row.
    expect(classifySyncError("fetch failed")).toBe("network");
    expect(classifySyncError("terminated")).toBe("network");
  });
});

describe("ordering", () => {
  it("does not read a decrypt failure's digits as an HTTP status", () => {
    // "Invalid authentication tag length: 500" would classify as provider_5xx
    // if the status match ran first. It is still a decrypt failure.
    expect(classifySyncError("Invalid authentication tag length: 500")).toBe("credential_decrypt");
  });

  it("prefers the specific auth signal over the generic status match", () => {
    expect(classifySyncError("Request failed with status 401 Unauthorized")).toBe("auth");
    expect(classifySyncError("HTTP 429 Too Many Requests")).toBe("rate_limit");
  });

  it("is case-insensitive", () => {
    expect(classifySyncError("INVALID AUTHENTICATION TAG LENGTH: 0")).toBe("credential_decrypt");
  });
});

describe("fallback", () => {
  it("returns other rather than guessing", () => {
    expect(classifySyncError("something nobody has seen before")).toBe("other");
  });

  it("does not mistake an ordinary number for a status code", () => {
    expect(classifySyncError("wrote 42 records")).toBe("other");
    expect(classifySyncError("processed 12345 rows")).toBe("other");
  });
});
