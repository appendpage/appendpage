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
import { isIP } from "node:net";

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

async function getLimit(key: string, fallback = Infinity): Promise<number> {
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
  return cache.map.get(key) ?? fallback;
}

/** Normalize an IP for rate-limiting: IPv4 /32, IPv6 /64. */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (isIP(ip) === 4) return ip + "/32";
  if (isIP(ip) !== 6) return "unknown";
  // Convert an embedded IPv4 suffix before expanding compressed IPv6 groups.
  if (ip.includes(".")) {
    const pos = ip.lastIndexOf(":");
    const bytes = ip.slice(pos + 1).split(".").map(Number);
    ip = ip.slice(0, pos + 1) + ((bytes[0]! << 8) | bytes[1]!).toString(16) + ":" +
      ((bytes[2]! << 8) | bytes[3]!).toString(16);
  }
  const [left, right] = ip.split("::");
  const a = left ? left.split(":") : [];
  const b = right ? right.split(":") : [];
  const groups = (right !== undefined ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a).map((s) => parseInt(s, 16));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 65535) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}/32`;
  }
  return groups.slice(0, 4).map((g) => g.toString(16)).join(":") + "::/64";
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
  fallback?: number,
): Promise<RateLimitDecision> {
  const limit = await getLimit(configKey, fallback);
  if (!isFinite(limit)) {
    return { ok: true, limit: Infinity, used: 0, resetAfterSeconds: 0, key: configKey };
  }
  const windowId = Math.floor(Date.now() / 1000 / windowSeconds);
  const rkey = `rl:${action}:${configKey}:${ipNormalized}:${windowId}`;
  // Increment and expiry must be atomic even if the process stops mid-request.
  const used = Number(await redis.eval(
    "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n",
    1, rkey, windowSeconds + 10,
  ));
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
  rules: Array<{ configKey: string; windowSeconds: number; fallback?: number }>,
): Promise<RateLimitDecision> {
  for (const rule of rules) {
    const r = await check(ipNormalized, action, rule.configKey, rule.windowSeconds, rule.fallback);
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
 * headers getter. The backend must be behind the trusted nginx proxy, which
 * overwrites X-Real-IP. The first X-Forwarded-For element is client-controlled.
 */
export function clientIpFromHeaders(
  headerGet: (name: string) => string | null,
): string {
  const xff = headerGet("x-forwarded-for");
  const xri = headerGet("x-real-ip");
  return normalizeIp(xri ?? xff?.split(",").at(-1)?.trim() ?? "0.0.0.0");
}
