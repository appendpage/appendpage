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
  const pool = new Pool({
    connectionString: url,
    // Conservative defaults; tune in Phase D under load.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (err) => {
    // Do not crash the server on idle-client errors; just log.
    console.error("[pg] idle client error:", err.message);
  });
  return pool;
}

export const pool: Pool =
  globalThis.__appendpage_pg_pool ??
  (globalThis.__appendpage_pg_pool = makePool());

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
