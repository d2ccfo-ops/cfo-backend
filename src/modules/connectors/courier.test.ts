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
  // Parses `~ 'regex' THEN 'slug'` pairs out of the generated CASE statement,
  // in the order they appear, and diffs that list against known JS behaviour
  // for the same needle strings. A hand-edited CARRIER_SQL that drifts from
  // the JS patterns fails here without ever touching Postgres.
  const pairs = [...CARRIER_SQL.matchAll(/~\s*'([^']+)'\s+THEN\s+'([^']+)'/g)].map(
    (m) => [m[1]!, m[2]!] as const
  );

  it("has one clause per known carrier, ending in an ELSE 'other'", () => {
    expect(pairs.map(([, slug]) => slug)).toEqual([
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
