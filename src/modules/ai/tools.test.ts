import { describe, expect, it } from "vitest";
import { EVIDENCE_ENVELOPE_METRICS, TOOLS, TOOLS_BY_NAME, isEvidenceEnvelopeRef, isKnownEvidenceRef } from "./tools.js";
import { MATERIAL_METRIC_KEYS } from "../calc/dataStatus.js";
import { LONG_TAIL_METRIC_KEYS, isLongTailMetric } from "../calc/evidenceLongTail.js";

// The registry's own invariants. None of these need a database, because none
// of them are about what a tool RETURNS — they are about what the model is
// shown and what it is allowed to reach.

describe("tool registry", () => {
  it("has no duplicate names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool has a description a model can choose on", () => {
    for (const t of TOOLS) {
      // A one-word description is the reason a model picks the wrong tool.
      expect(t.description.length, t.name).toBeGreaterThan(40);
    }
  });

  it("no tool takes an organizationId argument", () => {
    // Org scope is closed over from the authenticated context. If it ever
    // becomes an argument, a cross-tenant request stops being unrepresentable
    // and becomes merely rejected — which is one bug away from allowed.
    for (const t of TOOLS) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const key of Object.keys(props)) {
        expect(key.toLowerCase(), t.name).not.toContain("organization");
        expect(key.toLowerCase(), t.name).not.toContain("orgid");
        expect(key.toLowerCase(), t.name).not.toContain("tenant");
      }
    }
  });

  it("every inputSchema forbids additional properties", () => {
    for (const t of TOOLS) {
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties, t.name).toBe(false);
    }
  });

  it("TOOLS_BY_NAME covers every tool", () => {
    expect(TOOLS_BY_NAME.size).toBe(TOOLS.length);
  });
});

describe("evidence references", () => {
  it("the envelope metric list matches what the §21 route actually serves", () => {
    // If a metric is added to one and not the other, an AI answer starts
    // citing a URL that 404s — which is exactly the bug this list was
    // introduced to close.
    //
    // P6.8 split what the route serves in two: the material five (which carry
    // a reconciliation status) and the long tail (which carry
    // NOT_RECONCILABLE with a reason). The assertion is EQUALITY against the
    // union — a subset check would let a metric be citable without being
    // served, which is the 404 this exists to prevent, and would also let a
    // served metric quietly drop out of the citable set.
    const served = [...MATERIAL_METRIC_KEYS, ...LONG_TAIL_METRIC_KEYS].sort();
    expect([...EVIDENCE_ENVELOPE_METRICS].sort()).toEqual(served);
  });

  it("the two evidence builders do not overlap", () => {
    // A key in both would be dispatched by whichever branch is tested first,
    // and the long-tail branch runs first — so a material metric added here by
    // mistake would silently lose its reconciliation status.
    const material = new Set<string>(MATERIAL_METRIC_KEYS);
    for (const key of LONG_TAIL_METRIC_KEYS) {
      expect(material.has(key), `${key} is in both builders`).toBe(false);
    }
  });

  it("every long-tail metric reports NOT_RECONCILABLE rather than borrowing a status", () => {
    // The field a reader trusts INSTEAD of checking. Nothing external states a
    // state's margin or a campaign's ROAS, so claiming verification would be
    // the most damaging thing this envelope could say.
    for (const key of LONG_TAIL_METRIC_KEYS) {
      expect(isLongTailMetric(key)).toBe(true);
    }
    expect(isLongTailMetric("revenue")).toBe(false);
    expect(isLongTailMetric("nonsense")).toBe(false);
  });

  it("every evidenceRef a tool can emit resolves to something real", async () => {
    // Static scan of the source rather than execution: running all 22 tools
    // would need a database, and the property being asserted is textual.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
    const refs = [...src.matchAll(/evidenceRef: "([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of refs) expect(isKnownEvidenceRef(ref), ref).toBe(true);
  });

  it("distinguishes the evidence API from a screen", () => {
    expect(isEvidenceEnvelopeRef("/evidence/revenue")).toBe(true);
    expect(isEvidenceEnvelopeRef("/reconciliation")).toBe(false);
    expect(isKnownEvidenceRef("/reconciliation")).toBe(true);
    expect(isKnownEvidenceRef("/evidence/rto_rate")).toBe(false);
    expect(isKnownEvidenceRef("/evidence")).toBe(false);
  });
});

describe("tool argument validation", () => {
  it("rejects an unknown argument rather than ignoring it", () => {
    const t = TOOLS_BY_NAME.get("get_revenue_summary")!;
    // A model that passes {organizationId: "other-org"} must be told no, not
    // silently served its own org's data as though the argument had worked.
    expect(t.schema.safeParse({ organizationId: "other-org" }).success).toBe(false);
  });

  it("accepts an empty argument object for range tools", () => {
    expect(TOOLS_BY_NAME.get("get_revenue_summary")!.schema.safeParse({}).success).toBe(true);
  });

  it("constrains get_evidence to the five material metrics", () => {
    const t = TOOLS_BY_NAME.get("get_evidence")!;
    expect(t.schema.safeParse({ metric: "revenue" }).success).toBe(true);
    expect(t.schema.safeParse({ metric: "rto_rate" }).success).toBe(false);
  });
});
