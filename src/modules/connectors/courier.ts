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
export const CARRIER_SQL = `CASE
  WHEN lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g')) ~ 'bluedart|bdart' THEN 'bluedart'
  WHEN lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g')) ~ 'delhivery' THEN 'delhivery'
  WHEN lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g')) ~ 'dtdc|dtdexpress' THEN 'dtdc'
  WHEN lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g')) ~ 'shadowfax|sfx' THEN 'shadowfax'
  WHEN lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g')) ~ 'xpressbees|xbees' THEN 'xpressbees'
  WHEN lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g')) ~ 'ekart' THEN 'ekart'
  WHEN lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g')) ~ 'indiapost|indianpost|speedpost' THEN 'indiapost'
  WHEN lower(regexp_replace(coalesce("courierName",''), '[^a-zA-Z0-9]', '', 'g')) ~ 'amazon' THEN 'amazon'
  ELSE 'other'
END`;
