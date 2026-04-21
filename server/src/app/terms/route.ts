/**
 * GET /terms — legacy alias for /notes (the single combined page).
 *
 * Kept so old links and search-engine results don't 404. New canonical
 * URL is /notes.
 */
import { readRepoFile } from "@/lib/repo-files";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const md = readRepoFile("docs", "legal", "notes.md");
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
