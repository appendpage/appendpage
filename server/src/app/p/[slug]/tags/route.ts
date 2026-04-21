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
import {
  extractTagsBatch,
  TAG_PROMPT_VERSION,
  type PerEntryMetadata,
} from "@/lib/tags";

export const dynamic = "force-dynamic";

const TAGS_MODEL =
  process.env.OPENAI_TAGS_MODEL ?? "gpt-5.4-nano-2026-03-17";

const MAX_BATCH_SIZE = 50;
const MAX_BODY_BYTES_PER_BATCH = 60_000;

interface CandidateRow {
  id: string;
  body: string | null;
  subject: string | null;
  tags: string[] | null;
  relevant: boolean | null; // null if uncached (left join)
  relevance_reason: string | null;
}

interface PageRow {
  slug: string;
  head_seq: number;
  description: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const { searchParams } = new URL(req.url);
  const staleOk = searchParams.get("stale_ok") === "1";

  const pageRow = await pool.query<PageRow>(
    "SELECT slug, head_seq, description FROM pages WHERE slug = $1",
    [slug],
  );
  if (pageRow.rows.length === 0) {
    return NextResponse.json({ error: "page_not_found" }, { status: 404 });
  }
  const page = pageRow.rows[0]!;
  if (page.head_seq < 0) {
    return NextResponse.json(emptyResponse(), { status: 200 });
  }

  const candidatesQ = await pool.query<CandidateRow>(
    `SELECT e.id, b.body,
            t.subject, t.tags, t.relevant, t.relevance_reason
       FROM entries e
       LEFT JOIN entry_bodies b ON b.entry_id = e.id
       LEFT JOIN entry_tags   t ON t.entry_id = e.id
      WHERE e.page_slug = $1 AND e.kind = 'entry'
      ORDER BY e.seq ASC`,
    [slug],
  );
  const all = candidatesQ.rows;

  const cachedMeta = new Map<string, PerEntryMetadata>();
  const uncached: Array<{ id: string; body: string }> = [];
  for (const r of all) {
    if (r.relevant !== null) {
      // Has a row in entry_tags
      cachedMeta.set(r.id, {
        subject: r.subject,
        tags: Array.isArray(r.tags) ? r.tags : [],
        relevant: r.relevant,
        relevance_reason: r.relevance_reason,
      });
    } else if (r.body) {
      uncached.push({ id: r.id, body: r.body });
    }
  }

  if (uncached.length > 0) {
    if (staleOk) {
      backgroundExtract(slug, page.description, uncached);
    } else {
      try {
        const newMeta = await extractWithCache(slug, page.description, uncached);
        for (const [id, m] of newMeta) cachedMeta.set(id, m);
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
      }
    }
  }

  // Build the response: per-entry metadata + page-wide rollups.
  const entries_meta: Record<string, PerEntryMetadata> = {};
  const tag_counts: Record<string, number> = {};
  const subject_counts: Record<string, number> = {};
  let irrelevant_count = 0;
  for (const [id, m] of cachedMeta) {
    entries_meta[id] = m;
    if (m.relevant) {
      if (m.subject) {
        subject_counts[m.subject] = (subject_counts[m.subject] ?? 0) + 1;
      }
      for (const t of m.tags) {
        tag_counts[t] = (tag_counts[t] ?? 0) + 1;
      }
    } else {
      irrelevant_count++;
    }
  }

  const uncachedAfter = all.filter(
    (r) => !cachedMeta.has(r.id) && r.body !== null,
  ).length;

  return NextResponse.json(
    {
      entries_meta,
      subject_counts,
      tag_counts,
      irrelevant_count,
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

function emptyResponse() {
  return {
    entries_meta: {} as Record<string, never>,
    subject_counts: {} as Record<string, number>,
    tag_counts: {} as Record<string, number>,
    irrelevant_count: 0,
    uncached_count: 0,
    stale: false,
  };
}

/** Persist a batch of (entry_id -> meta) rows into entry_tags. Idempotent. */
async function persistMeta(
  meta: Map<string, PerEntryMetadata>,
  costPerEntry: number,
): Promise<void> {
  if (meta.size === 0) return;
  const values: unknown[] = [];
  const tuples: string[] = [];
  let i = 1;
  for (const [id, m] of meta) {
    tuples.push(
      `($${i}, $${i + 1}, $${i + 2}::jsonb, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7})`,
    );
    values.push(
      id,
      m.subject,
      JSON.stringify(m.tags),
      m.relevant,
      m.relevance_reason,
      TAGS_MODEL,
      TAG_PROMPT_VERSION,
      costPerEntry.toFixed(6),
    );
    i += 8;
  }
  await pool.query(
    `INSERT INTO entry_tags
       (entry_id, subject, tags, relevant, relevance_reason,
        model, prompt_version, cost_usd)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (entry_id) DO NOTHING`,
    values,
  );
}

/** Extract + persist in one shot. Used for both inline and background paths. */
async function extractWithCache(
  slug: string,
  description: string,
  uncached: Array<{ id: string; body: string }>,
): Promise<Map<string, PerEntryMetadata>> {
  const merged = new Map<string, PerEntryMetadata>();
  for (const batch of chunkByBytes(
    uncached,
    MAX_BATCH_SIZE,
    MAX_BODY_BYTES_PER_BATCH,
  )) {
    const result = await extractTagsBatch(batch, { slug, description });
    const perEntry =
      batch.length > 0 ? result.costUsd / batch.length : 0;
    await persistMeta(result.meta, perEntry);
    for (const [id, m] of result.meta) merged.set(id, m);
    console.log(
      `[tags ${slug}] extracted ${result.meta.size}/${batch.length} entries, $${result.costUsd.toFixed(4)}, ${result.generationSeconds.toFixed(1)}s`,
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
  description: string,
  uncached: Array<{ id: string; body: string }>,
): void {
  void (async () => {
    const lockKey = `tags-extract:${slug}`;
    try {
      const got = await redis.set(lockKey, "1", "EX", 120, "NX");
      if (got !== "OK") return; // another worker is on it
      await extractWithCache(slug, description, uncached);
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
