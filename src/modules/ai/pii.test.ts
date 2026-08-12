import { describe, expect, it } from "vitest";
import { maskPii, maskString } from "./pii.js";

// §27. Two failure modes, both costly, and the second is the one that bites:
//
//   Under-masking leaks a customer's identity to a third-party API.
//   Over-masking corrupts an identifier, or makes the AI answer "your worst
//   SKU is [redacted]" — useless in a way that is much harder to notice than
//   a crash, because nothing errors and the sentence still reads fine.

describe("maskString", () => {
  it("masks emails", () => {
    expect(maskString("write to founder@brand.in about it")).toBe("write to [email] about it");
    expect(maskString("a.b+tag@sub.domain.co.in")).toBe("[email]");
  });

  it("masks Indian mobiles in every common rendering", () => {
    expect(maskString("9876543210")).toBe("[phone]");
    expect(maskString("call 9876543210 today")).toBe("call [phone] today");
    expect(maskString("+91 98765 43210")).toBe("[phone]");
    expect(maskString("+91-9876543210")).toBe("[phone]");
    expect(maskString("phone:9876543210")).toBe("phone:[phone]");
  });

  it("does not eat the tail of a longer digit run", () => {
    // The regression scripts/checkAiRestrictions.ts found on real Shopify
    // payloads. Without a leading digit guard, a 13-digit order id whose last
    // ten digits happen to start 6–9 became "123[phone]" — and whether it
    // fired depended on where a 6–9 landed inside the id, so it corrupted
    // some records and not others. A corrupted identifier stops matching
    // anything downstream, silently.
    expect(maskString("1236123456789")).toBe("1236123456789");
    expect(maskString("AXISN1236123456789")).toBe("AXISN1236123456789");
    expect(maskString("6123456789012")).toBe("6123456789012");
    expect(maskString("gid://shopify/Order/6123456789012")).toBe("gid://shopify/Order/6123456789012");
  });

  it("leaves ordinary finance numbers alone", () => {
    expect(maskString("order 1234567890")).toBe("order 1234567890");
    expect(maskString("amount 1245000")).toBe("amount 1245000");
    expect(maskString("123698765432")).toBe("123698765432");
    // A landline and a 10-digit number starting 1-5 are not the pattern.
    expect(maskString("0112345678")).toBe("0112345678");
  });
});

describe("maskPii", () => {
  it("redacts identity-bearing keys whatever nests them", () => {
    const { value, masked } = maskPii({ order: { customer: { customerName: "Priya S", phone: "9876543210" } } });
    expect(value.order.customer.customerName).toBe("[redacted]");
    expect(value.order.customer.phone).toBe("[redacted]");
    expect(masked).toBe(2);
  });

  it("keeps the names an answer is actually about", () => {
    // An overzealous mask here does not leak anything — it makes the AI say
    // "your worst SKU is [redacted]".
    const { value } = maskPii({ productName: "Neem Face Wash", vendorName: "Blue Dart Express", label: "Available cash" });
    expect(value.productName).toBe("Neem Face Wash");
    expect(value.vendorName).toBe("Blue Dart Express");
    expect(value.label).toBe("Available cash");
  });

  it("preserves structure so counts stay honest", () => {
    // Deleting keys instead would change the shape the model reasons over —
    // "how many orders" would silently change answer.
    const { value } = maskPii({ rows: [{ email: "a@b.co", amount: "1245000" }, { email: "c@d.co", amount: "500" }] });
    expect(value.rows).toHaveLength(2);
    expect(value.rows[0].amount).toBe("1245000");
    expect(value.rows[0].email).toBe("[redacted]");
  });

  it("scrubs PII embedded in free text under a harmless key", () => {
    const { value, masked } = maskPii({ note: "customer said call 9876543210 or mail a@b.co" });
    expect(value.note).toBe("customer said call [phone] or mail [email]");
    expect(masked).toBe(1);
  });

  it("normalises Dates rather than walking into them", () => {
    const d = new Date("2026-08-12T00:00:00.000Z");
    expect(maskPii({ at: d }).value.at).toBe("2026-08-12T00:00:00.000Z");
  });

  it("passes null, numbers and booleans through untouched", () => {
    const { value, masked } = maskPii({ a: null, b: 5, c: true, d: undefined });
    expect(value).toEqual({ a: null, b: 5, c: true, d: undefined });
    expect(masked).toBe(0);
  });

  it("reports how many fields it changed", () => {
    expect(maskPii({ x: "nothing here" }).masked).toBe(0);
    expect(maskPii({ email: "a@b.co" }).masked).toBe(1);
  });
});
