/**
 * GET /p/:slug/views/default
 *
 * Returns the default LLM-generated `view_json` for this page. Cached by
 * (page_slug, prompt_hash, head_hash).
 *
 *   ?stale_ok=1     - SERVE NOW: return the most recent cached view for
 *                     this (slug, prompt_hash) even if head_hash has moved
 *                     on; kick off a background regeneration so the next
 *                     visitor gets the fresh one. The response includes
 *                     `stale: true` and `entries_since_cache` so the UI can
 *                     show a "refreshing…" badge. If no cache row exists at
 *                     all, returns 204 (the caller falls back to chrono).
 *
 *   ?cache_only=1   - never call the LLM; return 204 if no cache row
 *                     exactly matches the current head_hash.
 *
 *   ?nocache=1      - always call the LLM inline and overwrite cache.
 *
 *   (default)       - cache hit returns immediately; cache miss calls the
 *                     LLM inline (30s timeout). This is the original
 *                     behavior, kept for callers that need a fresh view.
 *
 * Responses:
 *   200  { view, head_hash, cached, stale?, cache_head_hash?,
 *          entries_since_cache?, cost_usd, model?, generated_at }
 *   204  no cached view AND (cache_only=1 OR stale_ok=1 with empty cache)
 *   503  budget exceeded; client should fall back to chronological view
 */
import { NextResponse, type NextRequest } from "next/server";

import { pool } from "@/lib/db";
import {
  BudgetExceededError,
  buildView,
  defaultPromptFor,
  promptHash,
  type ViewJson,
} from "@/lib/llm";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

/**
 * Fire-and-forget regeneration for the stale_ok path. Uses a Redis SETNX
 * lock so that 50 visitors hitting the same stale page only trigger ONE
 * LLM call between them. The lock auto-expires after 60s in case a
 * generation crashes mid-flight.
 *
 * Errors are logged and swallowed — this runs after the response is sent
 * to the user and there's nobody to surface them to.
 */
function backgroundRegenerate(
  slug: string,
  pHash: string,
  prompt: string,
  targetHeadHash: string,
): void {
  // We deliberately don't `await` this — it runs in the background.
  void (async () => {
    const lockKey = `view-regen:${slug}:${pHash}:${targetHeadHash}`;
    try {
      const got = await redis.set(lockKey, "1", "EX", 60, "NX");
      if (got !== "OK") {
        // Another process is already regenerating this exact (slug,prompt,head).
        return;
      }
      // Re-check page state inside the worker; head_hash might have moved on
      // again, in which case we'll regenerate against the latest.
      const pageRows = await pool.query<{ head_hash: string }>(
        "SELECT head_hash FROM pages WHERE slug = $1",
        [slug],
      );
      if (pageRows.rows.length === 0) return;
      const currentHead = pageRows.rows[0]!.head_hash;

      // Bail if a fresh row is already cached (another worker beat us).
      const exists = await pool.query<{ slug: string }>(
        `SELECT page_slug AS slug FROM view_cache
          WHERE page_slug = $1 AND view_prompt_hash = $2 AND head_hash = $3
          LIMIT 1`,
        [slug, pHash, currentHead],
      );
      if (exists.rows.length > 0) return;

      const entryRows = await pool.query<EntryRow>(
        `SELECT e.id, e.seq, e.kind, e.parent_id, b.body
           FROM entries e
           LEFT JOIN entry_bodies b ON b.entry_id = e.id
          WHERE e.page_slug = $1
          ORDER BY e.seq ASC
          LIMIT 500`,
        [slug],
      );
      const entries = entryRows.rows.map((r) => ({
        id: r.id,
        seq: r.seq,
        kind: r.kind,
        parent: r.parent_id,
        body: r.body,
      }));

      const result = await buildView({ slug, prompt, entries });
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
        `[views.default ${slug}] background regen ok in ${result.generationSeconds.toFixed(1)}s, $${result.costUsd.toFixed(4)}`,
      );
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.warn(`[views.default ${slug}] background regen skipped: budget cap`);
      } else {
        console.error(`[views.default ${slug}] background regen failed:`, err);
      }
    }
  })();
}

interface PageRow {
  slug: string;
  head_hash: string;
  head_seq: number;
  status: string;
}

interface CacheRow {
  view_json: ViewJson;
  created_at: Date;
  cost_usd: string; // pg numeric -> string
  head_hash: string;
}

