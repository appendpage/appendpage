/**
 * Redis-based fixed-window rate limiter with DB-configurable thresholds.
 *
 * Thresholds live in the `rate_limit_config` table (one row per key). The
 * app refreshes its in-memory copy every REFRESH_MS; operators can bump
 * any limit at runtime via `UPDATE rate_limit_config SET value = N WHERE
 * key = 'entries_per_minute'` and it takes effect within 30s. No restart
 * needed.
 *
 * The window itself is a fixed clock window: for a 60s limit, all requests
 * inside the same minute-since-epoch share one counter. Simple, cheap,
 * slightly lumpier than a token bucket — fine for launch-day sanity caps.
 *
 * Per-IP normalization is truncated to /32 for IPv4 and /64 for IPv6 so
 * a NAT behind one IPv4 or an attacker inside a single /64 block can't
 * multiplex past the limit. Pass the raw header; we normalize here.
 */
import { pool } from "./db";
import { redis } from "./redis";

const REFRESH_MS = 30_000;

interface Config {
  map: Map<string, number>;
  loadedAt: number;
}

let cache: Config = { map: new Map(), loadedAt: 0 };
let inFlightLoad: Promise<void> | null = null;

async function loadConfig(): Promise<void> {
  try {
    const rows = await pool.query<{ key: string; value: number }>(
      "SELECT key, value FROM rate_limit_config",
    );
    const m = new Map<string, number>();
    for (const r of rows.rows) m.set(r.key, r.value);
    cache = { map: m, loadedAt: Date.now() };
  } catch (err) {
    // If the DB is flaky, keep the old cache rather than failing every
    // write. Log once per refresh cycle at most.
    console.error("[rate-limit] config reload failed:", err);
    cache.loadedAt = Date.now(); // back off; try again in REFRESH_MS
  }
}

async function getLimit(key: string): Promise<number> {
  const stale = Date.now() - cache.loadedAt > REFRESH_MS;
  if (stale) {
    if (!inFlightLoad) {
      inFlightLoad = loadConfig().finally(() => {
        inFlightLoad = null;
      });
    }
    // First-load case: block just the first-ever call to get a sane limit.
    if (cache.map.size === 0) {
      await inFlightLoad;
    }
  }
  return cache.map.get(key) ?? Infinity; // unknown key = unlimited
}

/** Normalize an IP for rate-limiting: IPv4 /32, IPv6 /64. */
export function normalizeIp(raw: string): string {
  const ip = raw.trim();
  if (ip.includes(":")) {
    // IPv6 — keep only the first 4 groups (the /64 prefix).
    const parts = ip.split(":").filter((p) => p.length > 0);
    return parts.slice(0, 4).join(":") + "::/64";
  }
  return ip + "/32";
}

export interface RateLimitDecision {
  ok: boolean;
  /** The configured limit that was checked. */
  limit: number;
  /** Requests used in this window (post-increment). */
  used: number;
  /** Seconds until the window resets. */
  resetAfterSeconds: number;
  /** The limit key that fired (for logging + Retry-After hints). */
  key: string;
}

/**
 * Check one rate-limit rule. `action` distinguishes counters (e.g. "entries"
 * vs "pages"), `configKey` names the DB row that holds the threshold, and
 * `windowSeconds` is the counter window length.
 *
 * Example:
 *   const r = await check(ip, "entries", "entries_per_minute", 60);
 *   if (!r.ok) return 429 with Retry-After: r.resetAfterSeconds
 */
export async function check(
  ipNormalized: string,
  action: string,
  configKey: string,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  const limit = await getLimit(configKey);
  if (!isFinite(limit)) {
    return { ok: true, limit: Infinity, used: 0, resetAfterSeconds: 0, key: configKey };
  }
  const windowId = Math.floor(Date.now() / 1000 / windowSeconds);
  const rkey = `rl:${action}:${configKey}:${ipNormalized}:${windowId}`;
  const used = await redis.incr(rkey);
  // Set TTL on the FIRST increment of a window so the key self-cleans.
  if (used === 1) {
    await redis.expire(rkey, windowSeconds + 10);
  }
  const ok = used <= limit;
  const resetAfterSeconds = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
  return { ok, limit, used, resetAfterSeconds, key: configKey };
}

/**
 * Apply several rate-limit rules in sequence; return the FIRST failing one,
 * or a combined ok decision if all pass.
 */
export async function checkAll(
  ipNormalized: string,
  action: string,
  rules: Array<{ configKey: string; windowSeconds: number }>,
): Promise<RateLimitDecision> {
  for (const rule of rules) {
    const r = await check(ipNormalized, action, rule.configKey, rule.windowSeconds);
    if (!r.ok) return r;
  }
  // Return a synthetic-ok decision keyed to the last rule (the tightest one).
  const last = rules[rules.length - 1]!;
  return {
    ok: true,
    limit: 0,
    used: 0,
    resetAfterSeconds: 0,
    key: last.configKey,
  };
}

/**
 * Convenience: extract + normalize the client IP from a NextRequest-style
 * headers getter. Trusts x-forwarded-for because nginx sets it.
 */
export function clientIpFromHeaders(
  headerGet: (name: string) => string | null,
): string {
  const xff = headerGet("x-forwarded-for");
  const xri = headerGet("x-real-ip");
  const first = xff?.split(",")[0]?.trim() ?? xri ?? "0.0.0.0";
  return normalizeIp(first);
}
