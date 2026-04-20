/**
 * GET /AGENTS.md — serve the AGENTS.md file from the repo root as text/markdown.
 *
 * The lowercase `/agents.md` URL is handled via a redirect in next.config.ts
 * (we can't have a separate /agents.md/route.ts file because case-insensitive
 * filesystems on macOS would collide it with this directory).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type NextRequest } from "next/server";

export const dynamic = "force-static";
export const revalidate = 60;

export async function GET(_req: NextRequest): Promise<Response> {
  // server/ is the Next.js root; AGENTS.md lives in the repo root, ../AGENTS.md
  const agentsPath = join(process.cwd(), "..", "AGENTS.md");
  try {
    const md = await readFile(agentsPath, "utf8");
    return new Response(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (err) {
    console.error("[AGENTS.md.GET] failed to read AGENTS.md:", err);
    return new Response(
      "# AGENTS.md missing\n\nSee https://github.com/appendpage/appendpage",
      {
        status: 500,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      },
    );
  }
}
