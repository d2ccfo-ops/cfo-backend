import { Redis } from "ioredis";
import { env } from "../config/env.js";

// Shared connection for every BullMQ Queue/Worker in the app — BullMQ
// requires maxRetriesPerRequest: null on connections it owns (its own retry/
// backoff logic conflicts with ioredis's default), and enableReadyCheck: false
// is BullMQ's own recommended setting for the same reason. Do not reuse this
// connection for arbitrary app-level caching; if that's ever needed, create a
// second plain ioredis client instead so a queue outage can't take caching
// down with it (and vice versa).
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
