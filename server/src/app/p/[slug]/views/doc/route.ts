/**
 * GET /p/:slug/views/doc
 *
 * Returns a synthesized "Doc View" for the page — a citation-linked
 * document organized into sections. Same caching shape as
 * /p/:slug/views/default but with a different prompt (and therefore a
 * different view_prompt_hash, so the rows live side-by-side in the
 * `view_cache` table without conflict).
 *
 * Query flags (mirror of /views/default for caller consistency):
 *   ?stale_ok=1   — serve the most recent cached doc for this (slug,
 *                   prompt) even if head_hash has moved on; kick off a
 *                   background regen so the next visitor gets the fresh
 *                   one. Sets `stale: true` and `entries_since_cache`.
 *   ?cache_only=1 — never call the LLM; 204 if no exact-head row exists.
 *   ?nocache=1    — always call the LLM inline and overwrite cache.
 *   (default)     — cache hit returns immediately; cache miss calls the
 *                   LLM inline (60s timeout).
 *
 * Responses:
 *   200  { view, head_hash, cached, stale?, cache_head_hash?,
 *          entries_since_cache?, cost_usd, model?, generated_at,
 *          entry_seq_to_id }
 *   204  empty page, OR no cached doc AND (cache_only|stale_ok with no cache)
 *   503  budget exceeded
 *
 * `entry_seq_to_id` is a small map { "5": "01K...", "12": "01K..." }
 * that the frontend uses to turn citation [#N] markers into deep links
 * to the matching entry's permalink anchor (#e-<id>).
 */
import { NextResponse, type NextRequest } from "next/server";

import { pool } from "@/lib/db";
import {
  buildDocView,
  type DocView,
  docPromptFor,
  docPromptHash,
} from "@/lib/docview";
import { BudgetExceededError } from "@/lib/llm";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

interface PageRow {
  slug: string;
  description: string;
  head_hash: string;
  head_seq: number;
  status: string;
}

interface CacheRow {
  view_json: DocView;
  created_at: Date;
  cost_usd: string;
  head_hash: string;
}

interface EntryRow {
  id: string;
  seq: number;
  kind: string;
  parent_seq: number | null;
  body: string | null;
}

/** Background regeneration with a Redis SETNX lock so that 50 visitors
 *  hitting the same stale page only fire ONE LLM call between them. The
 *  lock auto-expires after 90s (longer than the LLM timeout) in case a
 *  generation crashes mid-flight. */
function backgroundRegenerate(
  slug: string,
  description: string,
  pHash: string,
  prompt: string,
  targetHeadHash: string,
): void {
  void (async () => {
    const lockKey = `docview-regen:${slug}:${pHash}:${targetHeadHash}`;
    try {
      const got = await redis.set(lockKey, "1", "EX", 90, "NX");
      if (got !== "OK") return;

      const pageRows = await pool.query<{ head_hash: string }>(
        "SELECT head_hash FROM pages WHERE slug = $1",
        [slug],
      );
      if (pageRows.rows.length === 0) return;
      const currentHead = pageRows.rows[0]!.head_hash;

      // Bail if a fresh row beat us to it.
      const exists = await pool.query<{ slug: string }>(
        `SELECT page_slug AS slug FROM view_cache
          WHERE page_slug = $1 AND view_prompt_hash = $2 AND head_hash = $3
          LIMIT 1`,
        [slug, pHash, currentHead],
      );
      if (exists.rows.length > 0) return;

      const entries = await fetchEntries(slug);
      const result = await buildDocView({ slug, prompt, entries });
      await pool.query(
        `INSERT INTO view_cache
           (page_slug, view_prompt_hash, head_hash, view_json, tokens_used, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (page_slug, view_prompt_hash, head_hash) DO NOTHING`,
        [
          slug,
          pHash,
          currentHead,
          JSON.stringify(result.view),
          result.tokensUsed,
          result.costUsd,
        ],
      );
      console.log(
        `[views.doc ${slug}] background regen ok in ${result.generationSeconds.toFixed(
          1,
        )}s, $${result.costUsd.toFixed(4)}`,
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.warn(`[views.doc ${slug}] background regen skipped: budget cap`);
      } else {
        console.error(`[views.doc ${slug}] background regen failed:`, err);
      }
    }
  })();
}

async function fetchEntries(slug: string): Promise<
  Array<{
    seq: number;
    kind: string;
    parent_seq: number | null;
    body: string | null;
  }>
> {
  // We pass parent_seq (not parent_id) to the LLM since it works in seqs.
  // The LEFT JOIN handles the case where a parent entry was erased — its
  // seq is still meaningful for citation purposes.
  const rows = await pool.query<EntryRow>(
    `SELECT
       e.id,
       e.seq,
       e.kind,
       p.seq AS parent_seq,
       b.body
     FROM entries e
     LEFT JOIN entries p ON p.id = e.parent_id
     LEFT JOIN entry_bodies b ON b.entry_id = e.id
     WHERE e.page_slug = $1
     ORDER BY e.seq ASC
     LIMIT 1000`,
    [slug],
  );
  return rows.rows.map((r) => ({
    seq: r.seq,
    kind: r.kind,
    parent_seq: r.parent_seq,
    body: r.body,
  }));
}

