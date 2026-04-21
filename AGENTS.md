# AGENTS.md — append.page spec

`append.page` is a public, append-only feedback platform. Anyone can post on per-topic pages; once posted, **no one — including the operator — can silently edit or delete** an entry. Bodies can be removed for legal reasons (harassment, doxing, GDPR), but each removal is itself an entry on the chain, so removal is never silent.

This document is the canonical specification for the wire format, the HTTP API, the verifier, and the conventions for building alternative viewers. It is written for both humans and coding agents and is served live at <https://append.page/AGENTS.md>, so an agent can fetch it directly without cloning.

---

## 1. Architecture

Two layers, kept deliberately separate:

- **Data layer** — the append-only chain. Stored in PostgreSQL on the operator's box and mirrored hourly to the public HuggingFace dataset at <https://huggingface.co/datasets/appendpage/ledger>.
- **Presentation layer** — whatever frontend you're using. The default frontend ([`appendpage/web`](https://github.com/appendpage/web)) renders the chain three ways via a top-of-page pill bar:
  - **Doc** — LLM-synthesized, citation-linked summary of the page.
  - **Chronological** — raw posts in time order, newest first.
  - **Raw JSONL** — the canonical wire format itself.

Every read endpoint is CORS-open, so anyone can write a different frontend at any origin and have it work against the live data — see §9.

---

## 2. Quick start

Three commands you can run right now against the live deployment.

**Read a page** — the canonical chain JSONL:

```bash
curl https://append.page/p/advisors/raw
```

**Post a comment** — plain JSON, rate-limited per IP (30/min, 300/hr by default):

```bash
curl -X POST https://append.page/p/advisors/entries \
  -H 'content-type: application/json' \
  -d '{"body":"Your post here."}'
```

**Verify the chain end-to-end** — every hash, every link, every body matches its commitment:

```bash
curl -O https://append.page/verify.py
python verify.py https://append.page/p/advisors
```

`OK: verified N entries, chain intact, ...` means everything checks out.

Detailed reference: schema in §3, full API in §7, verifier in §8.

---

## 3. The on-chain entry — 9 fields, freeform-markdown body

Every entry in every page's chain is a JSON object with exactly these fields:

```json
{
  "id": "01HXYZ...",
  "page": "advisors",
  "seq": 137,
  "kind": "entry",
  "parent": null,
  "body_commitment": "sha256:abc...",
  "created_at": "2026-04-20T18:00:00Z",
  "prev_hash": "sha256:def...",
  "hash": "sha256:ghi..."
}
```

| field | type | meaning |
|---|---|---|
| `id` | ULID (26 chars, time-ordered, URL-safe) | Stable identifier. Used in `parent` references and URLs like `/p/<page>/e/<id>`. |
| `page` | slug string | The page this entry belongs to. Self-describing: an entry detached from its page can still tell you where it came from. |
| `seq` | non-negative integer | Per-page monotonic sequence (0, 1, 2, ...). Useful for pagination. |
| `kind` | `"entry"` or `"moderation"` | `entry` = anyone-posted content. `moderation` = operator-issued action (e.g. an erasure record) targeting another entry via `parent`. Posters can only post `entry`. |
| `parent` | ULID of another entry on the same page, or `null` | If `kind=entry` and `parent != null` → reply to that entry. If `kind=moderation` → the entry being moderated. If `null` → top-level post. |
| `body_commitment` | `"sha256:" + hex(SHA-256(salt ‖ body_utf8_bytes))` | Cryptographic commitment to the body. Body and salt live off-chain in a private table; see §5 for why. |
| `created_at` | ISO 8601 UTC timestamp | Server-stamped at append time; not poster-supplied. |
| `prev_hash` | `"sha256:" + hex(...)` | Hash of the previous entry on this page. Genesis uses `SHA-256("genesis|<slug>|<page_created_at>")`. |
| `hash` | `"sha256:" + hex(SHA-256(canonical_bytes_of_this_entry_minus_hash))` | Content identifier. Used by the next entry's `prev_hash`. |

That is **all** the on-chain entry contains. There is no `target` field, no `tags` field, no `body` field (the body is off-chain). If a poster wants to indicate a subject they write `About Prof. X...` in the body. If they want to tag, they write `#funding`. The LLM at presentation time extracts whatever structure each view needs.

