/**
 * GET /p/:slug/raw — stream the chain as JSONL.
 *
 * Each line is the JCS-canonicalized full entry (with `hash`).
 * In production, nginx serves this directly via `try_files` from the
 * materialized JSONL file at /var/lib/appendpage/pages/<slug>.jsonl.
 * This route is the fallback for cache misses and the dev experience.
 */
import { type NextRequest } from "next/server";

import { streamChain } from "@/lib/chain";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;

  // Fast 404 if the page doesn't exist.
  const page = await pool.query("SELECT slug FROM pages WHERE slug = $1", [slug]);
  if (page.rowCount === 0) {
    return new Response(`page ${slug} not found\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const line of streamChain(slug)) {
          controller.enqueue(enc.encode(line));
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
    },
  });
}
