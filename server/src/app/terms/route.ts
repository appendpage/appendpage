/** GET /terms — serve docs/legal/terms.md as text/markdown. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";
export const revalidate = 300;

export async function GET(): Promise<Response> {
  const md = await readFile(
    join(process.cwd(), "..", "docs", "legal", "terms.md"),
    "utf8",
  );
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
