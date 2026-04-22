/**
 * GET /p/:slug/views/doc/sections/:subject_key
 *
 * Phase 2 lazy-load endpoint. Returns the FULL payload for a single
 * Doc View section identified by `subject_key` (the SHA-256 of the
 * subject string, as emitted in member_seqs metadata or computable by
 * the client from the heading using the same hash function).
 *
 * This lets the frontend ship "Show all sections" / "Load more" buttons
 * without re-fetching the entire doc — the initial page load returns
 * the top-K sections via /views/doc?max_sections=K, and clicking a
 * collapsed section fetches just that one here.
 *
 * Cache lookup is keyed by (page_slug, prompt_version, subject_key),
 * sorted by created_at desc — we return the most recently cached
 * version regardless of which member_set it was generated for. (The
 * full doc render guarantees the section was synthesized; this endpoint
 * just hands it back.)
 *
 * Response shape: { section, cached, generated_at, cost_usd } where
 * `section` is { heading, summary, key_points, member_seqs }.
 *
 * Status:
 *   200  section payload returned
 *   404  page not found OR no cached section for this subject_key
 *
 * Note: by design this endpoint NEVER calls the LLM; it only reads
 * cache. If a section isn't cached yet, the client should refetch the
 * full /views/doc to populate it.
 */
import { NextResponse, type NextRequest } from "next/server";

import { pool } from "@/lib/db";
import { SECTION_PROMPT_VERSION } from "@/lib/docview-v2";

export const dynamic = "force-dynamic";

interface SectionRow {
  view_json: {
    heading: string;
    summary: string;
    key_points: Array<{ text: string; cites: number[] }>;
    member_seqs: number[];
  };
  cost_usd: string;
  created_at: Date;
  members_hash: string;
}

export async function GET(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ slug: string; subject_key: string }> },
): Promise<Response> {
  const { slug, subject_key } = await params;

  // Validate subject_key shape (64-char hex SHA-256). Reject anything
  // else upfront so a malformed URL doesn't pollute the cache lookup.
  if (!/^[0-9a-f]{64}$/.test(subject_key)) {
    return NextResponse.json(
      { error: "invalid_subject_key" },
      { status: 400 },
    );
  }

  // Confirm page exists (so a typo'd slug returns 404, not a phantom
  // 404 from the section query).
  const pageProbe = await pool.query<{ slug: string }>(
    "SELECT slug FROM pages WHERE slug = $1",
    [slug],
  );
  if (pageProbe.rows.length === 0) {
    return NextResponse.json({ error: "page_not_found" }, { status: 404 });
  }

  const r = await pool.query<SectionRow>(
    `SELECT view_json, cost_usd, created_at, members_hash
       FROM view_section_cache
      WHERE page_slug = $1
        AND prompt_version = $2
        AND subject_key = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [slug, SECTION_PROMPT_VERSION, subject_key],
  );
  if (r.rows.length === 0) {
    return NextResponse.json(
      {
        error: "section_not_cached",
        message:
          "This section hasn't been synthesized yet. Refetch /p/<slug>/views/doc to populate it.",
      },
      { status: 404 },
    );
  }
  const row = r.rows[0]!;

  return NextResponse.json(
    {
      section: {
        heading: row.view_json.heading,
        summary: row.view_json.summary,
        key_points: row.view_json.key_points,
        member_seqs: row.view_json.member_seqs,
        total_key_points: row.view_json.key_points.length,
      },
      cached: true,
      cached_for_members_hash: row.members_hash,
      cost_usd: parseFloat(row.cost_usd),
      generated_at: row.created_at.toISOString(),
    },
    {
      headers: {
        "cache-control": "public, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}
