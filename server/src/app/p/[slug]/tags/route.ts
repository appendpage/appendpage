/**
 * GET /p/:slug/tags
 *
 * Returns the tag-cloud view of a page:
 *   {
 *     entries_tags: { <entry_id>: [tag1, tag2, ...] },
 *     tag_counts:   { <tag>: count, ... },
 *     uncached_count: <number of entries we don't have tags for yet>,
 *     stale: <bool>   // true if uncached_count > 0
 *   }
 *
 * Cache discipline: entry tags never expire — bodies are immutable, so the
 * tags we extracted from them are too. On request:
 *
 *   ?stale_ok=1  (recommended): return whatever's already cached, kick off
 *                background extraction for the rest. The frontend shows
 *                "tagging N more entries…" while it works.
 *   (default):    extract any uncached entries inline (45s timeout).
 *
 * Backed by the entry_tags table created in migration 002_entry_tags.sql.
 */
import { NextResponse, type NextRequest } from "next/server";

import { pool } from "@/lib/db";
import { redis } from "@/lib/redis";
import { BudgetExceededError } from "@/lib/llm";
import { extractTagsBatch, TAG_PROMPT_VERSION } from "@/lib/tags";

export const dynamic = "force-dynamic";

const TAGS_MODEL =
  process.env.OPENAI_TAGS_MODEL ?? "gpt-5.4-nano-2026-03-17";

const MAX_BATCH_SIZE = 50;
const MAX_BODY_BYTES_PER_BATCH = 60_000;

interface CandidateRow {
  id: string;
  body: string | null;
  // tags from entry_tags (left join), null if uncached
  tags: string[] | null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const { searchParams } = new URL(req.url);
  const staleOk = searchParams.get("stale_ok") === "1";

  const pageRow = await pool.query<{ slug: string; head_seq: number }>(
    "SELECT slug, head_seq FROM pages WHERE slug = $1",
    [slug],
  );
  if (pageRow.rows.length === 0) {
    return NextResponse.json({ error: "page_not_found" }, { status: 404 });
  }
  if (pageRow.rows[0]!.head_seq < 0) {
    return NextResponse.json(
      {
        entries_tags: {},
        tag_counts: {},
        uncached_count: 0,
        stale: false,
      },
      { status: 200 },
    );
  }

  // 1. Fetch all entries on the page + their tags (left-join).
  //    Skip kind=moderation entries — moderation actions aren't user content
  //    and don't need tagging.
  const candidatesQ = await pool.query<CandidateRow>(
    `SELECT e.id, b.body, t.tags
       FROM entries e
       LEFT JOIN entry_bodies b ON b.entry_id = e.id
       LEFT JOIN entry_tags   t ON t.entry_id = e.id
      WHERE e.page_slug = $1 AND e.kind = 'entry'
      ORDER BY e.seq ASC`,
    [slug],
  );
  const all = candidatesQ.rows;

  const cachedTags = new Map<string, string[]>();
  const uncached: Array<{ id: string; body: string }> = [];
  for (const r of all) {
    if (r.tags && Array.isArray(r.tags)) {
      cachedTags.set(r.id, r.tags);
    } else if (r.body) {
      uncached.push({ id: r.id, body: r.body });
    }
  }

  // 2. If anything is uncached, either extract inline or kick off bg work.
  if (uncached.length > 0) {
    if (staleOk) {
      backgroundExtract(slug, uncached);
    } else {
      // Inline extraction (called from the manual "regenerate" path).
      try {
        const newTags = await extractWithCache(slug, uncached);
        for (const [id, tags] of newTags) cachedTags.set(id, tags);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          return NextResponse.json(
            {
              error: "budget_exceeded",
              message: `OpenAI daily budget cap reached ($${err.totalUsd.toFixed(2)} / $${err.capUsd.toFixed(2)}). Tagging resumes at 00:00 UTC.`,
            },
            { status: 503 },
          );
        }
        console.error(`[tags ${slug}] inline extract failed:`, err);
        // Fall through and serve whatever we've got cached.
      }
    }
  }

  // 3. Build the response: per-entry tags + page-wide counts.
  const entries_tags: Record<string, string[]> = {};
  const tag_counts: Record<string, number> = {};
  for (const [id, tags] of cachedTags) {
    entries_tags[id] = tags;
    for (const t of tags) {
      tag_counts[t] = (tag_counts[t] ?? 0) + 1;
    }
  }

  // Recompute uncached count after possible inline extraction.
  const uncachedAfter = all.filter(
    (r) => !cachedTags.has(r.id) && r.body !== null,
  ).length;

  return NextResponse.json(
    {
      entries_tags,
      tag_counts,
      uncached_count: uncachedAfter,
      stale: uncachedAfter > 0,
    },
    {
      headers: {
        "cache-control": "public, max-age=30, stale-while-revalidate=300",
      },
    },
  );
}

