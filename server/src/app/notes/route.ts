/**
 * GET /notes — serve docs/legal/notes.md as text/markdown.
 *
 * `notes.md` is the single combined plain-language page covering data
 * handling, posting rules, contact, and disputes. The legacy URLs
 * /privacy, /terms, and /contact all serve the same content so that
 * existing links continue to work.
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
