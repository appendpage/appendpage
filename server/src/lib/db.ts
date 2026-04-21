/**
 * Postgres pool. One module-level singleton; reuse it from every route.
 *
 * In dev (Next.js HMR) we stash the pool on globalThis so hot reloads don't
 * leak connections. In prod (`output: 'standalone'`) the module is loaded once
 * per worker.
 */
import { Pool, type PoolClient } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __appendpage_pg_pool: Pool | undefined;
}

function makePool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const p = new Pool({
    connectionString: url,
    // Conservative defaults; tune in Phase D under load.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  p.on("error", (err) => {
    // Do not crash the server on idle-client errors; just log.
    console.error("[pg] idle client error:", err.message);
  });
  return p;
}

/**
 * Lazy pool getter — Pool is constructed on first call, not at module load.
 * This matters during `next build` (page-data collection) where the build
 * process imports route modules but doesn't have DATABASE_URL set.
 *
 * The `pool` named export is a Proxy that defers to the underlying singleton
 * on every property access, preserving the existing call sites that do
 * `pool.connect()`, `pool.query(...)`, etc.
 */
function getPool(): Pool {
  if (!globalThis.__appendpage_pg_pool) {
    globalThis.__appendpage_pg_pool = makePool();
  }
  return globalThis.__appendpage_pg_pool;
}

export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const real = getPool();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/**
 * Run `fn` inside a single transaction with a single dedicated client.
 * Rolls back on throw. Useful for the chain append (advisory lock + several
 * inserts must be atomic).
 */
export async function withTx<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Hash a slug to a stable 32-bit integer for `pg_advisory_xact_lock`.
 * We use Postgres's own `hashtext()` function rather than computing client-side
 * to ensure callers in different languages compute the same key.
 */
export async function acquireSlugLock(
  client: PoolClient,
  slug: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [slug]);
}
