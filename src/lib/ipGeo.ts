import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";

// WHERE AN ADDRESS IS REGISTERED. NOT WHERE THE PERSON IS.
//
// That distinction is the whole reason this file has a comment. IP
// geolocation gets the country right nearly always and the city right often
// enough to be dangerous: an Indian mobile connection routinely resolves to the
// carrier's gateway in a different state, a corporate VPN resolves to the
// office, and a residential ISP resolves to whichever exchange owns the block.
// Every field this returns is an inference about an address, and the console
// labels it that way rather than printing a city next to a person's name as
// though it were a fact about them.
//
// LOOKED UP ONCE PER ADDRESS, EVER. The lookup is an internet round trip. Doing
// one per request would put a third party on the hot path of every
// authenticated call and burn any free tier inside an hour. One row per
// address, reused indefinitely.
//
// FAILURES ARE CACHED WITH THEIR REASON. Without that, an unreachable provider
// is retried on every request — one outage becomes a stall on every call, which
// is a far worse failure than not knowing what city someone is in.
//
// PRIVACY, STATED PLAINLY: this sends a customer's IP address to a third party.
// That is standard for operational session logging and it is still a disclosure,
// so it is switchable off with IP_GEO_ENABLED=false, in which case sessions are
// still recorded with their address and simply carry no place.

/** Re-look-up after this long. Address blocks are reassigned, just not often. */
const REFRESH_AFTER_MS = 30 * 86_400_000;
const TIMEOUT_MS = 4000;

export interface GeoFacts {
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timezone: string | null;
  network: string | null;
  /** True when the address belongs to a hosting provider — so, probably a VPN or a bot. */
  hosting: boolean | null;
  source: string;
  error?: string;
}

const UNKNOWN = (source: string, error?: string): GeoFacts => ({
  city: null, region: null, country: null, countryCode: null,
  timezone: null, network: null, hosting: null, source,
  ...(error ? { error } : {}),
});

/**
 * Addresses that can never be looked up, and must not be sent anywhere.
 *
 * Checked BEFORE the cache and before the network. Sending 10.0.0.5 to a
 * geolocation service returns nothing useful and tells that service about our
 * internal addressing; on a laptop, every request would hit this path.
 */
export function isPrivateAddress(ip: string): boolean {
  if (ip === "::1" || ip === "127.0.0.1" || ip === "localhost") return true;
  // IPv4-mapped IPv6, which is how Node reports v4 peers on a dual-stack socket.
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (/^10\./.test(v4)) return true;
  if (/^192\.168\./.test(v4)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true;
  if (/^169\.254\./.test(v4)) return true;
  if (/^127\./.test(v4)) return true;
  // Unique-local and link-local IPv6.
  if (/^f[cd]/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return false;
}

/**
 * Ask the provider.
 *
 * ipapi.co over HTTPS, no key, because the alternative that needs no signup
 * (ip-api.com) is HTTP-only on its free tier — and sending customer addresses
 * over plaintext to answer a nice-to-have is not a trade worth making. A key
 * can be supplied via IP_GEO_TOKEN for a paid tier without changing anything
 * else here.
 */
async function askProvider(ip: string): Promise<GeoFacts> {
  const source = "ipapi.co";
  const url = env.IP_GEO_TOKEN
    ? `https://ipapi.co/${encodeURIComponent(ip)}/json/?key=${encodeURIComponent(env.IP_GEO_TOKEN)}`
    : `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "cfoos-internal/1" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return UNKNOWN(source, `provider answered ${res.status}`);
    const b = (await res.json()) as Record<string, unknown>;
    // The free tier signals rate limiting in the BODY with a 200 status, so a
    // check on res.ok alone would cache "no location" forever for whatever
    // address happened to be next.
    if (b.error) return UNKNOWN(source, String(b.reason ?? b.error).slice(0, 200));
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      city: str(b.city),
      region: str(b.region),
      country: str(b.country_name),
      countryCode: str(b.country_code),
      timezone: str(b.timezone),
      network: str(b.org) ?? str(b.asn),
      // ipapi.co does not report this directly; inferred from the org string,
      // which is a guess and is why the column is nullable rather than false.
      hosting: typeof b.org === "string" ? /hosting|cloud|datacenter|vpn|amazon|google|azure|digitalocean|ovh|linode|hetzner/i.test(b.org) : null,
      source,
    };
  } catch (err) {
    return UNKNOWN(source, err instanceof Error ? err.message.slice(0, 200) : String(err));
  }
}

/**
 * Look up an address, using the cache.
 *
 * NEVER THROWS and never blocks anything important — the caller is a
 * fire-and-forget background write. A session with no place is a complete,
 * useful record; a request that failed because a geolocation service was down
 * is not.
 */
export async function lookupIp(ip: string): Promise<GeoFacts> {
  if (!ip) return UNKNOWN("none", "no address");
  if (isPrivateAddress(ip)) return UNKNOWN("private", "private or loopback address — never sent anywhere");
  if (!env.IP_GEO_ENABLED) return UNKNOWN("disabled", "IP_GEO_ENABLED is false");

  try {
    const cached = await prisma.ipGeo.findUnique({ where: { ip } });
    if (cached && Date.now() - cached.lookedUpAt.getTime() < REFRESH_AFTER_MS) {
      return {
        city: cached.city, region: cached.region, country: cached.country,
        countryCode: cached.countryCode, timezone: cached.timezone,
        network: cached.network, hosting: cached.hosting,
        source: cached.source, ...(cached.error ? { error: cached.error } : {}),
      };
    }

    const facts = await askProvider(ip);
    const row = {
      city: facts.city, region: facts.region, country: facts.country,
      countryCode: facts.countryCode, timezone: facts.timezone,
      network: facts.network, hosting: facts.hosting,
      source: facts.source, error: facts.error ?? null, lookedUpAt: new Date(),
    };
    await prisma.ipGeo.upsert({ where: { ip }, create: { ip, ...row }, update: row });
    return facts;
  } catch (err) {
    logger.warn({ err, ip }, "ip_geo_lookup_failed");
    return UNKNOWN("error", err instanceof Error ? err.message.slice(0, 200) : String(err));
  }
}
