# AGENTS.md — append.page wire format, API, and viewer guide

> Specification for the append.page wire format and HTTP API. Written for both humans and coding agents. Served live at <https://append.page/AGENTS.md>, so an agent that discovers the site can fetch this directly without cloning.

---

## 1. What append.page is

`append.page` hosts per-topic public pages where anyone can post. Each page is an **append-only chain** of entries. Once an entry is on a chain, **no one can silently edit or delete it** — including the operator. Bodies can be removed for legal reasons (harassment, doxing, GDPR), but body removal is itself a tamper-evident chained event, not a silent deletion.

Two layers, kept deliberately separate:

- **Data layer** — the append-only chain. Stored in Postgres on the operator's box and mirrored hourly to the public HuggingFace dataset at <https://huggingface.co/datasets/appendpage/ledger>.
- **Presentation layer** — whatever frontend you're using. The default frontend ([`appendpage/web`](https://github.com/appendpage/web)) renders the chain three ways via a top-of-page pill bar: **Doc** (LLM-synthesized, citation-linked), **Chronological** (raw posts in time order), **Raw JSONL** (canonical wire format). Anyone can build a different frontend that presents the same data differently — see §8.

---

## 2. The on-chain entry — 9 fields, freeform-markdown body

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
| `id` | string (ULID, 26 chars, time-ordered, URL-safe) | Stable identifier for this entry. Used in `parent` references and in URLs like `/p/<page>/e/<id>`. |
| `page` | string (slug) | The page this entry belongs to. Self-describing: an entry detached from its page can still tell you where it came from. |
| `seq` | non-negative integer | Per-page monotonic sequence (0, 1, 2, ...). Useful for pagination. |
| `kind` | `"entry"` or `"moderation"` | `entry` = anyone-posted content. `moderation` = operator-issued action (e.g. an erasure record) targeting another entry via `parent`. Posters can only post `entry`. |
| `parent` | string (id of another entry on the same page), or `null` | If `kind=entry` and `parent != null` → reply to that entry. If `kind=moderation` → the entry being moderated. If `null` → top-level post. |
| `body_commitment` | `"sha256:" + hex(SHA-256(salt ‖ body_utf8_bytes))` | Cryptographic commitment to the body. The body and salt live off-chain in a private table. See §4. |
| `created_at` | ISO 8601 UTC timestamp | Server-stamped at append time. Not poster-supplied. |
| `prev_hash` | `"sha256:" + hex(...)` | Hash of the previous entry on this page. Genesis entry uses `SHA-256("genesis|<slug>|<page_created_at>")`. |
| `hash` | `"sha256:" + hex(SHA-256(canonical_bytes_of_this_entry_minus_hash))` | Content identifier of this entry. Used by the next entry's `prev_hash` and in `/audit` to verify the chain. |

That is **all** the on-chain entry contains. There is no `target` field, no `tags` field, no `body` field (the body is off-chain). If a poster wants to indicate a subject they write `About Prof. X...` in the body. If they want to tag they write `#funding`. The LLM at presentation time extracts whatever structure the view needs.

---

## 3. Canonicalization (so writers and verifiers agree)

We canonicalize each entry per **RFC 8785 (JCS)** before hashing, so any conforming JCS implementation produces the same `canonical_bytes`. Concretely:

- All object keys sorted lexicographically (recursively).
- No whitespace (`{"a":1,"b":2}`, not `{ "a": 1, "b": 2 }`).
- UTF-8 encoded.
- Numbers per RFC 8785 (we use only integers in the on-chain entry).
- Strings escape per RFC 8259 (`\u` sequences only when required).

The `hash` field of each entry is computed over the canonical bytes of the entry **minus the `hash` field itself**. The chain links via `prev_hash` (hash of the previous entry) — this is the cryptographic glue.

A reference TypeScript implementation lives at `server/src/lib/jcs.ts`; a reference Python implementation is in `tools/verify.py`. Both wrap the standard JCS libraries (`canonicalize` on npm, `jcs` on PyPI).

---

## 4. The chain (id vs hash, replies, erasure)

### `id` vs `hash`

