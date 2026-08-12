import crypto from "node:crypto";
import { env } from "../config/env.js";

// OAuth install/callback is a plain browser redirect round-trip, so it can't
// carry a Clerk session (no way to attach an Authorization header to a
// redirect). This carries organizationId across that gap instead, signed so
// it can't be tampered with, and time-boxed so a leaked/logged state value
// can't be replayed later. Reusable across every OAuth-based connector
// (Shopify now; Meta/Google Ads will need the same mechanics later).

const STATE_TTL_MS = 10 * 60 * 1000;

export function signOAuthState(organizationId: string): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + STATE_TTL_MS;
  const payload = `${organizationId}.${nonce}.${expiresAt}`;
  const signature = crypto.createHmac("sha256", env.CREDENTIALS_ENCRYPTION_KEY).update(payload).digest("hex");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

export function verifyOAuthState(state: string): { organizationId: string } | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 4) return null;
    const [organizationId, nonce, expiresAtStr, signature] = parts;
    if (!organizationId || !nonce || !expiresAtStr || !signature) return null;
    const payload = `${organizationId}.${nonce}.${expiresAtStr}`;
    const expectedSignature = crypto.createHmac("sha256", env.CREDENTIALS_ENCRYPTION_KEY).update(payload).digest("hex");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
    if (Date.now() > Number(expiresAtStr)) return null;

    return { organizationId };
  } catch {
    return null;
  }
}