/** Build the seq->id map the frontend uses to turn [#N] into deep links. */
async function fetchSeqToId(slug: string): Promise<Record<string, string>> {
  const rows = await pool.query<{ seq: number; id: string }>(
    `SELECT seq, id FROM entries WHERE page_slug = $1 ORDER BY seq ASC LIMIT 1000`,
    [slug],
  );
  const out: Record<string, string> = {};
  for (const r of rows.rows) out[String(r.seq)] = r.id;
  return out;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const { searchParams } = new URL(req.url);
  const cacheOnly = searchParams.get("cache_only") === "1";
  const noCache = searchParams.get("nocache") === "1";
  const staleOk = searchParams.get("stale_ok") === "1";

  const pageRows = await pool.query<PageRow>(
    "SELECT slug, description, head_hash, head_seq, status FROM pages WHERE slug = $1",
    [slug],
  );
  if (pageRows.rows.length === 0) {
    return NextResponse.json({ error: "page_not_found" }, { status: 404 });
  }
  const page = pageRows.rows[0]!;

  if (page.head_seq < 0) {
    return new NextResponse(null, { status: 204 });
  }

  const prompt = docPromptFor(slug, page.description);
  const pHash = docPromptHash(prompt);

  // The seq->id map is needed for any 200 response; do it once.
  const seqToIdPromise = fetchSeqToId(slug);

  // 1. Exact-head cache lookup.
  if (!noCache) {
    const fresh = await pool.query<CacheRow>(
      `SELECT view_json, created_at, cost_usd, head_hash
         FROM view_cache
        WHERE page_slug = $1 AND view_prompt_hash = $2 AND head_hash = $3`,
      [slug, pHash, page.head_hash],
    );
    if (fresh.rows.length > 0) {
      const r = fresh.rows[0]!;
      const entry_seq_to_id = await seqToIdPromise;
      return NextResponse.json(
        {
          view: r.view_json,
          head_hash: page.head_hash,
          cached: true,
          stale: false,
          cost_usd: parseFloat(r.cost_usd),
          generated_at: r.created_at.toISOString(),
          entry_seq_to_id,
        },
        {
          headers: {
            "cache-control":
              "public, max-age=60, stale-while-revalidate=600",
          },
        },
      );
    }
  }

  // 2. Stale-ok path.
  if (staleOk) {
    const stale = await pool.query<CacheRow>(
      `SELECT view_json, created_at, cost_usd, head_hash
         FROM view_cache
        WHERE page_slug = $1 AND view_prompt_hash = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [slug, pHash],
    );
    if (stale.rows.length > 0) {
      const r = stale.rows[0]!;
      const since = await pool.query<{ delta: string }>(
        `SELECT (SELECT head_seq FROM pages WHERE slug = $1)::int
                - COALESCE((SELECT MAX(seq) FROM entries
                            WHERE page_slug = $1 AND hash = $2), -1)::int
                  AS delta`,
        [slug, r.head_hash],
      );
      const entriesSince = parseInt(since.rows[0]?.delta ?? "0", 10);

      backgroundRegenerate(slug, page.description, pHash, prompt, page.head_hash);

      const entry_seq_to_id = await seqToIdPromise;
      return NextResponse.json(
        {
          view: r.view_json,
          head_hash: page.head_hash,
          cache_head_hash: r.head_hash,
          cached: true,
          stale: true,
          entries_since_cache: Math.max(0, entriesSince),
          cost_usd: parseFloat(r.cost_usd),
          generated_at: r.created_at.toISOString(),
          entry_seq_to_id,
        },
        {
          headers: {
            "cache-control":
              "public, max-age=30, stale-while-revalidate=600",
          },
        },
      );
    }
    // No cache yet — let the caller fall back to chrono while a fresh
    // visit triggers inline generation. Don't block here.
    return new NextResponse(null, { status: 204 });
  }

  if (cacheOnly) {
    return new NextResponse(null, { status: 204 });
  }

  // 3. Inline generation (cache miss, not stale_ok mode).
  const entries = await fetchEntries(slug);
  let result;
  try {
    result = await buildDocView({ slug, prompt, entries });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return NextResponse.json(
        {
          error: "budget_exceeded",
          message: `OpenAI daily budget reached ($${err.totalUsd.toFixed(2)} / $${err.capUsd.toFixed(2)}). Doc view resumes at 00:00 UTC.`,
        },
        { status: 503 },
      );
    }
    console.error(`[views.doc ${slug}] LLM failed:`, err);
    return NextResponse.json(
      {
        error: "view_generation_failed",
        message: err instanceof Error ? err.message : "unknown error",
      },
      { status: 502 },
    );
  }

  await pool.query(
    `INSERT INTO view_cache
       (page_slug, view_prompt_hash, head_hash, view_json, tokens_used, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (page_slug, view_prompt_hash, head_hash) DO NOTHING`,
    [
      slug,
      pHash,
      page.head_hash,
      JSON.stringify(result.view),
      result.tokensUsed,
      result.costUsd,
    ],
  );

  const entry_seq_to_id = await seqToIdPromise;
  return NextResponse.json(
    {
      view: result.view,
      head_hash: page.head_hash,
      cached: false,
      cost_usd: result.costUsd,
      generated_at: new Date().toISOString(),
      model: result.model,
      generation_seconds: result.generationSeconds,
      entry_seq_to_id,
    },
    {
      headers: {
        "cache-control": "public, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}
