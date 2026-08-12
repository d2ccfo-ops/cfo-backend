import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATERIALITY_PAISE,
  needsApproval,
  requiredRoleFor,
  riskLevelFor,
  roleSatisfies,
} from "./approvals.js";

// The rules that decide whether a second person has to look. All pure, so they
// can be swept — the failure mode of an approval engine is not a crash, it is
// a threshold that quietly lets something through.

const T = DEFAULT_MATERIALITY_PAISE; // ₹25,000

describe("needsApproval", () => {
  it("lets small write-offs through", () => {
    // Requiring sign-off on every ₹200 write-off is how approvals become a
    // reflex click, and an approval nobody reads launders a mistake into a
    // decision two people made.
    expect(needsApproval("RECONCILIATION_WRITE_OFF", 20_000n, T).required).toBe(false);
  });

  it("stops one at the threshold", () => {
    expect(needsApproval("RECONCILIATION_WRITE_OFF", T, T).required).toBe(true);
    expect(needsApproval("RECONCILIATION_WRITE_OFF", T - 1n, T).required).toBe(false);
  });

  it("measures magnitude, not sign", () => {
    // A negative amount is still that much money.
    expect(needsApproval("RECONCILIATION_WRITE_OFF", -T, T).required).toBe(true);
  });

  it("always requires approval for anything leaving the company", () => {
    // Money is not the risk here — the risk is that something wrong, or
    // merely tone-deaf, goes out under the company's name.
    expect(needsApproval("EXTERNAL_MESSAGE", null, T).required).toBe(true);
    expect(needsApproval("EXTERNAL_MESSAGE", 1n, T).required).toBe(true);
  });

  it("always requires approval for a cost restamp", () => {
    // §42.8: a reported figure does not move quietly.
    expect(needsApproval("COST_RESTAMP", null, T).required).toBe(true);
  });

  it("explains itself either way", () => {
    expect(needsApproval("RECONCILIATION_WRITE_OFF", 20_000n, T).reason).toMatch(/below/i);
    expect(needsApproval("RECONCILIATION_WRITE_OFF", 5_000_000n, T).reason).toMatch(/threshold/i);
    // The reason is user-facing prose, so it must carry formatted rupees, not
    // a raw paise integer.
    expect(needsApproval("RECONCILIATION_WRITE_OFF", 5_000_000n, T).reason).toContain("₹");
  });

  it("respects a configured threshold rather than the default", () => {
    const high = 100_000_000n; // ₹10,00,000
    expect(needsApproval("RECONCILIATION_WRITE_OFF", 5_000_000n, high).required).toBe(false);
    expect(needsApproval("RECONCILIATION_WRITE_OFF", 5_000_000n, 1_000_000n).required).toBe(true);
  });
});

describe("riskLevelFor", () => {
  it("escalates with the multiple of the threshold", () => {
    expect(riskLevelFor("RECONCILIATION_WRITE_OFF", 1_000n, T)).toBe("LOW");
    expect(riskLevelFor("RECONCILIATION_WRITE_OFF", T, T)).toBe("MEDIUM");
    expect(riskLevelFor("RECONCILIATION_WRITE_OFF", T * 4n, T)).toBe("HIGH");
  });

  it("treats a cost restamp as high risk whatever the amount", () => {
    expect(riskLevelFor("COST_RESTAMP", null, T)).toBe("HIGH");
  });
});

describe("requiredRoleFor", () => {
  it("routes high risk to an admin and everything else to a finance manager", () => {
    // Routing every approval to an owner is how approvals become a rubber
    // stamp — the finance manager role exists precisely for this.
    expect(requiredRoleFor("HIGH")).toBe("ADMIN");
    expect(requiredRoleFor("MEDIUM")).toBe("FINANCE_MANAGER");
    expect(requiredRoleFor("LOW")).toBe("FINANCE_MANAGER");
  });
});

describe("roleSatisfies", () => {
  it("lets a more senior role act on a junior requirement", () => {
    expect(roleSatisfies("OWNER", "FINANCE_MANAGER")).toBe(true);
    expect(roleSatisfies("ADMIN", "FINANCE_MANAGER")).toBe(true);
    expect(roleSatisfies("FINANCE_MANAGER", "FINANCE_MANAGER")).toBe(true);
  });

  it("does not let a junior role act on a senior requirement", () => {
    expect(roleSatisfies("FINANCE_MANAGER", "ADMIN")).toBe(false);
    expect(roleSatisfies("ACCOUNTANT", "FINANCE_MANAGER")).toBe(false);
    expect(roleSatisfies("ANALYST", "FINANCE_MANAGER")).toBe(false);
    expect(roleSatisfies("VIEWER", "FINANCE_MANAGER")).toBe(false);
    expect(roleSatisfies("EXTERNAL_CA", "FINANCE_MANAGER")).toBe(false);
  });

  it("treats the legacy MEMBER as ANALYST", () => {
    expect(roleSatisfies("MEMBER", "FINANCE_MANAGER")).toBe(false);
  });
});
