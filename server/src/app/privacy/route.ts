/** GET /privacy — serve docs/legal/privacy.md as text/markdown. */
import { readRepoFile } from "@/lib/repo-files";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const md = readRepoFile("docs", "legal", "privacy.md");
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
