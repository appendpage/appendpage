/**
 * OpenAI daily budget guard.
 *
 * Keeps a USD counter per UTC day in Redis (key `budget:YYYY-MM-DD`).
 * Calls increment the counter atomically. If a call would push the total
 * over OPENAI_DAILY_BUDGET_USD, we refuse the call and return budgetExceeded.
 */
import { redis } from "./redis";

const DAILY_CAP_USD = Number(
  process.env.OPENAI_DAILY_BUDGET_USD ?? "50",
);
const KEY_TTL_SECONDS = 60 * 60 * 36; // hold each day's counter for 36 h

function todayKey(): string {
  return `budget:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Try to reserve `estimateUsd` against today's budget. Returns
 * { ok: true, remainingUsd } if reserved or { ok: false, totalUsd, capUsd }
 * if it would exceed the cap.
 *
 * NOTE: this uses INCRBYFLOAT then DECRBYFLOAT-on-rollback semantics. If a
 * call ultimately costs more than the estimate, call commitOverage() to
 * top up. If it crashes mid-call, the over-reservation will simply roll
 * off when today's counter expires.
 */
export async function reserveBudget(
  estimateUsd: number,
): Promise<
  | { ok: true; reservedUsd: number; totalUsd: number; capUsd: number }
  | { ok: false; totalUsd: number; capUsd: number }
> {
  const key = todayKey();
  // Atomically increment-and-fetch.
  const total = parseFloat(
    await redis.incrbyfloat(key, estimateUsd.toFixed(6)),
  );
  await redis.expire(key, KEY_TTL_SECONDS);
  if (total > DAILY_CAP_USD) {
    // Roll back the reservation.
    await redis.incrbyfloat(key, (-estimateUsd).toFixed(6));
    return { ok: false, totalUsd: total - estimateUsd, capUsd: DAILY_CAP_USD };
  }
  return {
    ok: true,
    reservedUsd: estimateUsd,
    totalUsd: total,
    capUsd: DAILY_CAP_USD,
  };
}

/** After a call succeeds, top up if the actual cost exceeded the reservation. */
export async function commitOverage(deltaUsd: number): Promise<void> {
  if (deltaUsd <= 0) return;
  const key = todayKey();
  await redis.incrbyfloat(key, deltaUsd.toFixed(6));
  await redis.expire(key, KEY_TTL_SECONDS);
}

/** Read today's spend and the cap (no mutation). */
export async function readBudget(): Promise<{
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
}> {
  const key = todayKey();
  const v = await redis.get(key);
  const spent = v ? parseFloat(v) : 0;
  return {
    spentUsd: spent,
    capUsd: DAILY_CAP_USD,
    remainingUsd: Math.max(0, DAILY_CAP_USD - spent),
  };
}
