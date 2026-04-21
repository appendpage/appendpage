/**
 * Redis client (lazy, like the PG pool). Used for:
 *   - Per-day OpenAI budget counters
 *   - (Phase B) Token-bucket rate limits + 7-day rolling salt history
 */
import Redis from "ioredis";

declare global {
  // eslint-disable-next-line no-var
  var __appendpage_redis: Redis | undefined;
}

function makeRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  const r = new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(1000 * times, 5000),
  });
  r.on("error", (err) => {
    console.error("[redis] error:", err.message);
  });
  return r;
}

function getRedis(): Redis {
  if (!globalThis.__appendpage_redis) {
    globalThis.__appendpage_redis = makeRedis();
  }
  return globalThis.__appendpage_redis;
}

export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    const real = getRedis();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
