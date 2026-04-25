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
import { BudgetExceededError } from "@/lib/llm";
import {
  backgroundExtract,
  extractWithCache,
  TAG_PROMPT_VERSION,
  type PerEntryMetadata,
} from "@/lib/tags";

export const dynamic = "force-dynamic";

interface CandidateRow {
  id: string;
  seq: number;
  body: string | null;
  parent_id: string | null;
  parent_body: string | null;
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

  // Fetch each candidate's body, parent body (if it's a reply), and any
  // existing entry_tags row. The parent_body LEFT JOIN respects
  // erased_at so an erased parent contributes null instead of stale
  // bodies. The entry_tags JOIN is filtered to current TAG_PROMPT_VERSION
  // — rows from older prompt versions are treated as missing so a
  // bump (e.g. v2 -> v3 reply-aware) re-extracts naturally.
  const candidatesQ = await pool.query<CandidateRow>(
    `SELECT e.id, e.seq, b.body,
            e.parent_id, pb.body AS parent_body,
            t.subject, t.tags, t.relevant, t.relevance_reason
       FROM entries e
       LEFT JOIN entry_bodies b  ON b.entry_id  = e.id
       LEFT JOIN entry_bodies pb ON pb.entry_id = e.parent_id
                                    AND pb.erased_at IS NULL
       LEFT JOIN entry_tags   t  ON t.entry_id  = e.id
                                    AND t.prompt_version = $2
      WHERE e.page_slug = $1 AND e.kind = 'entry'
      ORDER BY e.seq ASC`,
    [slug, TAG_PROMPT_VERSION],
  );
  const all = candidatesQ.rows;

  const cachedMeta = new Map<string, PerEntryMetadata>();
  const uncached: Array<{
    id: string;
    seq: number;
    body: string;
    parent_id: string | null;
    parent_body: string | null;
  }> = [];
  for (const r of all) {
    if (r.relevant !== null) {
      // Has a current-version row in entry_tags.
      cachedMeta.set(r.id, {
        subject: r.subject,
        tags: Array.isArray(r.tags) ? r.tags : [],
        relevant: r.relevant,
        relevance_reason: r.relevance_reason,
      });
    } else if (r.body) {
      uncached.push({
        id: r.id,
        seq: r.seq,
        body: r.body,
        parent_id: r.parent_id,
        parent_body: r.parent_body,
      });
    }
  }

  if (uncached.length > 0) {
    if (staleOk) {
      backgroundExtract(slug, page.description, uncached, cachedMeta);
    } else {
      try {
        const newMeta = await extractWithCache(
          slug,
          page.description,
          uncached,
          cachedMeta,
        );
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

// Helpers (extractWithCache, backgroundExtract, persistMeta, chunkByBytes)
// live in lib/tags.ts so docview-v2 can share them.
