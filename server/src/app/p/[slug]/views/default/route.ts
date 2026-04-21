/**
 * GET /p/:slug/views/default
 *
 * Returns the default LLM-generated `view_json` for this page. Caches by
 * (page_slug, prompt_hash, head_hash); on cache miss, calls the LLM inline.
 *
 *   ?cache_only=1   - never call the LLM; return 204 if no cache
 *   ?nocache=1      - always call the LLM and overwrite cache
 *
 * Returns:
 *   200  { view, head_hash, cached, cost_usd, model, generated_at }
 *   204  no cached view, cache_only=1
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

export const dynamic = "force-dynamic";

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

  const pageRows = await pool.query<PageRow>(
    "SELECT slug, head_hash, head_seq, status FROM pages WHERE slug = $1",
    [slug],
  );
  if (pageRows.rows.length === 0) {
    return NextResponse.json({ error: "page_not_found" }, { status: 404 });
  }
  const page = pageRows.rows[0]!;

  if (page.head_seq < 0) {
    // Empty page — no view to generate.
    return NextResponse.json(
      { error: "empty_page", message: "page has no entries yet" },
      { status: 204 },
    );
  }

  const prompt = defaultPromptFor(slug);
  const pHash = promptHash(prompt);

  // 1. cache lookup
  if (!noCache) {
    const cached = await pool.query<CacheRow>(
      `SELECT view_json, created_at, cost_usd
         FROM view_cache
        WHERE page_slug = $1 AND view_prompt_hash = $2 AND head_hash = $3`,
      [slug, pHash, page.head_hash],
    );
    if (cached.rows.length > 0) {
      const r = cached.rows[0]!;
      return NextResponse.json(
        {
          view: r.view_json,
          head_hash: page.head_hash,
          cached: true,
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
