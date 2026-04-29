/**
 * GET /p/:slug/archive.zip — one-click "complete forever-archive".
 *
 * Bundles four files into a single zip so a non-technical visitor can keep
 * the entire page (chain + bodies + verifier + a one-page README) on a USB
 * stick, email it to a friend, or stash it in cloud storage:
 *
 *   chain.jsonl    — same bytes as /p/:slug/raw (JCS-canonical chain)
 *   bodies.jsonl   — same bytes as /p/:slug/bodies.jsonl
 *   verify.py      — pinned copy of tools/verify.py at archive time
 *   README.md      — explains the contents and the offline verify command
 *
 * The two JSONL files appear in identical row order (seq ASC) so users can
 * grep / paste / join them line-by-line.
 *
 * Implementation: in-memory ZIP via fflate.zipSync (~30 KB pure-JS dep,
 * MIT). Typical pages stay well under a megabyte even with bodies; for
 * the day a single page exceeds, say, 50 MB we'd swap to fflate's
 * streaming Zip API at the same call site (one-line change).
 *
 * Filename: append.page-<slug>-<YYYYMMDD>.zip — dated so users can keep
 * multiple snapshots without overwriting.
 */
import { type NextRequest } from "next/server";
import { zipSync, strToU8 } from "fflate";

import { streamChain } from "@/lib/chain";
import { pool } from "@/lib/db";
import { readRepoFile } from "@/lib/repo-files";

export const dynamic = "force-dynamic";

interface BodyRow {
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

  const page = await pool.query<{ slug: string; description: string | null }>(
    "SELECT slug, description FROM pages WHERE slug = $1",
    [slug],
  );
  if (page.rowCount === 0) {
    return new Response(`page ${slug} not found\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const description = page.rows[0]!.description ?? "";

  // 1. Chain JSONL — pull the same byte stream /raw produces, into a
  //    single Buffer for zipping.
  const chainParts: Uint8Array[] = [];
  for await (const line of streamChain(slug)) {
    chainParts.push(new TextEncoder().encode(line));
  }
  const chainBytes = concatBytes(chainParts);

  // 2. Bodies JSONL — same SQL + format as /bodies.jsonl/route.ts.
  const bodyRows = await pool.query<BodyRow>(
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
  const bodyParts: Uint8Array[] = [];
  for (const row of bodyRows.rows) {
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
    bodyParts.push(new TextEncoder().encode(JSON.stringify(obj) + "\n"));
  }
  const bodiesBytes = concatBytes(bodyParts);

  // 3. Verifier — pinned snapshot of tools/verify.py at this server
  //    revision. The same file is also served at /verify.py, so users who
  //    want to re-verify the verifier itself can diff the two.
  let verifyPy = "";
  try {
    verifyPy = readRepoFile("tools", "verify.py");
  } catch (err) {
    console.warn(
      `[archive.zip ${slug}] tools/verify.py not readable; bundling a stub:`,
      err,
    );
    verifyPy =
      "# verify.py was missing on the server when this archive was built.\n" +
      "# Get it from: https://append.page/verify.py\n" +
      "# Or from: https://raw.githubusercontent.com/appendpage/appendpage/main/tools/verify.py\n";
  }

  // 4. README — short, friendly, includes the one-liner offline verify
  //    command so the recipient never needs to leave the folder.
  const readme = renderReadme(slug, description, bodyRows.rowCount ?? 0);

  // Build the zip in memory. fflate's zipSync takes a flat object map of
  // { filename: Uint8Array } and returns the full zip bytes. compression
  // level defaults to 6, which is a good balance for JSONL text.
  const zipped = zipSync(
    {
      "chain.jsonl": chainBytes,
      "bodies.jsonl": bodiesBytes,
      "verify.py": strToU8(verifyPy),
      "README.md": strToU8(readme),
    },
    { level: 6 },
  );

  const stamp = isoDateStamp(new Date());
  return new Response(new Uint8Array(zipped), {
    headers: {
      "content-type": "application/zip",
      "content-length": String(zipped.byteLength),
      // Slightly looser than /raw because zipping costs more CPU; SWR keeps
      // bursts cheap (the same archive serves many concurrent downloads).
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
      "content-disposition": `attachment; filename="append.page-${slug}-${stamp}.zip"`,
      "x-content-type-options": "nosniff",
    },
  });
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function isoDateStamp(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

function renderReadme(
  slug: string,
  description: string,
  entryCount: number,
): string {
  const stamp = new Date().toISOString();
  const desc = description.trim().length > 0 ? description.trim() : "(no description)";
  return `# append.page snapshot — /p/${slug}

Archived ${stamp}.

## Contents

- \`chain.jsonl\` — the page's hash chain. One JCS-canonicalized entry per
  line (same bytes as <https://append.page/p/${slug}/raw>). Every entry's
  \`hash\` is committed to its predecessor's \`prev_hash\`, so any later
  edit, deletion, or reorder is mathematically detectable from this file
  alone.
- \`bodies.jsonl\` — the actual post text + per-entry salt. Same row order
  as \`chain.jsonl\` (sorted by \`seq\` ascending). Erased entries appear
  with \`body: null\` and \`erased: true\`; \`salt\` is still returned so
  anyone with a private archive of the body from before erasure can
  reverify it offline.
- \`verify.py\` — standalone Python verifier (stdlib + the \`jcs\`
  package). Re-checks the chain AND every body commitment.
- \`README.md\` — this file.

## Page

> ${desc}

${entryCount} entries at the time of archive.

## Verify in one line

From inside this folder:

    python verify.py chain.jsonl --with-bodies bodies.jsonl

Exit code \`0\` means: every entry's hash matches its canonical bytes,
every \`prev_hash\` matches the previous entry's \`hash\`, the seq
increments cleanly from 0, and every non-erased body satisfies
\`SHA-256(salt || body) == entry.body_commitment\`.

If you don't have the \`jcs\` PyPI package, the verifier falls back to
\`json.dumps(sort_keys=True, separators=(",", ":"))\`, which is
byte-equivalent for the v0 entry shape (string + integer fields only).

## More

- Wire format + API + verifier model: <https://append.page/AGENTS.md>
- Public mirror of every page: <https://huggingface.co/datasets/appendpage/ledger>
- Source: <https://github.com/appendpage/appendpage>
`;
}
