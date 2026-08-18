import type { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { redisConnection } from "../lib/redis.js";
import { lookupIp } from "../lib/ipGeo.js";

// SOMEBODY JUST SIGNED IN. WHO, FROM WHERE, ON WHAT.
//
// middleware/lastSeen.ts already answers "was this person here recently" and is
// deliberately coarse — one write per five minutes per person, no context. That
// is right for a DAU chart and useless for the question an operator actually
// asks when they open the console, which is "somebody is on the product right
// now; is that who I think it is".
//
// TWO STORES, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
//
//   REDIS holds who is live. Written on EVERY authenticated request — a SET
//   with a TTL, sub-millisecond, no round trip to Postgres. This is what makes
//   the console's live panel genuinely current instead of up to five minutes
//   stale, and the TTL means presence expires on its own: a browser that closes
//   stops appearing without anything having to notice it closed.
//
//   POSTGRES holds the record. One row per Clerk session, written on first
//   sight and then at most once a minute. That is the login history — durable,
//   survives a Redis flush, and is what "they signed in from Pune at 14:02"
//   comes from.
//
// THE FRESHNESS CEILING IS THE USER, NOT THE TRANSPORT. This records what the
// browser asks for, so somebody reading a page without clicking produces no
// requests and does not move. No amount of websocket would change that, which
// is why the console polls rather than holding a connection open: the transport
// is not the limiting factor and a connection to keep alive would be complexity
// bought for nothing.
//
// NOTHING HERE CAN FAIL A REQUEST. It is bookkeeping about the request, not part
// of serving it.

/** Presence expires on its own. Longer than a page's idle time, shorter than a coffee. */
const PRESENCE_TTL_S = 900;
/** How often a session's durable row is refreshed after the first write. */
const DURABLE_WRITE_MS = 60_000;

const KEY = (sessionId: string) => `presence:${sessionId}`;

/**
 * (sessionId) -> when THIS process last wrote a durable row.
 *
 * Throttling only. It deliberately does not track counts: four API workers each
 * keep their own map, so anything derived from it is per-process and a count
 * derived from it double-counts. The count comes from Redis instead — see
 * DRAIN below, which is the whole reason that script exists.
 */
const lastDurableWrite = new Map<string, number>();
const sweep = setInterval(() => {
  const cutoff = Date.now() - DURABLE_WRITE_MS * 5;
  for (const [k, at] of lastDurableWrite) if (at < cutoff) lastDurableWrite.delete(k);
}, 10 * 60_000);
sweep.unref();

/**
 * ATOMICALLY TAKE THE REQUESTS NOBODY HAS PERSISTED YET.
 *
 * `n` counts every request in the current presence window. `w` is the
 * watermark: how much of `n` has already been added to the durable row. This
 * returns the difference and advances the watermark in the same breath.
 *
 * IT IS A SCRIPT BECAUSE IT MUST BE ATOMIC. The obvious version — read n, read
 * w, subtract, write w — is a read-modify-write across four API processes, and
 * two of them draining at once both see (n=50, w=10), both report 40, and the
 * stored total ends up 80 for 40 requests. A first attempt at this kept the
 * watermark in a per-process Map, which has the same flaw in a worse disguise:
 * it looks right on one process and over-counts by up to 4x in production, and
 * the number it is wrong about is a request count nobody would think to check.
 *
 * n itself is never reset, so the live count shown on the console keeps
 * climbing for as long as the session stays active.
 */
const DRAIN = `
local n = tonumber(redis.call('HGET', KEYS[1], 'n') or '0')
local w = tonumber(redis.call('HGET', KEYS[1], 'w') or '0')
if n <= w then return 0 end
redis.call('HSET', KEYS[1], 'w', n)
return n - w
`;

/** Test seam. */
export function resetSessionTrackerForTest(): void {
  lastDurableWrite.clear();
}

export interface Presence {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  ip: string | null;
  at: number;
  userAgent: string | null;
  path: string;
  /** Requests counted against this session since its presence key was created. */
  requests: number;
}

interface DurableWrite extends Presence {
  /** The window's running total, used only to seed a row that does not exist yet. */
  live?: number;
}

/**
 * A coarse User-Agent parse.
 *
 * Coarse ON PURPOSE and the raw string is always stored beside it. A full UA
 * database is a dependency that ages badly and is wrong about new browsers in
 * exactly the way that makes a panel confidently mislabel a device. Four
 * families and five platforms answer "is that their usual laptop", which is the
 * only question anybody asks this.
 *
 * ORDER MATTERS. Every Chromium browser also says "Safari", Edge also says
 * "Chrome", and Chrome on iOS says "CriOS" and nothing else — so the most
 * specific claim has to be tested first or everything collapses into Safari.
 */
export function parseUserAgent(ua: string | null): { browser: string | null; os: string | null; deviceKind: string | null } {
  if (!ua) return { browser: null, os: null, deviceKind: null };

  const browser =
    /\bEdg[A-Z]?\//.test(ua) ? "Edge"
    : /\b(OPR|Opera)\//.test(ua) ? "Opera"
    : /\bCriOS\//.test(ua) ? "Chrome"
    : /\bFxiOS\//.test(ua) ? "Firefox"
    : /\bFirefox\//.test(ua) ? "Firefox"
    : /\bChrome\//.test(ua) ? "Chrome"
    : /\bSafari\//.test(ua) ? "Safari"
    : /\b(curl|wget|python-requests|node-fetch|Go-http-client)\b/i.test(ua) ? "script"
    : null;

  const os =
    /\biPhone\b/.test(ua) ? "iOS"
    : /\biPad\b/.test(ua) ? "iPadOS"
    : /\bAndroid\b/.test(ua) ? "Android"
    // "Windows NT" before "Mac OS X": Chrome on Windows mentions neither
    // ambiguously, but some UA strings carry both tokens.
    : /\bWindows NT\b/.test(ua) ? "Windows"
    : /\bMac OS X\b/.test(ua) ? "macOS"
    : /\b(CrOS)\b/.test(ua) ? "ChromeOS"
    : /\bLinux\b/.test(ua) ? "Linux"
    : null;

  const deviceKind =
    /\bbot\b|crawler|spider|HeadlessChrome/i.test(ua) ? "bot"
    : /\biPad\b|\bTablet\b/.test(ua) ? "tablet"
    : /\bMobi\b|\biPhone\b|\bAndroid\b/.test(ua) ? "mobile"
    : browser === "script" ? "script"
    : "desktop";

  return { browser, os, deviceKind };
}

/**
 * The caller's real address.
 *
 * req.ip, which is correct ONLY because app.ts sets `trust proxy` to 1 and
 * Caddy APPENDS the peer address to X-Forwarded-For. With one trusted hop
 * Express takes the rightmost entry — the one Caddy wrote. Everything to its
 * left is whatever the client chose to send, so a version of this that read the
 * leftmost entry would be recording an attacker's preferred address and calling
 * it evidence.
 */
function addressOf(req: Request): string | null {
  const ip = req.ip ?? null;
  if (!ip) return null;
  // Node reports IPv4 peers on a dual-stack socket in v4-mapped form. Stored
  // bare so the same machine is one address in the table rather than two.
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * Record presence and, when due, the durable session row.
 *
 * Mounted globally after clerkMiddleware rather than inside requireAuth, so a
 * signed-in user who has not yet chosen an organisation — the entire onboarding
 * flow — is still visible. Those sessions carry a null organizationId, which is
 * a true statement about them.
 */
export function trackSession(req: Request, _res: Response, next: NextFunction): void {
  let auth: ReturnType<typeof getAuth>;
  try {
    auth = getAuth(req);
  } catch {
    // clerkMiddleware has not run for this route (the webhook mounts, which
    // parse raw bodies before it). Nothing to record.
    next();
    return;
  }

  const userId = auth.userId;
  const sessionId = auth.sessionId;
  if (!userId || !sessionId) {
    next();
    return;
  }

  const ip = addressOf(req);
  const userAgent = req.get("user-agent")?.slice(0, 500) ?? null;
  const organizationId = req.auth?.organizationId ?? null;
  const now = Date.now();

  const path = (req.originalUrl ?? req.path ?? "/").split("?")[0]?.slice(0, 120) ?? "/";

  // A HASH, and the request counter lives in it.
  //
  // A plain SET of a JSON blob cannot count without a read-modify-write, which
  // is a race across four API processes. HINCRBY is atomic, so the count is
  // exact regardless of how many workers are serving. All three commands go in
  // one pipeline: one round trip per request, not three.
  const key = KEY(sessionId);
  const pipeline = redisConnection.pipeline();
  pipeline.hset(key, {
    u: userId, o: organizationId ?? "", ip: ip ?? "", at: String(now),
    ua: userAgent ?? "", p: path,
  });
  pipeline.hincrby(key, "n", 1);
  // Refreshed on every request, so presence expires a fixed time after the last
  // one rather than a fixed time after the first.
  pipeline.expire(key, PRESENCE_TTL_S);

  // Fire and forget. next() runs below regardless; nothing on this path is
  // awaited and nothing on it can reject into the request.
  void pipeline
    .exec()
    .then((results) => {
      // The HINCRBY reply is the session's live request count.
      const n = Number(results?.[1]?.[1] ?? 0);
      const previous = lastDurableWrite.get(sessionId);
      if (previous !== undefined && now - previous < DURABLE_WRITE_MS) return;
      lastDurableWrite.set(sessionId, now);

      void redisConnection
        .eval(DRAIN, 1, key)
        .then((drained) =>
          writeDurable({
            sessionId, userId, organizationId, ip, at: now, userAgent, path,
            // At least 1, because reaching here means this request happened —
            // a drain of 0 would be a row claiming a session made no requests.
            requests: Math.max(1, Number(drained ?? 0)),
            live: n,
          }),
        )
        .catch((err: unknown) => logger.warn({ err, userId }, "session_write_failed"));
    })
    .catch((err: unknown) => logger.debug({ err }, "presence_write_failed"));

  next();
}

/**
 * Upsert the session row.
 *
 * signedInAt is set on CREATE ONLY and never on update — it is the moment this
 * session started being used, which is the login. Updating it would turn the
 * login history into a list of "most recent activity", which is what
 * lastSeenAt already is.
 *
 * Geolocation is resolved on the create path and on the path where the address
 * changed. Looking it up on every durable write would mean a cache hit every
 * minute per session for a value that cannot have changed.
 */
async function writeDurable(p: DurableWrite): Promise<void> {
  const at = new Date(p.at);
  const existing = await prisma.userSession.findUnique({
    where: { clerkSessionId: p.sessionId },
    select: { ip: true },
  });

  const ua = parseUserAgent(p.userAgent);
  const needsGeo = p.ip !== null && (existing === null || existing.ip !== p.ip);
  const geo = needsGeo && p.ip ? await lookupIp(p.ip) : null;

  const geoFields = geo
    ? {
        city: geo.city, region: geo.region, country: geo.country,
        countryCode: geo.countryCode, timezone: geo.timezone,
        network: geo.network, hosting: geo.hosting,
      }
    : {};

  await prisma.userSession.upsert({
    where: { clerkSessionId: p.sessionId },
    create: {
      clerkSessionId: p.sessionId,
      clerkUserId: p.userId,
      organizationId: p.organizationId,
      signedInAt: at,
      lastSeenAt: at,
      // A row created mid-window inherits the window's whole count, not just
      // the drained slice — otherwise the requests that happened before this
      // process first wrote are silently lost.
      requests: Math.max(1, p.live ?? p.requests),
      ip: p.ip,
      userAgent: p.userAgent,
      ...ua,
      ...geoFields,
    },
    update: {
      lastSeenAt: at,
      // The DELTA since this process last wrote, not a flat 1. The naive
      // version incremented once per durable write, so a session that made four
      // hundred requests in a minute recorded "1" — a number that looks like a
      // request count, is labelled as one, and is off by two orders of
      // magnitude exactly when the session is most interesting.
      requests: { increment: p.requests },
      // The organisation can arrive AFTER the session starts — onboarding signs
      // in first and creates an org second — so a null must never overwrite a
      // value we already have.
      ...(p.organizationId ? { organizationId: p.organizationId } : {}),
      ...(p.ip ? { ip: p.ip } : {}),
      ...geoFields,
    },
  });
}

/**
 * Everyone with unexpired presence.
 *
 * SCAN, not KEYS: KEYS blocks the whole Redis instance while it walks the
 * keyspace, and this Redis is also the queue, the response cache and the rate
 * limiter. The count is tiny either way; the difference is what happens to
 * everything else while it runs.
 */
export async function readPresence(): Promise<Presence[]> {
  const out: Presence[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redisConnection.scan(cursor, "MATCH", "presence:*", "COUNT", 200);
    cursor = next;
    if (keys.length > 0) {
      const pipeline = redisConnection.pipeline();
      for (const k of keys) pipeline.hgetall(k);
      const results = await pipeline.exec();
      results?.forEach(([, value], i) => {
        const h = value as Record<string, string> | null;
        if (!h || !h.u) return;
        out.push({
          sessionId: (keys[i] ?? "").slice("presence:".length),
          userId: h.u,
          organizationId: h.o || null,
          ip: h.ip || null,
          at: Number(h.at ?? 0),
          userAgent: h.ua || null,
          path: h.p ?? "/",
          requests: Number(h.n ?? 0),
        });
      });
    }
  } while (cursor !== "0");
  return out;
}
