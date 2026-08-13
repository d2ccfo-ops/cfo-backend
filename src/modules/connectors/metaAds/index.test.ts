import { describe, expect, it } from "vitest";
import { firstPurchaseValue } from "./index.js";

// Meta returns every action type it tracked on a row — link clicks, landing
// page views, add-to-cart, initiate-checkout, and between one and three
// purchase spellings depending on how the advertiser wired their pixel and
// Conversions API.
//
// THE BUG THIS GUARDS. `omni_purchase` is Meta's DEDUPLICATED purchase total
// across web, app and offline. `offsite_conversion.fb_pixel_purchase` is the
// web slice of that same total. A row carrying both is the normal case for any
// advertiser running CAPI, so summing the purchase-ish action types counts a
// large share of sales twice — and the result is a campaign ROAS that looks
// merely good rather than impossible, which is exactly the kind of wrong number
// nobody catches by eye.

describe("firstPurchaseValue", () => {
  it("returns null when the row tracked no actions at all", () => {
    expect(firstPurchaseValue(undefined)).toBeNull();
    expect(firstPurchaseValue([])).toBeNull();
  });

  it("ignores non-purchase action types", () => {
    expect(
      firstPurchaseValue([
        { action_type: "link_click", value: "412" },
        { action_type: "landing_page_view", value: "301" },
        { action_type: "add_to_cart", value: "44" },
        { action_type: "initiate_checkout", value: "19" },
      ])
    ).toBeNull();
  });

  it("prefers the deduplicated omni total over the web-only slice", () => {
    // The whole point: these two describe overlapping populations. 14 is the
    // right answer, 25 (their sum) and 11 (the smaller) are both wrong.
    expect(
      firstPurchaseValue([
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "11" },
        { action_type: "omni_purchase", value: "14" },
      ])
    ).toBe(14);
  });

  it("falls back through the spellings in order", () => {
    expect(firstPurchaseValue([{ action_type: "offsite_conversion.fb_pixel_purchase", value: "11" }])).toBe(11);
    expect(firstPurchaseValue([{ action_type: "purchase", value: "7" }])).toBe(7);
  });

  it("reads a genuine zero as zero, not as absent", () => {
    // A campaign that spent and sold nothing is a fact worth recording. Coercing
    // it to null would make it indistinguishable from a campaign whose pixel is
    // broken, and those want opposite responses.
    expect(firstPurchaseValue([{ action_type: "omni_purchase", value: "0" }])).toBe(0);
  });

  it("rejects an unparseable value rather than storing NaN", () => {
    // A NaN would flow into Math.round and then into a Prisma Int, failing at
    // the write with a stack trace pointing nowhere near Meta's response.
    expect(firstPurchaseValue([{ action_type: "omni_purchase", value: "" }])).toBeNull();
    expect(firstPurchaseValue([{ action_type: "omni_purchase", value: "n/a" }])).toBeNull();
  });

  it("keeps the fractional values Meta sends for attributed revenue", () => {
    // action_values carries money, and Meta states it to two decimals. Rounding
    // here would silently drop paise on every campaign-day.
    expect(firstPurchaseValue([{ action_type: "omni_purchase", value: "48920.55" }])).toBe(48920.55);
  });
});
