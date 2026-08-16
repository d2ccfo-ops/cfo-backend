// Courier names arrive as free text and there are 26 distinct spellings across
// 21,187 shipments on the live store for what are really 8 carriers:
//
//   Bluedart · "Bluedart Surface - Select  500gm" · "Blue Dart Air" ·
//   "Blue Dart Surface_Network Stress"                          -> bluedart
//   DTDC · "DTDC Surface" · "DTDC Air 500gm" · "DTDC India" ·
//   "DTDC Surface_Network Stress" · "DTD Express"               -> dtdc
//   Shadowfax · "Shadowfax Surface" · "Shadowfax  Surface_…"    -> shadowfax
//   XpressBees · "Xpressbees Surface" · "Xpressbees Surface 5kg" -> xpressbees
//
// The suffixes encode service level, weight slab and a load-shedding note —
// none of which change WHO carried the parcel. Grouping by the raw string makes
// Bluedart look like four small carriers and hides that it is 84% of volume.
//
// Matched on a squashed form so spacing and punctuation cannot fork a carrier:
// "Blue Dart Air", "Bluedart", "BLUE-DART" all reduce to "bluedart".

export type CarrierSlug =
  | "bluedart"
  | "delhivery"
  | "dtdc"
  | "shadowfax"
  | "xpressbees"
  | "ekart"
  | "indiapost"
  | "amazon"
  | "other";

// Ordered: the first substring that hits wins. "DTD Express" is deliberately
// checked after "dtdc" so it cannot swallow it.
const PATTERNS: Array<[CarrierSlug, RegExp]> = [
  ["bluedart", /bluedart|bdart/],
  ["delhivery", /delhivery/],
  ["dtdc", /dtdc|dtdexpress/],
  ["shadowfax", /shadowfax|sfx/],
  ["xpressbees", /xpressbees|xbees/],
  ["ekart", /ekart/],
  ["indiapost", /indiapost|indianpost|speedpost/],
  ["amazon", /amazon/],
];

/** Squash to a comparison key: lowercase, letters and digits only. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Canonical carrier for a free-text courier name.
 *
 * Unrecognised names return "other" rather than a plausible neighbour — a
 * parcel attributed to the wrong carrier corrupts that carrier's RTO rate and
 * its freight reconciliation, and a visible "other" bucket is how a new courier
 * gets noticed instead of silently absorbed.
 */
export function normaliseCourier(name: string | null | undefined): CarrierSlug {
  if (!name) return "other";
  const key = squash(name);
  if (!key) return "other";
  for (const [slug, re] of PATTERNS) {
    if (re.test(key)) return slug;
  }
  return "other";
}

const LABELS: Record<CarrierSlug, string> = {
  bluedart: "Blue Dart",
  delhivery: "Delhivery",
  dtdc: "DTDC",
  shadowfax: "Shadowfax",
  xpressbees: "XpressBees",
  ekart: "Ekart",
  indiapost: "India Post",
  amazon: "Amazon Logistics",
  other: "Other / unrecognised",
};

export function carrierLabel(slug: CarrierSlug): string {
  return LABELS[slug];
}

/**
 * SQL fragment producing the same slug as normaliseCourier(), for aggregates
 * that must not pull 21,187 rows into memory to group them.
 *
 * Kept beside the function it mirrors so the two cannot drift apart unnoticed;
 * scripts/checkFreightReconciliation.ts asserts they agree on every spelling
 * present in the database.
 */
// position() rather than the regex operator, and that is a measured choice
// rather than a stylistic one. This fragment was the single most expensive
// query on the deployment by total time — pg_stat_statements had four variants
// of the freight leg at a 1,849ms mean, against an EXPLAIN ANALYZE of 18-32ms
// for comparable queries, because the box is CPU-bound and this burns CPU on
// every row of a 49,000-row table.
//
// Timed on the live data, grouping all shipments by slug:
//
//   8 x regexp_replace + 8 x ~   (this, before)   229ms
//   squash once, then 8 x ~                       233ms   <- no better
//   8 x regexp_replace + 8 x position()           147ms   <- this, now
//   map the 27 distinct names and join back       363ms   <- worse
//
// The second line is the informative one: hoisting the repeated
// regexp_replace out changed nothing, so Postgres was already folding it. The
// cost was never the squash, it was starting the regex engine eight times per
// row. position() is a plain substring search, and alternation is just OR —
// which is all these patterns ever meant.
//
// Writing the squash inline eight times therefore costs nothing and keeps this
// a self-contained expression, so every call site embeds it unchanged.
//
// Equivalence is not assumed: checked against the previous expression across
// all 49,082 shipments, 0 rows disagree. courier.test.ts holds it to
// normaliseCourier(), and scripts/checkFreightReconciliation.ts re-checks both
// against every spelling actually present in the database.
export const CARRIER_SQL = `CASE
  WHEN position('bluedart' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0
    OR position('bdart' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0 THEN 'bluedart'
  WHEN position('delhivery' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0 THEN 'delhivery'
  WHEN position('dtdc' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0
    OR position('dtdexpress' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0 THEN 'dtdc'
  WHEN position('shadowfax' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0
    OR position('sfx' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0 THEN 'shadowfax'
  WHEN position('xpressbees' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0
    OR position('xbees' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0 THEN 'xpressbees'
  WHEN position('ekart' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0 THEN 'ekart'
  WHEN position('indiapost' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0
    OR position('indianpost' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0
    OR position('speedpost' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0 THEN 'indiapost'
  WHEN position('amazon' in lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g'))) > 0 THEN 'amazon'
  ELSE 'other'
END`;
