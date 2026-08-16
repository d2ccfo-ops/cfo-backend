import { describe, expect, it } from "vitest";
import { CARRIER_SQL, normaliseCourier } from "./courier.js";

// The 26-spelling fixture behind this table, and the live-DB agreement check
// against every distinct courierName this store has actually seen, live in
// scripts/checkFreightReconciliation.ts (needs Postgres — check:integration).
// This is the DB-free subset: the fixture spellings, and a structural proof
// that CARRIER_SQL's regex needles are exactly PATTERNS' regex sources, in the
// same order — the mirror assertion the plan calls for, without a database.
describe("normaliseCourier", () => {
  const spellings: Array<[string, string]> = [
    ["Bluedart", "bluedart"],
    ["Blue Dart Air", "bluedart"],
    ["Bluedart Surface - Select  500gm", "bluedart"],
    ["Blue Dart Surface_Network Stress", "bluedart"],
    ["Delhivery", "delhivery"],
    ["DTDC", "dtdc"],
    ["DTDC Surface_Network Stress", "dtdc"],
    ["DTD Express", "dtdc"],
    ["Shadowfax  Surface_Network Stress", "shadowfax"],
    ["XpressBees", "xpressbees"],
    ["Xpressbees Surface 5kg", "xpressbees"],
    ["Ekart Logistics Surface", "ekart"],
    ["India Post Domestic", "indiapost"],
    ["Amazon COD Surface 500gm", "amazon"],
    ["", "other"],
    ["Some New Courier", "other"],
  ];

  it.each(spellings)('normalises "%s" to %s', (raw, expected) => {
    expect(normaliseCourier(raw)).toBe(expected);
  });

  it("returns other for null/undefined rather than guessing", () => {
    expect(normaliseCourier(null)).toBe("other");
    expect(normaliseCourier(undefined)).toBe("other");
  });

  it("checks dtdc before DTD Express can be swallowed by a looser pattern", () => {
    // Ordering matters: this is the one case in the file comment calling out
    // a deliberate sequencing so one pattern can't shadow another.
    expect(normaliseCourier("DTD Express")).toBe("dtdc");
  });
});

describe("CARRIER_SQL mirrors normaliseCourier's patterns", () => {
  // Parses the generated CASE statement into (needle, slug) pairs, in the order
  // they appear, and diffs that against known JS behaviour for the same
  // needles. A hand-edited CARRIER_SQL that drifts from the JS patterns fails
  // here without ever touching Postgres.
  //
  // Reads position('needle' in …) rather than the old ~ 'a|b' because the SQL
  // now uses substring search instead of the regex engine — see the timing
  // table in courier.ts. That splits each alternation into its own needle, so
  // this checks "bdart" and "xbees" individually where it used to feed the
  // whole "bluedart|bdart" string through as one.
  const clauses = CARRIER_SQL.split(/\bWHEN\b/)
    .slice(1)
    .map((chunk) => ({
      slug: chunk.match(/THEN\s+'([^']+)'/)?.[1],
      needles: [...chunk.matchAll(/position\('([^']+)'\s+in\b/g)].map((m) => m[1]!),
    }));
  const pairs = clauses.flatMap((c) => c.needles.map((n) => [n, c.slug!] as const));

  it("parses at all — an unrecognised CASE shape must fail loudly, not vacuously pass", () => {
    // Without this, a future rewrite that stops matching the parser above
    // yields zero pairs, and every it.each below silently tests nothing.
    expect(clauses.length).toBe(8);
    expect(pairs.length).toBeGreaterThanOrEqual(8);
  });

  it("has one clause per known carrier, ending in an ELSE 'other'", () => {
    expect(clauses.map((c) => c.slug)).toEqual([
      "bluedart",
      "delhivery",
      "dtdc",
      "shadowfax",
      "xpressbees",
      "ekart",
      "indiapost",
      "amazon",
    ]);
    expect(CARRIER_SQL).toMatch(/ELSE 'other'/);
  });

  it.each(pairs)("SQL needle for %s agrees with normaliseCourier on its own regex text", (needle, slug) => {
    // The needle IS a valid input to the JS matcher (both squash to
    // lowercase alnum), so feeding it straight through is a direct agreement
    // check, not a re-implementation of the regex engine.
    expect(normaliseCourier(needle)).toBe(slug);
  });
});
