/**
 * GET /verify.py — serve the standalone chain verifier as text/plain.
 *
 * This is the file referenced from the audit page, AGENTS.md, every README,
 * and the launch tweet. Hosting it under append.page itself (rather than
 * GitHub raw) lets us tell users:
 *
 *     curl -O https://append.page/verify.py
 *     python verify.py https://append.page/p/advisors
 *
 * Two short, memorable lines, both prefixed with append.page. The file is
 * the exact same `tools/verify.py` checked into the repo, so the GitHub
 * raw URL (https://raw.githubusercontent.com/.../tools/verify.py) and this
 * URL serve byte-identical content. Anyone who wants to audit the
 * verifier itself can compare them.
 *
 * Content-type is text/plain (not text/x-python) so browsers render it
 * inline rather than triggering a download dialog — easier to review in
 * the browser, easier to pipe through curl.
 */
import { type NextRequest } from "next/server";

import { readRepoFile } from "@/lib/repo-files";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  try {
    const py = readRepoFile("tools", "verify.py");
    return new Response(py, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // Same caching as the markdown docs — short stale window so a fix
        // to the verifier propagates within minutes.
        "cache-control": "public, max-age=300, stale-while-revalidate=3600",
        // Belt-and-suspenders: tell browsers "this is verify.py" if a user
        // does opt to save it via the browser's Save As.
        "content-disposition": 'inline; filename="verify.py"',
      },
    });
  } catch (err) {
    console.error("[verify.py.GET] failed to read tools/verify.py:", err);
    return new Response(
      "# verify.py is missing on the server. Get it from:\n" +
        "# https://raw.githubusercontent.com/appendpage/appendpage/main/tools/verify.py\n",
      {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
}
