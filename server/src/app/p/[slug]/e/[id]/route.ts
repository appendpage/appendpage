/**
 * GET /p/:slug/e/:id — fetch a single entry with its body.
 *
 * Used by individual-entry permalinks and as a fallback when the bulk
 * /p/:slug/bodies endpoint is unavailable. The shape mirrors /bodies:
 *   - non-erased: { entry, body, salt, erased: false }
 *   - erased:     { entry, body: null, erased: true, erased_reason? }
 *
 * Salt is exposed (as 64-char hex) for every entry, including erased
 * ones. This lets anyone who archived a body before erasure prove their
 * archived copy is the one the chain committed to. See /bodies route
 * header for the full rationale.
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
    salt: Buffer | null;
    erased_at: Date | null;
    erased_reason: string | null;
  }>(
    `SELECT
       e.id, e.page_slug, e.seq, e.kind, e.parent_id,
       e.body_commitment, e.created_at, e.prev_hash, e.hash,
       b.body, b.salt, b.erased_at, b.erased_reason
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
    salt: row.salt ? row.salt.toString("hex") : null,
    erased,
    ...(erased && row.erased_reason ? { erased_reason: row.erased_reason } : {}),
  });
}
