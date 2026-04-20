/**
 * Materializer worker.
 *
 * LISTENs for `page_appended` notifications from Postgres and appends the new
 * canonical_bytes lines to /var/lib/appendpage/pages/<slug>.jsonl so that
 * nginx can `try_files` them as static content.
 *
 * On startup, rebuilds any missing or stale JSONL files from PG (the chain in
 * PG is the source of truth; the file is a cache).
 *
 * Crash safety: tracks per-page `head_seq_written` in memory plus persisted on
 * disk via the file's line count, so we never miss an entry if the process
 * dies and restarts. Always re-checks PG on a NOTIFY rather than trusting the
 * payload alone.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client, Notification } from "pg";

import { pool } from "./db";

const PAGES_DIR = process.env.PAGES_DIR ?? "/var/lib/appendpage/pages";

/** Bookkeeping: highest seq we've successfully written to each <slug>.jsonl. */
const written: Map<string, number> = new Map();

function pageFile(slug: string): string {
  return join(PAGES_DIR, `${slug}.jsonl`);
}

async function ensurePagesDir(): Promise<void> {
  if (!existsSync(PAGES_DIR)) {
    mkdirSync(PAGES_DIR, { recursive: true });
  }
}

/** Count the lines in a JSONL file (cheap; we only do this on cache miss). */
async function countLines(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const buf = await readFile(path);
  // Count newlines. A well-formed JSONL ends with \n.
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  return n;
}

/** Catch up file for one slug: append any rows in PG that aren't on disk yet. */
async function catchUpSlug(slug: string): Promise<void> {
  const file = pageFile(slug);
  const onDisk = written.get(slug) ?? (await countLines(file)) - 1; // -1 because we want "last written seq"
  const startSeq = onDisk + 1;
  const r = await pool.query<{ canonical_bytes: Buffer; seq: number }>(
    `SELECT canonical_bytes, seq FROM entries
       WHERE page_slug = $1 AND seq >= $2
       ORDER BY seq ASC`,
    [slug, startSeq],
  );
  if (r.rowCount === 0) return;
  // Append in one fs op for speed.
  const buf = Buffer.concat(
    r.rows.map((row) =>
      Buffer.concat([row.canonical_bytes, Buffer.from("\n", "utf8")]),
    ),
  );
  await appendFile(file, buf);
  written.set(slug, r.rows[r.rows.length - 1]!.seq);
}

/** Full rebuild for one slug — used when the file is missing or shorter than DB. */
async function rebuildSlug(slug: string): Promise<void> {
  const file = pageFile(slug);
  const r = await pool.query<{ canonical_bytes: Buffer; seq: number }>(
    `SELECT canonical_bytes, seq FROM entries
       WHERE page_slug = $1
       ORDER BY seq ASC`,
    [slug],
  );
  const buf = Buffer.concat(
    r.rows.map((row) =>
      Buffer.concat([row.canonical_bytes, Buffer.from("\n", "utf8")]),
    ),
  );
  await writeFile(file, buf);
  const last = r.rows.length > 0 ? r.rows[r.rows.length - 1] : undefined;
  written.set(slug, last ? last.seq : -1);
}

/**
 * Reconcile every page on startup. For each page in PG, either confirm the
 * file matches or rebuild it.
 */
async function startupReconcile(): Promise<void> {
  await ensurePagesDir();
  const r = await pool.query<{ slug: string; head_seq: number }>(
    "SELECT slug, head_seq FROM pages",
  );
  for (const row of r.rows) {
    const file = pageFile(row.slug);
    const lines = existsSync(file) ? await countLines(file) : 0;
    const expected = row.head_seq + 1; // head_seq starts at -1 for empty pages
    if (lines === expected) {
      written.set(row.slug, row.head_seq);
    } else {
      console.log(
        `[materializer] reconcile ${row.slug}: file=${lines} expected=${expected} → rebuild`,
      );
      await rebuildSlug(row.slug);
    }
  }
  console.log(`[materializer] startup reconcile complete (${r.rowCount} pages)`);
}

/**
 * Long-running worker. Holds one dedicated PG client for LISTEN, plus uses
 * the shared pool for queries.
 */
export async function runMaterializer(opts?: {
  onReady?: () => void;
}): Promise<void> {
  await startupReconcile();

  const client = (await pool.connect()) as unknown as Client;
  await client.query("LISTEN page_appended");

  client.on("notification", (msg: Notification) => {
    const slug = msg.payload;
    if (!slug) return;
    // Don't await inside the handler — fire and forget.
    void catchUpSlug(slug).catch((err) =>
      console.error(`[materializer] catch-up failed for ${slug}:`, err),
    );
  });

  client.on("error", (err) => {
    console.error("[materializer] LISTEN client error:", err);
    // Will be picked up by the supervising process; pm2/docker restart logic.
    process.exit(1);
  });

  console.log(`[materializer] LISTEN page_appended → ${PAGES_DIR}`);
  opts?.onReady?.();

  // Idle forever. The process is kept alive by the open LISTEN connection.
  // Periodic safety net: every 60s, fully reconcile (defends against missed NOTIFY).
  setInterval(() => {
    void startupReconcile().catch((err) =>
      console.error("[materializer] periodic reconcile failed:", err),
    );
  }, 60_000);
}

// If invoked as a script (e.g. `node materializer.js` in a dedicated container),
// run forever. If imported (e.g. into a Next.js custom server), the caller
// invokes runMaterializer() themselves.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMaterializer().catch((err) => {
    console.error("[materializer] fatal:", err);
    process.exit(1);
  });
}
