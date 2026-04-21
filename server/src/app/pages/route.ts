/**
 * /pages — create + list pages.
 *
 *   POST /pages              create a new page (slug + description)
 *   GET  /pages?q=foo        search pages by slug / description (prefix +
 *                             substring), up to `limit` results, ranked with
 *                             prefix matches first. Used by /new's
 *                             "did you mean an existing page?" autocomplete.
 *   GET  /pages?sort=active  list pages with >=1 entry, most-recently-active
 *                             first, up to `limit` results. Used by the
 *                             landing-page discovery section.
 *
 * (default GET with no query = sort=active)
 *
 * All GET responses: { pages: [{slug, description, entry_count, last_post_at}] }
 */
import { NextResponse, type NextRequest } from "next/server";

import { createPage } from "@/lib/chain";
import { pool } from "@/lib/db";
import { checkAll, clientIpFromHeaders } from "@/lib/rate-limit";
import { classifySlug } from "@/lib/slug";
import { CreatePageRequestSchema } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

interface PageRow {
  slug: string;
  description: string;
  entry_count: number;
  last_post_at: Date | null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim().slice(0, 64);
  const limit = Math.min(
    Math.max(parseInt(searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  // Both modes share a common subquery that joins entries so we can count +
  // take max(created_at) per page. We ignore kind=moderation entries so
  // "active" reflects genuine user activity.
  const pageStatsCTE = `
    WITH page_stats AS (
      SELECT
        p.slug,
        p.description,
        p.head_seq + 1 AS entry_count,
        MAX(e.created_at) FILTER (WHERE e.kind = 'entry') AS last_post_at
      FROM pages p
      LEFT JOIN entries e ON e.page_slug = p.slug
      WHERE p.status = 'live'
      GROUP BY p.slug, p.description, p.head_seq
    )
  `;

  if (q.length > 0) {
    // Search mode: prefix match ranked ahead of substring matches; also
    // match against description so "internship" finds "/p/googleinterns"
    // if the description mentions "internship".
    const result = await pool.query<PageRow>(
      `${pageStatsCTE}
       SELECT slug, description, entry_count, last_post_at
         FROM page_stats
        WHERE slug        ILIKE '%' || $1 || '%'
           OR description ILIKE '%' || $1 || '%'
        ORDER BY
          CASE
            WHEN slug ILIKE $1 || '%'        THEN 0
            WHEN slug ILIKE '%' || $1 || '%' THEN 1
            ELSE 2
          END,
          entry_count DESC,
          slug ASC
        LIMIT $2`,
      [q, limit],
    );
    return NextResponse.json(
      { pages: result.rows.map(shapePageRow) },
      { headers: { "cache-control": "public, max-age=10" } },
    );
  }

  // Default: active pages (any entries) sorted by most-recent post.
  const result = await pool.query<PageRow>(
    `${pageStatsCTE}
     SELECT slug, description, entry_count, last_post_at
       FROM page_stats
      WHERE entry_count > 0
      ORDER BY last_post_at DESC NULLS LAST, slug ASC
      LIMIT $1`,
    [limit],
  );
  return NextResponse.json(
    { pages: result.rows.map(shapePageRow) },
    { headers: { "cache-control": "public, max-age=30" } },
  );
}

function shapePageRow(r: PageRow): {
  slug: string;
  description: string;
  entry_count: number;
  last_post_at: string | null;
} {
  return {
    slug: r.slug,
    description: r.description ?? "",
    entry_count: r.entry_count,
    last_post_at: r.last_post_at ? r.last_post_at.toISOString() : null,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Rate-limit before any validation so a spammer can't get a free 400.
  const ipNorm = clientIpFromHeaders((h) => req.headers.get(h));
  const rl = await checkAll(ipNorm, "pages", [
    { configKey: "pages_per_hour", windowSeconds: 3600 },
    { configKey: "pages_per_day", windowSeconds: 86400 },
  ]);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `Too many new pages — try again in ~${rl.resetAfterSeconds}s.`,
        retry_after_seconds: rl.resetAfterSeconds,
        limit_key: rl.key,
      },
      {
        status: 429,
        headers: { "retry-after": String(rl.resetAfterSeconds) },
      },
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = CreatePageRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const decision = classifySlug(parsed.data.slug);
  if (!decision.ok) {
    return NextResponse.json(
      { error: "slug_invalid", message: decision.reason },
      { status: 400 },
    );
  }

  try {
    await createPage({
      slug: parsed.data.slug,
      description: parsed.data.description ?? "",
      defaultViewPrompt: parsed.data.default_view_prompt ?? null,
      status: decision.status,
    });
  } catch (err: unknown) {
    if (err instanceof Error && /duplicate key value/.test(err.message)) {
      return NextResponse.json(
        { error: "slug_taken", message: `slug "${parsed.data.slug}" is already taken` },
        { status: 409 },
      );
    }
    console.error("[pages.POST] unexpected error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  return NextResponse.json(
    { slug: parsed.data.slug, status: decision.status },
    { status: 201 },
  );
}
