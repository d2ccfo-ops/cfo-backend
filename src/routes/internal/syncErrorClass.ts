// What kind of failure a sync error message describes.
//
// Grouping by the raw message is useless on its own — the same fault arrives as
// "Invalid authentication tag length: 0" and "...length: 2" and lands in two
// buckets — so the console groups by class instead.
//
// WRITTEN AGAINST THE MESSAGES ACTUALLY IN THIS DATABASE, not against what a
// provider's documentation says it returns. The first draft of this function
// looked for "decrypt" and "auth_tag", which are the words a person expects,
// and it classified 3,513 of ~4,340 real failures as "other" — every single
// credential-decrypt failure on the deployment, because Node's actual message
// is "Invalid authentication tag length: N" and contains neither word. The
// tests pin the real strings for that reason.
//
// Order matters and the sequence below is the contract: a decrypt failure that
// happens to carry a number must not be read as an HTTP status.

export type SyncErrorClass =
  | "credential_decrypt"
  | "not_configured"
  | "auth"
  | "rate_limit"
  | "provider_5xx"
  | "provider_4xx"
  | "network"
  | "conflict"
  | "other";

/** A 3-digit 4xx/5xx anywhere in the message, including inside a snake_case token. */
const STATUS = /(?<![0-9])([45][0-9]{2})(?![0-9])/;

export function classifySyncError(message: string): SyncErrorClass {
  const m = message.toLowerCase();

  // FIRST, ALWAYS. The credential in the database can no longer be decrypted,
  // which no retry fixes and which is a completely different job from "the
  // provider is unwell". On this deployment it is also the loudest class by an
  // order of magnitude, so leaving it in the general bucket buries every real
  // provider error underneath it.
  if (
    m.includes("authentication tag") ||
    m.includes("auth_tag") ||
    m.includes("decrypt") ||
    m.includes("unable to authenticate data")
  ) {
    return "credential_decrypt";
  }

  // The connector was never set up. Not a failure of anything — a state.
  if (m.includes("not_configured") || m.includes("not configured")) return "not_configured";

  if (m.includes("429") || m.includes("rate limit") || m.includes("rate_limit") || m.includes("throttl")) {
    return "rate_limit";
  }

  if (
    m.includes("401") ||
    m.includes("403") ||
    m.includes("unauthor") ||
    m.includes("forbidden") ||
    m.includes("invalid_token") ||
    m.includes("invalid credentials") ||
    m.includes("token expired")
  ) {
    return "auth";
  }

  // Checked before the generic status match so a wording change on the
  // provider's side cannot silently reclassify these.
  if (
    m.includes("fetch failed") ||
    m.includes("terminated") ||
    m.includes("timeout") ||
    m.includes("etimedout") ||
    m.includes("econnreset") ||
    m.includes("enotfound") ||
    m.includes("socket hang up")
  ) {
    return "network";
  }

  if (m.includes("already in progress") || m.includes("already running") || m.includes("conflict")) {
    return "conflict";
  }

  const status = STATUS.exec(m);
  if (status) return status[1]!.startsWith("5") ? "provider_5xx" : "provider_4xx";

  return "other";
}