---

## 4. Canonicalization (JCS)

Each entry is canonicalized per **RFC 8785 (JCS)** before hashing, so any conforming JCS implementation produces the same `canonical_bytes`. Concretely:

- Object keys sorted lexicographically (recursively).
- No whitespace (`{"a":1,"b":2}`, not `{ "a": 1, "b": 2 }`).
- UTF-8 encoded.
- Numbers per RFC 8785 (we use only integers in the on-chain entry).
- Strings escaped per RFC 8259 (`\u` sequences only when required).

The `hash` field is computed over the canonical bytes of the entry **minus the `hash` field itself**. The chain links via `prev_hash` (the hash of the previous entry) — this is the cryptographic glue.

Reference implementations: TypeScript at `server/src/lib/jcs.ts`, Python at `tools/verify.py`. Both wrap the standard JCS libraries (`canonicalize` on npm, `jcs` on PyPI; the verifier has a stdlib-only fallback).

---

## 5. The chain — links and erasure

### `id` vs `hash`

|  | `id` | `hash` |
|---|---|---|
| **what** | ULID, stable, URL-friendly | SHA-256 of the canonical bytes |
| **purpose** | URL ergonomics, `parent` references | tamper-evidence (next entry's `prev_hash`) |
| **changes if anyone tampers?** | no (it's a free identifier) | yes (any byte change → different hash) |

### Chain structure

```
genesis_seed = SHA-256("genesis|<slug>|<page_created_at>")

entry[0]: { id: A, seq: 0, prev_hash: genesis_seed,  hash: H_A }
entry[1]: { id: B, seq: 1, prev_hash: H_A,           hash: H_B }
entry[2]: { id: C, seq: 2, prev_hash: H_B,           hash: H_C }
...
```

A linear singly-linked list. To verify, walk forward: recompute each entry's `hash` from its bytes; check `prev_hash` matches the previous entry's `hash`. Any broken link = tampering.

- **Chain link** (`prev_hash`) → by **hash**. Has to be a hash for tamper-evidence.
- **Reply link** (`parent`) → by **id**. The parent's `hash` never changes (body erasure doesn't touch the on-chain entry, only the off-chain body+salt), so id and hash are equivalent here; id wins on brevity.

### Erasure (body removal under the law)

Bodies live off-chain in a private `entry_bodies(entry_id, body, salt, ...)` table. The on-chain entry only commits to `H(salt ‖ body)`. When the operator honors an erasure request:

```
1. UPDATE entry_bodies
     SET body='', erased_at=now(), erased_reason='...'
     WHERE entry_id = X.
2. Append a NEW entry with kind="moderation", parent=X, and a body
   explaining the action ("Erased on request. Reason: harassment.").
```

What's left on the chain afterwards:

- Entry X is unchanged. `body_commitment`, `prev_hash`, `hash` all intact.
- Chain still verifies end-to-end (no broken links).
- `GET /p/<slug>/e/<id>` returns `{erased: true, erased_reason: "..."}`.
- The `kind=moderation` entry is the permanent public record of the action.
- `body_commitment` proves something specific *was* committed at X. Anyone who saved `(body, salt)` before erasure can still verify their copy by computing `SHA-256(salt ‖ body)` and comparing.

This is what justifies the salted-commitment complexity: erasure removes our ability to *serve* the body; it does not remove the *fact* that something was committed at that position, and it does not invalidate the chain.

---

## 6. What's guaranteed (and what isn't)

Honest framing of what the chain proves, in increasing order of difficulty to attack:

| # | Guarantee | Strength | Requires |
|---|---|---|---|
| 1 | Body matches the on-chain commitment | strong | nothing — anyone with `(body, salt)` can compute `SHA-256(salt ‖ body)` and compare |
| 2 | Chain is internally consistent | strong | nothing — anyone with the JSONL can recompute every `hash` and verify every `prev_hash` link |
| 3 | No retroactive editing/deletion since some past observation | conditional | one external party with a snapshot — even just the head hash — at any past moment |
| 4 | Chain wasn't fabricated from genesis before anyone first looked | **not guaranteed** | a global tamper-proof timestamp on the genesis hash (e.g. anchoring to a public blockchain), which we do not currently have |

(1) and (2) hold even if no one is watching. (3) is the property that delivers the headline product promise — and the hourly HuggingFace mirror makes it cheap to satisfy: anyone who clones the dataset at any past point has a snapshot the operator cannot reach. (4) is the limit of what we currently claim. We deliberately do not claim things the math doesn't support.

---

## 7. HTTP API

Base URL: `https://append.page` (or your own backend if you've deployed a fork).
Machine-readable spec: `GET /api/spec.json`.

### Conventions (apply to every endpoint)

- **CORS.** Every endpoint, read or write, sets `Access-Control-Allow-Origin: *`. A browser at any origin can call them. Per-IP rate limits do all the abuse protection.
- **Rate limits.** Per-IP, configured in the `rate_limit_config` PG table and tunable at runtime. Defaults: **30 entries/min, 300 entries/hr, 10 pages/hr, 40 pages/day**. Returned as `429 Too Many Requests` with a `Retry-After` header.
- **Optimistic concurrency.** On `POST /p/:slug/entries`, send `Expect-Prev-Hash: <hash>`; if it doesn't match the current head, returns `409 Conflict` with `{actual_head_hash}`.
- **Bulk download.** `git clone https://huggingface.co/datasets/appendpage/ledger` — every page as JSONL plus `verify.py`, refreshed hourly.

### Read — page data

| method | path | returns |
|---|---|---|
| `GET`  | `/p/:slug/raw` | The canonical chain as `application/x-ndjson` (one JCS-canonical entry per line). **This is the canonical data;** every other endpoint is a presentation of it. |
| `POST` | `/p/:slug/bodies` | Bulk-fetch bodies + salts for up to 200 entry ids. Body: `{ids: string[]}`. Returns: `{entries: [{entry, body, salt, erased, erased_reason?}]}`. `salt` is 64-char hex and is returned for every entry (erased or not), so anyone with a private body archive can re-verify offline. |
| `GET`  | `/p/:slug/e/:id` | Single entry: `{entry, body, salt, erased, erased_reason?}`. |
| `GET`  | `/p/:slug/views/doc` | LLM-synthesized Doc View as JSON: `{view, head_hash, cached, generated_at, entry_seq_to_id}`. Cached on `(page, prompt, head_hash)`. Add `?stale_ok=1` for stale-while-revalidate. |
| `GET`  | `/pages` | Page list / search. `?sort=active` (default) returns most recently active; `?q=<text>` returns substring matches on slug + description. |

### Read — resources

| method | path | returns |
|---|---|---|
| `GET` | `/api/spec.json` | This API as a JSON Schema document. |
| `GET` | `/AGENTS.md` | This document, as `text/markdown`. |
| `GET` | `/verify.py` | The standalone chain + body verifier (one Python file, stdlib only). |
| `GET` | `/status` | Liveness JSON: `{uptime, last_anchor_at, free_disk_bytes, llm_budget_remaining_today_usd}`. |

### Write

| method | path | body | returns |
|---|---|---|---|
| `POST` | `/p/:slug/entries` | `{body: string, parent_id?: string}` | `{entry}` — the canonical entry that was just committed. |
| `POST` | `/pages` | `{slug: string, description?: string}` | `{slug, status: "live" \| "queued_review"}` — `queued_review` means the slug looks like a personal name and needs operator review before going live. |

---

## 8. Verifier — `verify.py`

```bash
curl -O https://append.page/verify.py
python verify.py https://append.page/p/advisors
```

This fetches the chain and every body+salt, and checks four properties for each entry:

1. `hash == SHA-256(JCS(entry_minus_hash))`
2. `prev_hash == previous_entry.hash`
3. `seq` increments by 1 from 0; `page` is constant across the chain
4. For non-erased entries: `body_commitment == SHA-256(salt ‖ body)`

Erased entries skip step 4 (no body to check); their chain link is still verified.

Exit code `0` = everything intact. Exit code `1` = something is broken (failure details on stderr).

### Other modes

```bash
# Offline / from the HuggingFace mirror — chain only
python verify.py path/to/page.jsonl

# Body check from a private archive: assemble bodies.json yourself as
# {entry_id: {body, salt}} (salt is hex; available from /p/<slug>/bodies
# even for entries that have since been erased)
python verify.py path/to/page.jsonl --with-bodies path/to/bodies.json
```

The verifier is one stdlib-only Python file (`urllib`, `hashlib`, `json` + the `jcs` PyPI package for RFC 8785, with a byte-equivalent fallback if `jcs` isn't installed). It ships at `tools/verify.py` and is copied into every HuggingFace dataset push.

---

## 9. Build your own viewer

The data layer is public, every read endpoint is CORS-open, and the wire format in §3 is small and stable. Anyone can build a different viewer at any origin and have it work against the live data.

### The minimum viewer — one HTML file

Serve this from your own domain, GitHub Pages, an `<iframe>` on a blog, or even `file://` open in a browser tab:

```html
<!doctype html>
<meta charset="utf-8">
<title>my own viewer for /p/advisors</title>
<script type="module">
  const slug = "advisors";
  const base = "https://append.page";

  // Get the chain.
  const raw = await fetch(`${base}/p/${slug}/raw`).then((r) => r.text());
  const chain = raw.trim().split("\n").map((l) => JSON.parse(l));

  // Get the bodies + salts in one batch.
  const resp = await fetch(`${base}/p/${slug}/bodies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: chain.map((e) => e.id) }),
  }).then((r) => r.json());
  const bodyById = Object.fromEntries(resp.entries.map((e) => [e.entry.id, e]));

  // Render however you want. Optionally also fetch
  // `${base}/p/${slug}/views/doc` to get the AI-synthesized doc as JSON.
  document.body.innerHTML = chain
    .map((e) => {
      const b = bodyById[e.id];
      return `<article><h3>#${e.seq}</h3><pre>${b.erased ? "[erased]" : b.body}</pre></article>`;
    })
    .join("");
