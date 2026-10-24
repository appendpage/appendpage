import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { appendInTransaction } from "./chain";
import { acquireSlugLock, pool, withTx } from "./db";
import { SLUG_REGEX, ULID_REGEX } from "./types";

/** Moderation records are appended atomically with visibility changes. */
export async function moderationRevision(slug: string): Promise<number> {
  const result = await pool.query<{ revision: number }>(
    `SELECT COALESCE(MAX(seq), -1) AS revision
       FROM entries WHERE page_slug = $1 AND kind = 'moderation'`,
    [slug],
  );
  return result.rows[0]!.revision;
}

/** A stale summary may be reused across new posts, never across moderation. */
export function moderationCacheKey(key: string, revision: number): string {
  return revision < 0 ? key : `${key}|moderation:${revision}`;
}

/** Discard an in-flight view if moderation changed while it was being built. */
export async function withModerationGuard(
  slug: string,
  render: (revision: number) => Promise<Response>,
): Promise<Response> {
  const revision = await moderationRevision(slug);
  const response = await render(revision);
  if ((await moderationRevision(slug)) !== revision) {
    return new NextResponse(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }
  // Database caches still provide fast reads. HTTP caches cannot be reliably
  // invalidated when a body is withheld, so do not cache derived views there.
  response.headers.set("cache-control", "no-store");
  return response;
}

/**
 * Trusted server-side operation, deliberately not exposed as a public route.
 * Withhold bodies without overwriting their original text or salts. The
 * legacy erased_at field means "not publicly served", not physical deletion.
 */
export async function withholdEntries(args: {
  slug: string;
  entryIds: string[];
  reason: string;
  actor: string;
}): Promise<Array<{ targetId: string; moderationId: string; seq: number }>> {
  return withTx((client) => withholdInTransaction(client, args));
}

/** Shares the transaction with a private report decision. Never a public API. */
export async function withholdInTransaction(client: PoolClient, args: {
  slug: string;
  entryIds: string[];
  reason: string;
  actor: string;
}): Promise<Array<{ targetId: string; moderationId: string; seq: number }>> {
  if (!SLUG_REGEX.test(args.slug) || args.entryIds.length === 0 ||
      new Set(args.entryIds).size !== args.entryIds.length ||
      args.entryIds.some((id) => !ULID_REGEX.test(id)) ||
      !args.reason.trim() || !args.actor.trim()) {
    throw new Error("Invalid moderation request");
  }

  await acquireSlugLock(client, args.slug);
  const targets = await client.query<{
    id: string; seq: number; kind: string; erased_at: Date | null;
  }>(
    `SELECT e.id, e.seq, e.kind, b.erased_at
       FROM entries e JOIN entry_bodies b ON b.entry_id = e.id
      WHERE e.page_slug = $1 AND e.id = ANY($2::text[])
      ORDER BY e.seq FOR UPDATE OF b`,
    [args.slug, args.entryIds],
  );
  if (targets.rows.length !== args.entryIds.length ||
      targets.rows.some((row) => row.kind !== "entry")) {
    throw new Error("Every target must be an existing post on this page");
  }
  // Refuse accidental retries rather than appending duplicate decisions.
  if (targets.rows.some((row) => row.erased_at !== null)) {
    throw new Error("A target is already withheld; no changes made");
  }

  const actions = [];
  for (const target of targets.rows) {
    const { entry } = await appendInTransaction(client, {
      slug: args.slug,
      kind: "moderation",
      parentId: target.id,
      body: `Post #${target.seq}: ${args.reason}`,
      ipHash: "operator",
      ipSaltId: 0,
      captchaId: "operator",
      userAgentHash: "operator",
    });
    await client.query(
      `UPDATE entry_bodies SET erased_at = now(), erased_reason = $2
        WHERE entry_id = $1`,
      [target.id, args.reason],
    );
    await client.query(
      `INSERT INTO moderation_log (entry_id, action, reason, actor)
       VALUES ($1, 'erase', $2, $3)`,
      [target.id, args.reason, args.actor],
    );
    actions.push({ targetId: target.id, moderationId: entry.id, seq: entry.seq });
  }

  // Drop all derived page/section caches. In-flight generations retain the
  // old revision key and cannot be served after this transaction commits.
  await client.query("DELETE FROM view_cache WHERE page_slug = $1", [args.slug]);
  await client.query("DELETE FROM view_section_cache WHERE page_slug = $1", [args.slug]);
  await client.query("DELETE FROM subject_dedup_cache WHERE page_slug = $1", [args.slug]);
  // Replies can inherit a parent's metadata. Invalidate that whole subtree.
  await client.query(
    `WITH RECURSIVE affected AS (
       SELECT id FROM entries WHERE id = ANY($1::text[])
       UNION
       SELECT e.id FROM entries e JOIN affected a ON e.parent_id = a.id
     ) DELETE FROM entry_tags WHERE entry_id IN (SELECT id FROM affected)`,
    [args.entryIds],
  );
  return actions;
}
