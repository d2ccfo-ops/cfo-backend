import { describe, expect, it } from "vitest";
import { computePackaging, MARKETPLACE_PROVIDERS } from "./fulfilmentCosts.js";
import type { OrgSettings } from "../orgs/settings.js";

describe("computePackaging", () => {
  it("returns unconfigured rather than a confident zero", () => {
    // The distinction the whole honesty layer rests on. An org that has not
    // typed a packaging rate must NOT report packaging = ₹0 as a measured
    // fact — that reads as "packaging is free" and quietly overstates margin.
    const res = computePackaging({}, 100, 250);
    expect(res.configured).toBe(false);
    expect(res.amountMinor).toBe(0n);
  });

  it("treats a configured zero as measured", () => {
    // Different from the above, and it must stay different: a founder stating
    // packaging genuinely costs nothing is a fact, not a missing input.
    const settings: OrgSettings = { packagingCost: { perOrderPaise: "0", perItemPaise: "0" } };
    const res = computePackaging(settings, 100, 250);
    expect(res.configured).toBe(true);
    expect(res.amountMinor).toBe(0n);
  });

  it("charges the mailer per parcel and the insert per item", () => {
    // ₹12 per order + ₹3 per item over 100 orders / 250 items
    //   = 1200*100 + 300*250 = 120,000 + 75,000 = 195,000 paise
    const settings: OrgSettings = { packagingCost: { perOrderPaise: "1200", perItemPaise: "300" } };
    const res = computePackaging(settings, 100, 250);
    expect(res.amountMinor).toBe(195_000n);
  });

  it("does not blend the two rates into one per-order number", () => {
    // The case a blended rate gets wrong. Same order count, more items — the
    // cost must rise, or multi-item orders are mispriced, and multi-item orders
    // are where the margin is.
    const settings: OrgSettings = { packagingCost: { perOrderPaise: "1200", perItemPaise: "300" } };
    const oneItem = computePackaging(settings, 100, 100);
    const threeItems = computePackaging(settings, 100, 300);
    expect(threeItems.amountMinor).toBeGreaterThan(oneItem.amountMinor);
    expect(threeItems.amountMinor - oneItem.amountMinor).toBe(300n * 200n);
  });

  it("stays exact on integers rather than drifting through floats", () => {
    const settings: OrgSettings = { packagingCost: { perOrderPaise: "1733", perItemPaise: "417" } };
    const res = computePackaging(settings, 24_999, 26_901);
    expect(res.amountMinor).toBe(1733n * 24_999n + 417n * 26_901n);
  });
});

describe("MARKETPLACE_PROVIDERS", () => {
  it("lists what IS a marketplace, so a new gateway cannot drift into it", () => {
    // Fail-closed: a gateway added tomorrow must not silently start counting
    // as marketplace fees. Adding a marketplace is a deliberate edit here.
    expect([...MARKETPLACE_PROVIDERS]).toEqual(["AMAZON", "FLIPKART"]);
    expect(MARKETPLACE_PROVIDERS).not.toContain("RAZORPAY");
    expect(MARKETPLACE_PROVIDERS).not.toContain("GOKWIK");
  });
});
