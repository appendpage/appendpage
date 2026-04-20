/**
 * Apply pending SQL migrations from ../../migrations/*.sql.
 *
 * Tracks applied migrations in `schema_migrations` (created by 001_init.sql).
 * Idempotent: re-running skips already-applied versions.
 *
 * Usage:
 *   npm run migrate
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();

  // Bootstrap: 001_init.sql creates the schema_migrations table itself, so on
  // a brand-new DB there's no table to query yet. Detect that and treat as
  // "no migrations applied".
  let applied = new Set<string>();
  try {
    const r = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    applied = new Set(r.rows.map((row) => row.version));
  } catch (err: unknown) {
    if (err instanceof Error && /relation .* does not exist/.test(err.message)) {
      console.log("[migrate] no schema_migrations table yet; will be created by 001_init");
    } else {
      throw err;
    }
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let applied_now = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) {
      console.log(`[migrate] skip  ${version} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`[migrate] apply ${version}`);
    await client.query(sql);
    applied_now++;
  }

  await client.end();
  console.log(`[migrate] done (${applied_now} new migration${applied_now === 1 ? "" : "s"})`);
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
