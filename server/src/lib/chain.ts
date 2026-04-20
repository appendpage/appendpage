/**
 * The append transaction — the heart of the system.
 *
 * For every new entry on a page, we run ONE Postgres transaction that:
 *   1. Acquires `pg_advisory_xact_lock(hashtext(slug))` — strict per-slug
 *      serialization. No two appends to the same page can interleave; no fork
 *      is possible.
 *   2. Reads `pages.head_hash`, `pages.head_seq`, `pages.created_at` (with FOR UPDATE).
 *   3. Generates a 32-byte salt.
 *   4. Computes `body_commitment = H(salt ‖ body)`.
 *   5. Builds the public 9-field entry; canonicalizes via JCS; hashes it.
 *   6. INSERTs into `entries`, `entry_bodies`, and `entry_provenance`.
 *   7. UPDATEs `pages` (head_hash, head_seq).
 *   8. NOTIFY page_appended <slug>.
 *   9. COMMIT.
 *
 * On crash before COMMIT, everything rolls back.
 *
 * The `parent_id` (if any) is validated against the same page and against
 * seq < new_seq (no forward references).
 */
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type { PoolClient } from "pg";

import {
  acquireSlugLock,
  pool,
  withTx,
} from "./db";
import {
  bodyCommitment,
  entryHash,
  genesisSeed,
  jcsBytes,
} from "./jcs";
import {
  buildChainEntry,
  ChainError,
  type ChainEntry,
  type Kind,
} from "./types";

export interface AppendArgs {
  slug: string;
  body: string;
  /** Optional reply target. Must be on the same page. */
  parentId?: string;
  /**
   * Always "entry" for posters. The admin queue passes "moderation" via a
   * separate code path that goes through this same function.
   */
  kind: Kind;
  /** For optimistic concurrency. Server returns 409 if it doesn't match the head. */
  expectedPrevHash?: string;
  /** Provenance — collected by the route handler from the request. */
  ipHash: string;
  ipSaltId: number;
  captchaId: string;
  userAgentHash: string;
}

export interface AppendResult {
  entry: ChainEntry;
}

/**
 * Append one entry to the chain for `slug`. Returns the canonical on-chain
 * entry that was just committed (with `hash` filled in).
 */
export async function appendEntry(args: AppendArgs): Promise<AppendResult> {
  if (Buffer.byteLength(args.body, "utf8") > 4096) {
    throw new ChainError(
      "body_too_long",
      "body exceeds 4096 bytes (UTF-8)",
      { byte_length: Buffer.byteLength(args.body, "utf8") },
    );
  }

  return withTx(async (client) => {
    await acquireSlugLock(client, args.slug);

    // Read page state under the lock.
    const pageRow = await client.query<{
      slug: string;
      created_at: Date;
      head_hash: string;
      head_seq: number;
      status: string;
    }>(
      `SELECT slug, created_at, head_hash, head_seq, status
         FROM pages WHERE slug = $1 FOR UPDATE`,
      [args.slug],
    );
    if (pageRow.rowCount === 0) {
      throw new ChainError("page_not_found", `page ${args.slug} does not exist`);
    }
    const page = pageRow.rows[0]!;
    if (page.status !== "live") {
      throw new ChainError(
        "page_queued_review",
        `page ${args.slug} is in ${page.status}; not accepting entries yet`,
      );
    }

    // Compute the prev_hash. For seq == -1 (no entries yet), use genesis seed.
    const prevHash =
      page.head_seq < 0
        ? genesisSeed(args.slug, page.created_at.toISOString())
        : page.head_hash;

    if (args.expectedPrevHash && args.expectedPrevHash !== prevHash) {
      throw new ChainError(
        "head_mismatch",
        "Expect-Prev-Hash did not match the current head",
        { actual_head_hash: prevHash },
      );
    }

    // Validate parent (if supplied).
    if (args.parentId !== undefined) {
      const parent = await client.query<{ page_slug: string; seq: number }>(
        "SELECT page_slug, seq FROM entries WHERE id = $1",
        [args.parentId],
      );
      if (parent.rowCount === 0) {
        throw new ChainError("parent_not_found", `parent ${args.parentId} not found`);
      }
      const p = parent.rows[0]!;
      if (p.page_slug !== args.slug) {
        throw new ChainError(
          "parent_wrong_page",
          `parent ${args.parentId} is on page ${p.page_slug}, not ${args.slug}`,
        );
      }
      // No forward references — parent.seq < new entry's seq is guaranteed by
      // the fact that parent already exists and we hold the slug lock.
    }

    const newSeq = page.head_seq + 1;
    const id = ulid();
    const salt = randomBytes(32);
    const commitment = bodyCommitment(salt, args.body);
    const createdAt = new Date();
    const createdAtIso = createdAt.toISOString();

    const stripped = buildChainEntry({
      id,
      page: args.slug,
      seq: newSeq,
      kind: args.kind,
      parent: args.parentId ?? null,
      bodyCommitment: commitment,
      createdAtIso,
      prevHash,
    });
    const { hash } = entryHash(stripped);
    // Store the JCS canonicalization of the FULL entry (with `hash`).
    // This is what /raw emits verbatim and what tools/verify.py reads.
    // Verifiers strip `hash`, re-canonicalize, re-hash, and compare to the
    // recorded `hash` field — see verify.py.
    const fullEntry: ChainEntry = { ...stripped, hash };
    const canonicalBytes = jcsBytes(fullEntry);

    await client.query(
      `INSERT INTO entries
         (id, page_slug, seq, kind, parent_id, body_commitment, created_at,
          prev_hash, hash, canonical_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        args.slug,
        newSeq,
        args.kind,
        args.parentId ?? null,
        commitment,
        createdAt,
        prevHash,
        hash,
        canonicalBytes,
      ],
    );
    await client.query(
      `INSERT INTO entry_bodies (entry_id, body, salt) VALUES ($1, $2, $3)`,
      [id, args.body, salt],
    );
    await client.query(
      `INSERT INTO entry_provenance
         (entry_id, ip_hash, ip_salt_id, captcha_id, user_agent_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, args.ipHash, args.ipSaltId, args.captchaId, args.userAgentHash],
    );
    await client.query(
      `UPDATE pages SET head_hash = $1, head_seq = $2 WHERE slug = $3`,
      [hash, newSeq, args.slug],
    );

    // pg_notify for the materializer worker. Payload is just the slug;
    // workers query for entries newer than the last seq they wrote.
    await client.query(`SELECT pg_notify('page_appended', $1)`, [args.slug]);

    const entry: ChainEntry = { ...stripped, hash };
    return { entry };
  });
}

