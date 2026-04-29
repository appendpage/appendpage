/**
 * GET /p/:slug/bodies.jsonl — stream the bodies of a page as JSONL.
 *
 * Parallel to /p/:slug/raw (which streams the canonical chain). Same row
 * order (seq ASC) so a tool can `paste` the two files line-by-line, or
 * just download both into the same folder and join on entry_id.
 *
 * Each line is a single JSON object:
 *
 *   {"entry_id":"01K...","body":"the actual post text","salt":"a1b2…64hex","erased":false}
 *
 * Erased entries:
 *
 *   {"entry_id":"...","body":null,"salt":"…hex","erased":true,"erased_reason":"..."}
 *
 * Salt is ALWAYS returned, even for erased rows. Anyone with a private
 * archive of the body from before erasure can still recompute
 * SHA-256(salt || body) to confirm it matches the chain's body_commitment.
 * The trade-off (a dictionary attacker who can guess the body can confirm
 * their guess) is intentional — verifiability beats erasure-induced
 * unprovability for this platform's content. See bodies/route.ts for the
 * matching POST endpoint.
 *
 * Why a separate JSONL endpoint at all? The Raw view download was a wall
 * of hashes (chain-only) which left non-technical visitors confused about
 * where the actual content lived. The architectural separation between
 * chain (immutable, hash-committed) and bodies (erasable) is correct, but
 * for download / archival / offline analysis users need bodies as a single
 * file too. This endpoint is that file. /raw stays byte-pure for the
 * verifier; this one is the human-readable partner.
 */
import { type NextRequest } from "next/server";

import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

interface Row {
  id: string;
  body: string | null;
  salt: Buffer | null;
  erased_at: Date | null;
  erased_reason: string | null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;

  const page = await pool.query("SELECT slug FROM pages WHERE slug = $1", [
    slug,
  ]);
  if (page.rowCount === 0) {
    return new Response(`page ${slug} not found\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Single ordered query — same shape and order as /raw uses internally.
  // We don't bother with cursor-based streaming because typical pages stay
  // under a few thousand rows; pg's row buffer handles this comfortably.
  // If a single page ever grows past ~50k rows we'd swap to a server-side
  // cursor here, but the UI cap on page growth makes that unlikely.
  const rows = await pool.query<Row>(
    `SELECT
       e.id,
       b.body,
       b.salt,
       b.erased_at,
       b.erased_reason
     FROM entries e
     LEFT JOIN entry_bodies b ON b.entry_id = e.id
     WHERE e.page_slug = $1
     ORDER BY e.seq ASC`,
    [slug],
  );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      try {
        for (const row of rows.rows) {
          const erased = row.body === null || row.erased_at !== null;
          const obj: {
            entry_id: string;
            body: string | null;
            salt: string | null;
            erased: boolean;
            erased_reason?: string;
          } = {
            entry_id: row.id,
            body: erased ? null : row.body,
            salt: row.salt ? row.salt.toString("hex") : null,
            erased,
          };
          if (erased && row.erased_reason) obj.erased_reason = row.erased_reason;
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "public, max-age=10, stale-while-revalidate=60",
      "x-content-type-options": "nosniff",
      // Hint to browsers/curl that this is a downloadable file with a
      // sensible default name. The Raw view also exposes the link via a
      // visible Download button.
      "content-disposition": `inline; filename="${slug}.bodies.jsonl"`,
    },
  });
}
