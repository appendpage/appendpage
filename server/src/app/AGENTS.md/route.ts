/**
 * GET /AGENTS.md — serve the AGENTS.md file from the repo root as text/markdown.
 *
 * The lowercase `/agents.md` URL is handled via a redirect in next.config.ts
 * (we can't have a separate /agents.md/route.ts file because case-insensitive
 * filesystems on macOS would collide it with this directory).
 */
import { type NextRequest } from "next/server";

import { readRepoFile } from "@/lib/repo-files";

// Dynamic on purpose — `force-static` cached the first (broken) attempt at
// build time and stuck with it. With dynamic rendering each request hits
// the cached file via readRepoFile (which itself caches in-process).
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  try {
    const md = readRepoFile("AGENTS.md");
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
