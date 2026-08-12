import { describe, expect, it } from "vitest";
import { orgSettingsSchema } from "./settings.js";

describe("orgSettingsSchema", () => {
  it("accepts a valid paise string", () => {
    expect(orgSettingsSchema.parse({ cashThresholdPaise: "5000000" })).toEqual({ cashThresholdPaise: "5000000" });
  });

  it("accepts null as an explicit unset, not zero", () => {
    expect(orgSettingsSchema.parse({ cashThresholdPaise: null })).toEqual({ cashThresholdPaise: null });
  });

  it("accepts an empty object — every key is optional", () => {
    expect(orgSettingsSchema.parse({})).toEqual({});
  });

  it("rejects a decimal string — paise is already the smallest unit", () => {
    expect(() => orgSettingsSchema.parse({ cashThresholdPaise: "50000.50" })).toThrow();
  });

  it("rejects a negative amount", () => {
    expect(() => orgSettingsSchema.parse({ cashThresholdPaise: "-100" })).toThrow();
  });

  it("rejects a raw number — the wire convention is paise-as-string, like every other money value", () => {
    expect(() => orgSettingsSchema.parse({ cashThresholdPaise: 5000000 })).toThrow();
  });

  it("rejects an unknown key rather than silently dropping it", () => {
    expect(() => orgSettingsSchema.parse({ notARealSetting: "x" })).toThrow();
  });
});