/**
 * Stream the canonical chain for a page as JSONL. Used by GET /p/<slug>/raw.
 * The materializer also keeps a file at /var/lib/appendpage/pages/<slug>.jsonl
 * for nginx try_files; this is the fallback / source of truth.
 */
export async function* streamChain(slug: string): AsyncIterable<string> {
  const client = await pool.connect();
  try {
    // Server-side cursor for arbitrarily-large pages.
    await client.query("BEGIN");
    await client.query(
      `DECLARE chain_cur CURSOR FOR
         SELECT canonical_bytes FROM entries
         WHERE page_slug = $1
         ORDER BY seq ASC`,
      [slug],
    );
    while (true) {
      const batch = await client.query<{ canonical_bytes: Buffer }>(
        "FETCH 100 FROM chain_cur",
      );
      if (batch.rowCount === 0) break;
      for (const row of batch.rows) {
        // canonical_bytes is the JCS-canonicalized FULL entry (with hash);
        // emit verbatim, one line per entry.
        yield row.canonical_bytes.toString("utf8") + "\n";
      }
    }
    await client.query("CLOSE chain_cur");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Helper used by the page-create route. */
export async function createPage(args: {
  slug: string;
  description: string;
  defaultViewPrompt: string | null;
  status?: "live" | "queued_review";
}): Promise<void> {
  // Genesis: head_seq = -1; head_hash is the genesis seed for this page.
  // We compute the seed lazily on the first append (so we don't have to repeat
  // the formula here); the head_hash column starts with the seed too, just
  // for symmetry / audit.
  const createdAt = new Date();
  const seed = genesisSeed(args.slug, createdAt.toISOString());
  await pool.query(
    `INSERT INTO pages (slug, created_at, head_hash, head_seq, description,
                        default_view_prompt, status)
     VALUES ($1, $2, $3, -1, $4, $5, $6)`,
    [
      args.slug,
      createdAt,
      seed,
      args.description,
      args.defaultViewPrompt,
      args.status ?? "live",
    ],
  );
}

/**
 * Convenience for callers (e.g. the admin queue) that already hold a client
 * inside a larger transaction.
 */
export async function appendInTransaction(
  client: PoolClient,
  args: AppendArgs,
): Promise<AppendResult> {
  // Reuses the logic above, but caller is responsible for BEGIN/COMMIT.
  // Phase B will use this when the moderation flow needs to do
  // DELETE FROM entry_bodies + append a kind=moderation entry atomically.
  // Walking-skeleton callers should use appendEntry() instead.
  void client;
  void args;
  throw new Error("appendInTransaction: not implemented in Phase A");
}
