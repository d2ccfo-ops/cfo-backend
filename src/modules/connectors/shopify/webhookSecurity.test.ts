import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { shopFromPayload, verifyShopifyWebhook } from "./index.js";

// The two vectors that made the Shopify webhook a cross-tenant write primitive.
// Both were confirmed reachable against this repo, not theorised.

const body = Buffer.from(JSON.stringify({ id: 1, total_price: "9999.00" }));
const sign = (secret: string, buf: Buffer) => crypto.createHmac("sha256", secret).update(buf).digest("base64");

function headers(hmac: string, extra: Record<string, string> = {}) {
  return {
    "x-shopify-hmac-sha256": hmac,
    "x-shopify-webhook-id": "wh_1",
    "x-shopify-topic": "orders/create",
    ...extra,
  };
}

describe("verifyShopifyWebhook", () => {
  it("REFUSES to verify when no secret is configured", () => {
    // THE BUG. This used to be `env.SHOPIFY_WEBHOOK_SECRET ?? ""`, and an
    // empty-key HMAC is a real, computable digest — so with the env var unset
    // the check validated attacker-supplied signatures against a key everyone
    // knows. SHOPIFY_WEBHOOK_SECRET is optional and the Custom App connect path
    // never sets it, so this was the DEFAULT state of the only deployment shape
    // this system has ever run in.
    const forged = sign("", body);
    expect(verifyShopifyWebhook(body, headers(forged), undefined).valid).toBe(false);
    expect(verifyShopifyWebhook(body, headers(forged), "").valid).toBe(false);
  });

  it("still accepts a genuinely signed body when a secret IS configured", () => {
    const secret = "shpss_realsecret";
    expect(verifyShopifyWebhook(body, headers(sign(secret, body)), secret).valid).toBe(true);
  });

  it("rejects a wrong signature, a missing signature, and a tampered body", () => {
    const secret = "shpss_realsecret";
    expect(verifyShopifyWebhook(body, headers(sign("other", body)), secret).valid).toBe(false);
    expect(verifyShopifyWebhook(body, headers(""), secret).valid).toBe(false);
    const tampered = Buffer.from(JSON.stringify({ id: 1, total_price: "1.00" }));
    expect(verifyShopifyWebhook(tampered, headers(sign(secret, body)), secret).valid).toBe(false);
  });

  it("returns the idempotency key and topic even when it refuses", () => {
    // The caller logs these on a rejection; returning empty strings there would
    // make a forged-webhook alert impossible to attribute.
    const r = verifyShopifyWebhook(body, headers("nope"), "s");
    expect(r.externalEventId).toBe("wh_1");
    expect(r.eventType).toBe("orders/create");
  });
});

describe("shopFromPayload", () => {
  it("extracts the shop the SIGNED body claims", () => {
    // This is the whole tenant-binding mechanism: the header is not signed, so
    // the shop has to come from inside the HMAC'd body.
    expect(shopFromPayload({ order_status_url: "https://acme.myshopify.com/1/orders/abc" })).toBe(
      "acme.myshopify.com"
    );
    expect(shopFromPayload({ checkout_url: "https://Acme.MyShopify.com/checkouts/x" })).toBe("acme.myshopify.com");
  });

  it("returns null rather than guessing when the payload states no shop", () => {
    // Product webhooks carry no shop URL. Null must mean "cannot tell" so the
    // route can log the residual risk — a truthy fallback here would silently
    // re-open the replay vector it exists to close.
    expect(shopFromPayload({ id: 5, title: "T-shirt" })).toBeNull();
    expect(shopFromPayload(null)).toBeNull();
    expect(shopFromPayload("not an object")).toBeNull();
    expect(shopFromPayload({ order_status_url: "" })).toBeNull();
    expect(shopFromPayload({ order_status_url: "not-a-url" })).toBeNull();
  });

  it("catches the replay: a body signed for one shop cannot claim another", () => {
    // Merchant A captures their own validly-signed delivery and resends it with
    // x-shopify-shop-domain swapped to victim.myshopify.com. The signature still
    // validates — the body is untouched — so only this comparison stops it.
    const attackerBody = { order_status_url: "https://attacker.myshopify.com/1/orders/abc" };
    expect(shopFromPayload(attackerBody)).not.toBe("victim.myshopify.com");
  });
});