</script>
```

To support **posting** from your viewer, add a textarea and a `fetch(..., {method:"POST"})` to `/p/<slug>/entries`. Per-IP rate limits are the only gate; service-scale aggregators naturally hit their own ceiling because all their traffic comes from one IP, so individual viewers work freely while platform-style abuse is structurally prevented.

### Or fork the official frontend

For a polished starting point, clone [`appendpage/web`](https://github.com/appendpage/web), point it at the public backend, and redesign:

```bash
git clone https://github.com/appendpage/web my-viewer
cd my-viewer
cp .env.example .env   # APPEND_PAGE_API_URL=https://append.page
npm install && npm run dev
```

You now have the full Doc / Chronological / Raw frontend on `localhost:3000`, reading the same canonical data the official one uses. Layout, colors, typography, what the Doc view looks like, how moderation entries render — all yours.

### Conventions worth keeping

- **The view-switcher pill bar** (`Doc / Chronological / Raw JSONL`). This is what makes the data/presentation split visible to a non-technical visitor; don't hide it.
- **Honest framing of tamper-evidence** — see §6. Don't claim more than the math supports.
- **A single freeform-markdown body textarea** for posting. Don't force structured fields on posters; the LLM extracts structure at presentation time.

If you'd like your viewer featured as an alternative visualizer at append.page, open a [GitHub issue](https://github.com/appendpage/appendpage/issues).

---

## 10. Operator, legal, and document status

- **Operator:** [@da03](https://github.com/da03) (Yuntian Deng), University of Waterloo. Personal research project, not a University of Waterloo service.
- **Contact:** [GitHub issues](https://github.com/appendpage/appendpage/issues) for everything — questions, erasure requests, takedowns, abuse reports. Security disclosures via [GitHub Security Advisories](https://github.com/appendpage/appendpage/security/advisories/new). Full details in [`docs/legal/contact.md`](./docs/legal/contact.md).
- **Privacy notice:** [`docs/legal/privacy.md`](./docs/legal/privacy.md) — short, honest, describes what the deployed code actually does.
- **Terms of use:** [`docs/legal/terms.md`](./docs/legal/terms.md).

This document tracks the live deployment at <https://append.page>. Any field or endpoint described above is one you can call against the server today; track changes via the GitHub repo's commit history.

*Last updated: 2026-04-21.*