| | `id` | `hash` |
|---|---|---|
| **what** | ULID, stable, URL-friendly | SHA-256 of the entry's canonical bytes |
| **purpose** | URL ergonomics, `parent` references | tamper-evidence (next entry's `prev_hash`) |
| **changes if you tamper?** | no (it's a free identifier) | yes (any byte change → different hash) |

### Chain structure

```
genesis_seed = SHA-256("genesis|<slug>|<page_created_at>")

entry[0]: { id: A, seq: 0, prev_hash: genesis_seed,  hash: H_A }
entry[1]: { id: B, seq: 1, prev_hash: H_A,           hash: H_B }
entry[2]: { id: C, seq: 2, prev_hash: H_B,           hash: H_C }
...
```

A linear singly-linked list. To verify, walk forward: recompute each entry's `hash` from its bytes; check `prev_hash` matches the previous entry's `hash`. Any broken link = tampering.

### Linking — chain by hash, replies by id

- **Chain link** (`prev_hash`) → by **hash**. Has to be a hash for tamper-evidence.
- **Reply link** (`parent`) → by **id**. The parent's `hash` never changes (body erasure doesn't change the on-chain entry, only the off-chain body+salt), so id and hash are equivalent here; id wins on brevity.

### What happens when something is removed by law

Bodies live off-chain in a private `entry_bodies(entry_id, body, salt, ...)` table. The on-chain entry only commits to `H(salt ‖ body)`.

```
Erasure flow (operator triggered by a request):
  1. UPDATE entry_bodies SET body='', erased_at=now(), erased_reason=... WHERE entry_id = X.
  2. Append a NEW entry to the chain with kind="moderation", parent=X,
     body explaining the action ("Erased on request. Reason: harassment.").

Result on the chain:
  - Entry X is unchanged. body_commitment, prev_hash, hash all intact.
  - Chain still verifies end-to-end (no broken links).
  - Fetching X's body via the API returns {erased: true, erased_reason: "..."}.
  - The kind=moderation entry is permanent public record of the action.
  - body_commitment proves something specific WAS committed at X. Anyone
    who saved (body, salt) before erasure can still verify their copy
    matches by computing H(salt ‖ body) and comparing.
```

This is the property that justifies the salted-commitment complexity. Erasure removes our ability to *serve* the body; it does not remove the *fact* that something was committed at that position, and it does not invalidate the chain.

---

## 5. Tamper-evidence — what's actually guaranteed

Honest framing of what the chain guarantees, in increasing order of strength:

1. **Body matches commitment** — guaranteed without any external observer. Anyone who fetches `(body, salt)` and computes `H(salt ‖ body)` can check it matches the on-chain `body_commitment`. If the operator silently changes a body, this fails immediately.
2. **Chain is internally consistent** — guaranteed without any external observer. Anyone with the current JSONL can verify all `hash` values and all `prev_hash` links. Editing/deleting/reordering one entry breaks the chain.
3. **No retroactive editing/deletion since some past observation** — requires that **at least one party** has saved a snapshot of the chain (or just the head hash) at any past moment. They re-fetch and diff. This is the "weak assumption" that delivers the headline product promise. The HuggingFace dataset (Git-versioned, hourly push) makes this trivial — anyone who clones the dataset at any past point has a snapshot the operator cannot reach.
4. **Chain wasn't fabricated from genesis before anyone first looked** — **NOT guaranteed.** Closing this would require a global tamper-proof timestamp on the genesis hash (e.g. anchoring to a public blockchain), which we don't do. For now, the more downloads and clones exist in the wild, the smaller the undetected-rewrite window.

We deliberately do not claim things the math doesn't support.

---

## 6. HTTP API

Base URL: `https://append.page`. Machine-readable spec: `GET /api/spec.json`.

**Every endpoint is CORS-open** (`Access-Control-Allow-Origin: *`) — read or write — so a browser at any origin can call them. Per-IP rate limits do all the abuse protection; see [Conventions](#conventions) below.

### Read

| method | path | returns |
|---|---|---|
| `GET` | `/p/:slug/raw` | `application/x-ndjson` — one canonical JSON entry per line, in chain order. **This is the canonical data**; everything else is a presentation of it. |
| `POST` | `/p/:slug/bodies` | `{entries: [{entry, body, salt, erased, erased_reason?}]}` — bulk-fetch bodies for up to 200 entry ids in one request body `{ids: string[]}`. `salt` is 64-char hex and is returned for every entry (erased or not), so anyone with a private body archive can re-verify offline. Erased entries return `body: null`. |
| `GET` | `/p/:slug/e/:id` | Single-entry version of the above: `{entry, body, salt, erased, erased_reason?}`. |
| `GET` | `/p/:slug/views/doc` | `{view, head_hash, cached, cost_usd, generated_at, entry_seq_to_id}` — the AI-synthesized Doc View as JSON. Cached on `(page, prompt, head_hash)`. Add `?stale_ok=1` for stale-while-revalidate semantics. |
| `GET` | `/pages` | `{pages: [{slug, description, entry_count, last_post_at}]}` — list / search pages. `?sort=active` for most-recent (default); `?q=foo` for substring search. |
| `GET` | `/api/spec.json` | Machine-readable spec (entry schema + endpoints). |
| `GET` | `/AGENTS.md` | This document, as `text/markdown`. |
| `GET` | `/verify.py` | The standalone chain + body verifier (one Python file, stdlib only). |
| `GET` | `/status` | Liveness JSON: `{uptime, last_anchor_at, free_disk_bytes, llm_budget_remaining_today_usd}`. |

### Write

| method | path | body | returns |
|---|---|---|---|
| `POST` | `/p/:slug/entries` | `{body: string, parent_id?: string}` | `{entry}` — the canonical entry that just got committed (with `id`, `hash`, `prev_hash`, `seq`). |
| `POST` | `/pages` | `{slug: string, description?: string}` | `{slug, status: "live"\|"queued_review"}` — `queued_review` if the slug looks like a personal name. |

### Conventions

- **Rate limits** are per-IP, configured in the `rate_limit_config` table and tunable at runtime. Defaults: 30 entries/min/IP, 300 entries/hr/IP, 10 pages/hr/IP, 40 pages/day/IP. Returned as `429 Too Many Requests` with a `Retry-After` header.
- **Optimistic concurrency** on `POST /p/:slug/entries`: send `Expect-Prev-Hash: <hash>`; if it doesn't match the current head, returns `409 Conflict` with `{actual_head_hash}`.
- **Bulk download:** `git clone https://huggingface.co/datasets/appendpage/ledger` — every page's JSONL plus `verify.py`, refreshed hourly.

---

## 7. Verify a chain (and every body) in one command

```bash
curl -O https://append.page/verify.py
python verify.py https://append.page/p/advisors
```

That fetches the chain, fetches every body+salt, and checks four properties per entry:

1. `hash == SHA-256(JCS(entry_minus_hash))`
2. `prev_hash == previous_entry.hash`
3. `seq` increments by 1 from 0; `page` is constant across the chain
4. For non-erased entries: `body_commitment == SHA-256(salt || body)`

Erased entries skip step 4 (no body to check), but their chain link is still verified.

Exit code `0` = everything intact. Exit code `1` = something is broken (details on stderr).

Other modes:

```bash
# Offline / from the HuggingFace mirror — chain only:
python verify.py path/to/page.jsonl

# Body check from a private archive: assemble bodies.json yourself as
# {entry_id: {body, salt}} and pass:
python verify.py path/to/page.jsonl --with-bodies path/to/bodies.json
```

The verifier is one stdlib-only Python file (`urllib`, `hashlib`, `json` + the `jcs` PyPI package for RFC 8785 canonicalization, with a byte-equivalent fallback if `jcs` isn't installed). It ships in this repo at `tools/verify.py` and is copied into every HuggingFace dataset push.

---

## 8. Build your own viewer

Anyone can build a viewer for append.page. The data layer is public, every read endpoint is CORS-open, and the wire format in §2 is small and stable. Two paths, depending on how polished you want to get.

### Path 1: a 30-line static page

The simplest viewer is a single HTML file you serve from anywhere — your own domain, GitHub Pages, an `<iframe>` on your blog, even `file://` open in a browser tab:

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

  // Render however you want. (Optionally also fetch
  // `${base}/p/${slug}/views/doc` to get the AI-synthesized doc as JSON.)
  document.body.innerHTML = chain
    .map((e) => {
      const b = bodyById[e.id];
      const text = b.erased ? "[erased]" : b.body;
      return `<article><h3>#${e.seq}</h3><pre>${text}</pre></article>`;
    })
    .join("");
</script>
```

This will keep working as long as the wire format stays stable — no SDK to update, no auth, read endpoints are unmetered. To let visitors of your viewer also **post**, just add a textarea + a `fetch(..., {method: "POST"})` to `/p/<slug>/entries`. The per-IP rate limit is the only gate; service-scale aggregators naturally hit their own ceiling because all their traffic comes from one IP, so you can't accidentally build something that abuses the platform on behalf of others.

### Path 2: fork the official frontend

If you want a fully-featured starting point, clone [`appendpage/web`](https://github.com/appendpage/web), point it at `https://append.page` (or your own backend), and redesign:

```bash
git clone https://github.com/appendpage/web my-viewer
cd my-viewer
cp .env.example .env   # contains APPEND_PAGE_API_URL=https://append.page
npm install
npm run dev
```

You now have a fully working alternative viewer on `localhost:3000` reading the same canonical data the official frontend uses. Layout, colors, typography, what the Doc view looks like, how moderation entries render — all yours.

The contract worth keeping:

- **The view-switcher pill bar** (`Doc / Chronological / Raw JSONL`). This is what makes the data/presentation split visible to a non-technical visitor.
- **Honest framing of tamper-evidence** — see §5. Don't claim more than the math supports.
- **A single freeform-markdown body textarea** for posting. Don't force structured fields on posters.

Deploy yours wherever. If you'd like it featured as an alternative visualizer, open a GitHub issue.

---

## 9. Operator and legal

- **Operator:** [@da03](https://github.com/da03) (Yuntian Deng), University of Waterloo. Personal research project, not a University of Waterloo service.
- **Contact:** [GitHub issues](https://github.com/appendpage/appendpage/issues) for everything — questions, erasure requests, takedowns, abuse reports. Security disclosures via [GitHub Security Advisories](https://github.com/appendpage/appendpage/security/advisories/new). Details in [`docs/legal/contact.md`](./docs/legal/contact.md).
- **Privacy notice:** [`docs/legal/privacy.md`](./docs/legal/privacy.md) — short, honest, describes what the deployed code actually does.
- **Terms of use:** [`docs/legal/terms.md`](./docs/legal/terms.md).

---

## 10. Status of this document

This document tracks the wire format and HTTP API as currently deployed at <https://append.page>. Any field or endpoint described here is one you can call against the live server today. Track changes via the GitHub repo's commit history.

---

*Last updated: 2026-04-21.*
