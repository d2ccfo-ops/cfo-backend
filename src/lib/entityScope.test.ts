import { describe, expect, it } from "vitest";
import { ENTITY_SCOPED_PATHS, scopeIsMeaningful, scopeWhere, unsupportedScopeMessage } from "./entityScope.js";

// The failure this guards is specific and silent: a figure covering the whole
// organisation, served under an entity label, to a reader who specifically
// asked for a subset. Every case below is one way to produce that.

describe("scopeWhere", () => {
  it("returns a bare org filter when no entity is selected", () => {
    expect(scopeWhere("org1", null)).toEqual({ organizationId: "org1" });
    expect(scopeWhere("org1", { legalEntityId: null, entityCount: 3 })).toEqual({ organizationId: "org1" });
    expect(scopeWhere("org1")).toEqual({ organizationId: "org1" });
  });

  it("filters when the organisation genuinely has more than one entity", () => {
    expect(scopeWhere("org1", { legalEntityId: "e1", entityCount: 2 })).toEqual({
      organizationId: "org1",
      legalEntityId: "e1",
    });
  });

  it("does NOT filter a single-entity organisation", () => {
    // Provably the same set of rows either way — and adding the filter would
    // exclude rows whose legalEntityId is null, which is a real state for
    // records ingested before entities existed. That would turn a cosmetic
    // picker into one that silently drops data.
    expect(scopeWhere("org1", { legalEntityId: "e1", entityCount: 1 })).toEqual({ organizationId: "org1" });
    expect(scopeWhere("org1", { legalEntityId: "e1", entityCount: 0 })).toEqual({ organizationId: "org1" });
  });

  it("never drops the organisation filter", () => {
    // The one mistake that would be catastrophic rather than merely wrong.
    for (const scope of [null, { legalEntityId: "e1", entityCount: 1 }, { legalEntityId: "e1", entityCount: 9 }]) {
      expect(scopeWhere("org1", scope).organizationId).toBe("org1");
    }
  });
});

describe("scopeIsMeaningful", () => {
  it("is false when the filter cannot change the answer", () => {
    expect(scopeIsMeaningful(null)).toBe(false);
    expect(scopeIsMeaningful({ legalEntityId: null, entityCount: 5 })).toBe(false);
    expect(scopeIsMeaningful({ legalEntityId: "e1", entityCount: 1 })).toBe(false);
  });

  it("is true only when an entity is chosen out of several", () => {
    expect(scopeIsMeaningful({ legalEntityId: "e1", entityCount: 2 })).toBe(true);
  });
});

describe("unsupportedScopeMessage", () => {
  it("says nothing when the filter would not have changed the answer", () => {
    expect(unsupportedScopeMessage({ legalEntityId: "e1", entityCount: 1 }, "Ad spend")).toBeNull();
    expect(unsupportedScopeMessage(undefined, "Ad spend")).toBeNull();
  });

  it("explains WHY it cannot, not just that it cannot", () => {
    const msg = unsupportedScopeMessage({ legalEntityId: "e1", entityCount: 3 }, "Ad spend")!;
    expect(msg).toContain("Ad spend");
    expect(msg).toContain("carry no entity");
    expect(msg).toContain("whole organisation");
  });
});

describe("ENTITY_SCOPED_PATHS", () => {
  it("lists what IS supported rather than what is not", () => {
    // The direction matters: a not-supported list has to be updated every time
    // an endpoint is added, and the one somebody forgets answers with the
    // organisation-wide figure under an entity label. A supported list fails
    // closed — a forgotten endpoint gets the warning it deserves.
    expect(ENTITY_SCOPED_PATHS.has("/metrics/revenue")).toBe(true);
    expect(ENTITY_SCOPED_PATHS.has("/metrics/contribution-margin")).toBe(true);
    expect(ENTITY_SCOPED_PATHS.has("/metrics/available-cash")).toBe(false);
    expect(ENTITY_SCOPED_PATHS.has("/metrics/ad-spend")).toBe(false);
  });

  it("only lists order-driven metrics, which are the ones carrying an entity", () => {
    // Bank balances belong to an account and ad spend to an ad account;
    // neither has an entity column, so neither can honestly appear here.
    for (const path of ENTITY_SCOPED_PATHS) {
      expect(path.startsWith("/metrics/")).toBe(true);
      expect(["/metrics/available-cash", "/metrics/ad-spend", "/metrics/payables"]).not.toContain(path);
    }
  });
});
