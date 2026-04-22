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
  type PerEntryMetadata,
} from "@/lib/tags";

export const dynamic = "force-dynamic";

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

// Helpers (extractWithCache, backgroundExtract, persistMeta, chunkByBytes)
// live in lib/tags.ts so docview-v2 can share them.
