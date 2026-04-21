/**
 * POST /p/:slug/bodies — bulk fetch bodies for many entries on one page.
 *
 * Body: { ids: string[] }   (max 200 ids per request)
 * Returns: { entries: Array<{ entry, body, erased, erased_reason? }> }
 *
 * Used by the frontend's chronological view to render bodies efficiently.
 * Erased bodies return body=null, erased=true (with the reason from the
 * matching kind=moderation entry, when available).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { pool } from "@/lib/db";
import { ULID_REGEX } from "@/lib/types";

export const dynamic = "force-dynamic";

const BodyRequest = z.object({
  ids: z.array(z.string().regex(ULID_REGEX)).min(1).max(200),
});

interface Row {
  id: string;
  body: string | null;
  erased_at: Date | null;
  erased_reason: string | null;
  // From entries:
  page_slug: string;
  seq: number;
  kind: string;
  parent_id: string | null;
  body_commitment: string;
  created_at: Date;
  prev_hash: string;
  hash: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const json = await req.json().catch(() => null);
  const parsed = BodyRequest.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { rows } = await pool.query<Row>(
    `SELECT
       e.id, e.page_slug, e.seq, e.kind, e.parent_id,
       e.body_commitment, e.created_at, e.prev_hash, e.hash,
       b.body, b.erased_at, b.erased_reason
     FROM entries e
     LEFT JOIN entry_bodies b ON b.entry_id = e.id
     WHERE e.page_slug = $1 AND e.id = ANY($2::text[])`,
    [slug, parsed.data.ids],
  );

  const entries = rows.map((row) => {
    const erased = row.body === null || row.erased_at !== null;
    return {
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
      ...(erased && row.erased_reason
        ? { erased_reason: row.erased_reason }
        : {}),
    };
  });

  return NextResponse.json({ entries });
}
