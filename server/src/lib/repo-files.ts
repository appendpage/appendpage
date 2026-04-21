/**
 * Repo-relative file reader for the markdown routes.
 *
 * Why we need this: the markdown routes (AGENTS.md, /privacy, /terms,
 * /contact) want to serve files that live in the REPO ROOT (AGENTS.md) or
 * in `docs/legal/` (the legal pages), not inside `server/`. We can't just
 * use process.cwd():
 *
 *   * In dev (`npm run dev` from server/), cwd = server/.
 *   * In production (Next.js standalone), the standalone server.js calls
 *     chdir() at startup so cwd = server/.next/standalone/ regardless of
 *     what systemd's WorkingDirectory is set to.
 *
 * Both cwds resolve "../AGENTS.md" differently. So instead, we anchor on
 * `import.meta.url` of THIS module, which is always at:
 *
 *   - dev:  <repo>/server/src/lib/repo-files.ts   (TS source)
 *   - prod: <repo>/server/.next/standalone/.next/server/chunks/...  (bundled)
 *
 * Since dev and prod resolve from different points, we walk up from
 * import.meta.url looking for AGENTS.md (which marks the repo root). The
 * first ancestor that contains AGENTS.md is the repo root.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedRepoRoot: string | undefined;

/**
 * Find the repo root by walking up from this module's location, stopping
 * at the first ancestor that contains AGENTS.md. Cached on first call.
 */
export function repoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "AGENTS.md"))) {
      cachedRepoRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last-ditch fallback: try common paths that work in our specific deploy.
  const candidates = [
    "/var/lib/appendpage/compose",
    join(process.cwd(), ".."),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "AGENTS.md"))) {
      cachedRepoRoot = c;
      return c;
    }
  }
  throw new Error(
    `repoRoot: could not locate AGENTS.md by walking up from ${fileURLToPath(import.meta.url)} or any of the candidates: ${candidates.join(", ")}`,
  );
}

/** Read a UTF-8 file relative to the repo root. Synchronous + cached. */
const fileCache = new Map<string, string>();
export function readRepoFile(...relPath: string[]): string {
  const full = join(repoRoot(), ...relPath);
  const hit = fileCache.get(full);
  if (hit !== undefined) return hit;
  const contents = readFileSync(full, "utf8");
  fileCache.set(full, contents);
  return contents;
}