interface EntryRow {
  id: string;
  seq: number;
  kind: string;
  parent_id: string | null;
  body: string | null;
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
    "SELECT slug, head_hash, head_seq, status FROM pages WHERE slug = $1",
    [slug],
  );
  if (pageRows.rows.length === 0) {
    return NextResponse.json({ error: "page_not_found" }, { status: 404 });
  }
  const page = pageRows.rows[0]!;

  if (page.head_seq < 0) {
    return NextResponse.json(
      { error: "empty_page", message: "page has no entries yet" },
      { status: 204 },
    );
  }

  const prompt = defaultPromptFor(slug);
  const pHash = promptHash(prompt);

  // 1. exact-head_hash cache lookup (the "fresh" case)
  if (!noCache) {
    const fresh = await pool.query<CacheRow>(
      `SELECT view_json, created_at, cost_usd, head_hash
         FROM view_cache
        WHERE page_slug = $1 AND view_prompt_hash = $2 AND head_hash = $3`,
      [slug, pHash, page.head_hash],
    );
    if (fresh.rows.length > 0) {
      const r = fresh.rows[0]!;
      return NextResponse.json(
        {
          view: r.view_json,
          head_hash: page.head_hash,
          cached: true,
          stale: false,
          cost_usd: parseFloat(r.cost_usd),
          generated_at: r.created_at.toISOString(),
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

  // 2. stale_ok path: serve the most recent cached view for ANY head_hash
  //    on this (slug, prompt) and kick off a background regen.
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

      // Count entries posted since the cached view was generated.
      const since = await pool.query<{ delta: string }>(
        `SELECT (SELECT head_seq FROM pages WHERE slug = $1)::int
                - COALESCE((SELECT MAX(seq) FROM entries
                            WHERE page_slug = $1 AND hash = $2), -1)::int
                  AS delta`,
        [slug, r.head_hash],
      );
      const entriesSince = parseInt(since.rows[0]?.delta ?? "0", 10);

      // Kick off background regen — fire and forget. We deliberately don't
      // await; the next visitor will pick up the fresh row.
      backgroundRegenerate(slug, pHash, prompt, page.head_hash);

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
        },
        {
          headers: {
            "cache-control":
              "public, max-age=30, stale-while-revalidate=600",
          },
        },
      );
    }
    // No cache at all yet → fall through to inline generation only if not
    // in cache_only mode; otherwise return 204 so the caller can show a
    // "generating…" placeholder rather than block on the LLM.
    return new NextResponse(null, { status: 204 });
  }

  if (cacheOnly) {
    return new NextResponse(null, { status: 204 });
  }

  // 2. cache miss — call the LLM
  const entryRows = await pool.query<EntryRow>(
    `SELECT e.id, e.seq, e.kind, e.parent_id, b.body
       FROM entries e
       LEFT JOIN entry_bodies b ON b.entry_id = e.id
      WHERE e.page_slug = $1
      ORDER BY e.seq ASC
      LIMIT 500`,
    [slug],
  );
  const entries = entryRows.rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    kind: r.kind,
    parent: r.parent_id,
    body: r.body,
  }));

  let result;
  try {
    result = await buildView({ slug, prompt, entries });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return NextResponse.json(
        {
          error: "budget_exceeded",
          message: `OpenAI daily budget reached ($${err.totalUsd.toFixed(2)} / $${err.capUsd.toFixed(2)}). AI views resume at 00:00 UTC.`,
        },
        { status: 503 },
      );
    }
    console.error(`[views.default ${slug}] LLM failed:`, err);
    return NextResponse.json(
      {
        error: "view_generation_failed",
        message: err instanceof Error ? err.message : "unknown error",
      },
      { status: 502 },
    );
  }

  // 3. cache it
  await pool.query(
    `INSERT INTO view_cache
       (page_slug, view_prompt_hash, head_hash, view_json, tokens_used, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (page_slug, view_prompt_hash, head_hash)
       DO NOTHING`,
    [
      slug,
      pHash,
      page.head_hash,
      JSON.stringify(result.view),
      result.tokensUsed,
      result.costUsd,
    ],
  );

  return NextResponse.json(
    {
      view: result.view,
      head_hash: page.head_hash,
      cached: false,
      cost_usd: result.costUsd,
      generated_at: new Date().toISOString(),
      model: result.model,
      generation_seconds: result.generationSeconds,
    },
    {
      headers: {
        "cache-control": "public, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}
