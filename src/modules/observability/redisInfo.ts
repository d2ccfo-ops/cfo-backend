import { redisConnection } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";

// Redis' own account of itself, from INFO — previously the one panel on the
// infrastructure page with no source behind it.
//
// WHY IT IS WORTH A PANEL. This deployment leans on Redis for three separate
// jobs with different failure modes: BullMQ's queue (a stall means syncs stop),
// calcCache and orgReadCache (a full instance means every dashboard read
// recomputes), and the §27 rate limiter (an unreachable instance means
// consume() fails open and there is no limit at all — see rateLimit.ts, which
// deliberately calls next() rather than 500ing). None of those announce
// themselves; they present as "the app got slow" or "the app stopped syncing".
//
// THE NUMBER THAT MATTERS MOST IS maxmemory, and it is why this exists. Redis
// runs with `--maxmemory 128mb --maxmemory-policy noeviction`. Noeviction means
// that when it fills, writes do not silently drop the oldest key — they FAIL.
// The durable response cache would stop being written, the rate limiter's INCR
// would throw, and the app would degrade in three unrelated-looking ways at
// once. Used-versus-max is the early warning for all three.
//
// Hit rate is reported as null, never zero, when nothing has been looked up
// yet: a fresh instance that has answered no reads has no hit rate, which is
// not the same as missing everything.

export interface RedisStats {
  version: string | null;
  uptimeSeconds: number | null;
  connectedClients: number | null;
  usedMemoryBytes: number | null;
  usedMemoryPeakBytes: number | null;
  maxMemoryBytes: number | null;
  /** null when maxmemory is 0, i.e. unbounded — a ratio would be meaningless. */
  memoryUsedRatio: number | null;
  maxMemoryPolicy: string | null;
  /**
   * TRUE when a write can fail rather than evict. Surfaced as its own flag
   * because "noeviction" reads as a safe-sounding word and is the opposite.
   */
  writesFailWhenFull: boolean;
  evictedKeys: number | null;
  expiredKeys: number | null;
  keyspaceHits: number | null;
  keyspaceMisses: number | null;
  /** null when nothing has been read yet — not zero. */
  hitRate: number | null;
  totalCommands: number | null;
  opsPerSecond: number | null;
  blockedClients: number | null;
  rejectedConnections: number | null;
  keyCount: number | null;
  error?: string;
}

function parseInfo(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return out;
}

const num = (m: Map<string, string>, k: string): number | null => {
  const v = m.get(k);
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function readRedisStats(): Promise<RedisStats> {
  const empty: RedisStats = {
    version: null, uptimeSeconds: null, connectedClients: null,
    usedMemoryBytes: null, usedMemoryPeakBytes: null, maxMemoryBytes: null,
    memoryUsedRatio: null, maxMemoryPolicy: null, writesFailWhenFull: false,
    evictedKeys: null, expiredKeys: null, keyspaceHits: null, keyspaceMisses: null,
    hitRate: null, totalCommands: null, opsPerSecond: null, blockedClients: null,
    rejectedConnections: null, keyCount: null,
  };

  try {
    // Three sections rather than the whole of INFO: everything below lives in
    // one of them, and `INFO all` additionally walks the keyspace on some
    // builds, which is not something an observability read should ever do to a
    // production instance.
    const [server, memory, stats, clients, keyspace] = await Promise.all([
      redisConnection.info("server"),
      redisConnection.info("memory"),
      redisConnection.info("stats"),
      redisConnection.info("clients"),
      redisConnection.info("keyspace"),
    ]);

    const m = new Map<string, string>([
      ...parseInfo(server), ...parseInfo(memory), ...parseInfo(stats),
      ...parseInfo(clients), ...parseInfo(keyspace),
    ]);

    const used = num(m, "used_memory");
    const max = num(m, "maxmemory");
    const hits = num(m, "keyspace_hits");
    const misses = num(m, "keyspace_misses");
    const lookups = (hits ?? 0) + (misses ?? 0);
    const policy = m.get("maxmemory_policy") ?? null;

    // db0:keys=123,expires=4,avg_ttl=0
    let keyCount: number | null = null;
    for (const [k, v] of m) {
      if (!k.startsWith("db")) continue;
      const match = /keys=(\d+)/.exec(v);
      if (match?.[1]) keyCount = (keyCount ?? 0) + Number(match[1]);
    }

    return {
      version: m.get("redis_version") ?? null,
      uptimeSeconds: num(m, "uptime_in_seconds"),
      connectedClients: num(m, "connected_clients"),
      usedMemoryBytes: used,
      usedMemoryPeakBytes: num(m, "used_memory_peak"),
      maxMemoryBytes: max,
      // 0 means unbounded in Redis, which is not a ratio of anything.
      memoryUsedRatio: max !== null && max > 0 && used !== null ? used / max : null,
      maxMemoryPolicy: policy,
      writesFailWhenFull: policy === "noeviction",
      evictedKeys: num(m, "evicted_keys"),
      expiredKeys: num(m, "expired_keys"),
      keyspaceHits: hits,
      keyspaceMisses: misses,
      // Nothing read yet is not a 0% hit rate.
      hitRate: lookups > 0 ? (hits ?? 0) / lookups : null,
      totalCommands: num(m, "total_commands_processed"),
      opsPerSecond: num(m, "instantaneous_ops_per_sec"),
      blockedClients: num(m, "blocked_clients"),
      rejectedConnections: num(m, "rejected_connections"),
      keyCount,
    };
  } catch (err) {
    // Redis being unreachable is exactly the condition this panel exists to
    // show, so it is reported as data rather than as a 500.
    logger.warn({ err }, "redis_info_failed");
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
