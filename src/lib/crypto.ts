import crypto from "node:crypto";
import { env } from "../config/env.js";

// Connection.credentialsRef must never hold a raw provider secret (access
// token, API key) — everything written there goes through encryptSecret()
// first. AES-256-GCM with a server-held key is a deliberately modest choice
// for now (a real secrets manager is future work, see cfo-docs/ARCHITECTURE.md)
// but it's a meaningful step up from plaintext in Postgres.

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const key = Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, "hex");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