/**
 * Persist a batch of (entry_id -> tags) into entry_tags.
 * Uses ON CONFLICT DO NOTHING so duplicate background extracts are idempotent.
 */
async function persistTags(
  tags: Map<string, string[]>,
  costPerEntry: number,
): Promise<void> {
  if (tags.size === 0) return;
  // Bulk insert via VALUES — one round-trip.
  const values: unknown[] = [];
  const tuples: string[] = [];
  let i = 1;
  for (const [id, tagList] of tags) {
    tuples.push(
      `($${i}, $${i + 1}::jsonb, $${i + 2}, $${i + 3}, $${i + 4})`,
    );
    values.push(
      id,
      JSON.stringify(tagList),
      TAGS_MODEL,
      TAG_PROMPT_VERSION,
      costPerEntry.toFixed(6),
    );
    i += 5;
  }
  await pool.query(
    `INSERT INTO entry_tags (entry_id, tags, model, prompt_version, cost_usd)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (entry_id) DO NOTHING`,
    values,
  );
}

/** Extract + persist in one shot. Used for both inline and background paths. */
async function extractWithCache(
  slug: string,
  uncached: Array<{ id: string; body: string }>,
): Promise<Map<string, string[]>> {
  const merged = new Map<string, string[]>();
  // Process in batches to keep prompt size bounded.
  for (const batch of chunkByBytes(uncached, MAX_BATCH_SIZE, MAX_BODY_BYTES_PER_BATCH)) {
    const result = await extractTagsBatch(batch);
    const perEntry =
      batch.length > 0 ? result.costUsd / batch.length : 0;
    await persistTags(result.tags, perEntry);
    for (const [id, tags] of result.tags) merged.set(id, tags);
    console.log(
      `[tags ${slug}] extracted ${result.tags.size}/${batch.length} entries, $${result.costUsd.toFixed(4)}, ${result.generationSeconds.toFixed(1)}s`,
    );
  }
  return merged;
}

/**
 * Chunk an array of entries into batches whose total body bytes stay
 * under maxBytes (so a few very long entries don't wedge a 50-entry batch).
 */
function chunkByBytes<T extends { body: string }>(
  arr: T[],
  maxItems: number,
  maxBytes: number,
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let curBytes = 0;
  for (const item of arr) {
    const b = Buffer.byteLength(item.body, "utf8");
    if (
      cur.length > 0 &&
      (cur.length >= maxItems || curBytes + b > maxBytes)
    ) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(item);
    curBytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Fire-and-forget background extraction. Same Redis lock pattern as the
 * AI-view background regen.
 */
function backgroundExtract(
  slug: string,
  uncached: Array<{ id: string; body: string }>,
): void {
  void (async () => {
    const lockKey = `tags-extract:${slug}`;
    try {
      const got = await redis.set(lockKey, "1", "EX", 120, "NX");
      if (got !== "OK") return; // another worker is on it
      await extractWithCache(slug, uncached);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.warn(`[tags ${slug}] bg extract skipped: budget cap`);
      } else {
        console.error(`[tags ${slug}] bg extract failed:`, err);
      }
    } finally {
      // Release lock early so next request after we finish can pick up new entries.
      try {
        await redis.del(lockKey);
      } catch {
        /* ignore */
      }
    }
  })();
}
