// §27 PII masking and data minimisation, applied to every tool result before
// it reaches the model.
//
// The rule this file exists to enforce: a founder asking "why did margin drop"
// needs SKU names, amounts and dates. They do not need the customer's phone
// number, and neither does the model. Anything that leaves this process for a
// third-party API should carry the minimum that answers the question — and the
// minimum almost never includes a person's identity.
//
// Masking happens on the way OUT of a tool, not on the way in to the prompt,
// and that placement is deliberate. Masking at prompt-assembly time means the
// unmasked value has already been written to AgentToolCall.result, so the
// audit table becomes the one place customer identities are retained forever —
// exactly what minimisation is supposed to prevent.

/** Field names that carry a person's identity, whatever nests them. */
const PII_KEYS = new Set([
  "email",
  "phone",
  "mobile",
  "customername",
  "customeremail",
  "customerphone",
  "firstname",
  "lastname",
  "name",
  "address",
  "address1",
  "address2",
  "shippingaddress",
  "billingaddress",
  "contact",
  "contactnumber",
  "recipient",
  "consignee",
]);

/**
 * Keys that LOOK like PII but are not, and must survive.
 *
 * `productName` and `vendorName` end in "name" and are the entire point of a
 * margin question. An overzealous mask here does not leak anything — it makes
 * the AI answer "your worst SKU is [redacted]", which is useless in a way that
 * is much harder to notice than a crash.
 */
const KEEP = new Set([
  "productname",
  "vendorname",
  "orgname",
  "organizationname",
  "metricname",
  "carriername",
  "gatewayname",
  "providername",
  "skuname",
  "channelname",
  "legalentityname",
  "label",
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Indian mobile numbers, with or without +91 and separators. Deliberately
// narrow: a broad \d{10} would eat order numbers, AWBs and amounts in paise.
//
// The leading (?<!\d) is not cosmetic. Without it the pattern matched the TAIL
// of a longer digit run whenever that run happened to end on a word boundary,
// so a 13-digit Shopify order id like "1236123456789" was rewritten to
// "123[phone]" and a UTR to "AXISN123[phone]". Whether that fired depended on
// where a 6–9 landed inside the id, which is the worst kind of bug: it
// corrupts an identifier for some records and not others, and the corrupted
// ones stop matching anything downstream. Found by scripts/checkAiRestrictions.ts
// running the mask over real order payloads.
//
// The trailing (?!\d) is the same guard on the other end — a 10-digit run
// followed by more digits is not a phone number either.
const PHONE_RE = /(?<![\d])(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}(?!\d)/g;

export function maskString(value: string): string {
  return value.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]");
}

export interface MaskResult<T> {
  value: T;
  /** How many fields were masked — surfaced so a run can report it, not hidden. */
  masked: number;
}

/**
 * Recursively mask a tool result.
 *
 * Structure is preserved exactly: a masked field keeps its key and its type,
 * so a model reasoning about "how many orders" still sees the same array
 * length. Deleting the keys instead would change the shape of the data the
 * model reasons over, which is a different kind of lie.
 */
export function maskPii<T>(input: T): MaskResult<T> {
  let masked = 0;

  const walk = (v: unknown, keyHint?: string): unknown => {
    if (v === null || v === undefined) return v;

    if (typeof v === "string") {
      const lower = (keyHint ?? "").toLowerCase();
      if (lower && PII_KEYS.has(lower) && !KEEP.has(lower)) {
        masked += 1;
        return "[redacted]";
      }
      const scrubbed = maskString(v);
      if (scrubbed !== v) masked += 1;
      return scrubbed;
    }

    if (Array.isArray(v)) return v.map((item) => walk(item));

    if (typeof v === "object") {
      // BigInt never reaches here — every tool serialises money to a string
      // before returning — but a Date does, and JSON.stringify would turn it
      // into a string later anyway. Normalised here so masking sees the same
      // shape the model will.
      if (v instanceof Date) return v.toISOString();
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, k);
      return out;
    }

    return v;
  };

  return { value: walk(input) as T, masked };
}
