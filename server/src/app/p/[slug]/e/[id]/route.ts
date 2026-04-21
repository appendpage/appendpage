/**
 * GET /p/:slug/e/:id — fetch a single entry with its body.
 *
 * Used by individual-entry permalinks and as a fallback when the bulk
 * /p/:slug/bodies endpoint is unavailable. Erased bodies return
 * { entry, body: null, erased: true, erased_reason? }.
 */
import { NextResponse } from "next/server";

import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
): Promise<NextResponse> {
  const { slug, id } = await params;
  const { rows } = await pool.query<{
    id: string;
    page_slug: string;
    seq: number;
    kind: string;
    parent_id: string | null;
    body_commitment: string;
    created_at: Date;
    prev_hash: string;
    hash: string;
    body: string | null;
    erased_at: Date | null;
    erased_reason: string | null;
  }>(
    `SELECT
       e.id, e.page_slug, e.seq, e.kind, e.parent_id,
       e.body_commitment, e.created_at, e.prev_hash, e.hash,
       b.body, b.erased_at, b.erased_reason
     FROM entries e
     LEFT JOIN entry_bodies b ON b.entry_id = e.id
     WHERE e.page_slug = $1 AND e.id = $2`,
    [slug, id],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const row = rows[0]!;
  const erased = row.body === null || row.erased_at !== null;
  return NextResponse.json({
    entry: {
      id: row.id,
      page: row.page_slug,
      seq: row.seq,
      kind: row.kind,
      parent: row.parent_id,
      body_commitment: row.body_commitment,
      created_at: row.created_at.toISOString(),
      prev_hash: row.prev_hash,
      hash: row.hash,
    },
    body: erased ? null : row.body,
    erased,
    ...(erased && row.erased_reason ? { erased_reason: row.erased_reason } : {}),
  });
}
