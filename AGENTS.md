# AGENTS.md — append.page wire format, API, and fork guide

> This file is for humans **and** for coding agents. It is the canonical specification for the append.page wire format and HTTP API. It is also served live at <https://append.page/AGENTS.md> and at <https://append.page/agents.md>, so an agent that discovers the site can fetch this directly without cloning.

If you are an agent: you can build a fully working third-party visualizer for append.page using nothing but this document and the public HTTP API at `https://append.page`. The "Fork the frontend" section at the bottom walks you through it.

---

## 1. What append.page is

`append.page` hosts per-topic public pages where anyone can post. Each page is an append-only chain of entries. Once an entry is on a chain, **no one can silently edit or delete it** — including the operator. Bodies can be removed for legal reasons (harassment, doxing, GDPR), but body removal is a tamper-evident chained event, not a silent deletion.

Two layers, kept deliberately separate:

- **Data layer** — the append-only chain. Stored in Postgres on the operator's box; mirrored hourly to the public HuggingFace dataset at <https://huggingface.co/datasets/appendpage/ledger>.
- **Presentation layer** — whatever frontend you're using. The default frontend ([`appendpage/web`](https://github.com/appendpage/web)) renders the chain through an LLM-generated structured view, a chronological feed, or raw JSONL — visitor's choice via a top-of-page pill bar. Anyone (including you) can build a different frontend that presents the same data however they like.

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
| `seq` | non-negative integer | Per-page monotonic sequence (0, 1, 2, ...). Useful for pagination. Redundant with chain position but cheap. |
| `kind` | `"entry"` or `"moderation"` | `entry` = anyone-posted content. `moderation` = admin-posted action targeting another entry via `parent`. Posters can only post `entry`; only the admin queue can issue `moderation`. |
| `parent` | string (id of another entry on the same page), or `null` | If `kind=entry` and `parent != null` → reply to that entry. If `kind=moderation` → the entry being moderated. If `null` → top-level post. |
| `body_commitment` | `"sha256:" + hex(SHA-256(salt ‖ body_utf8_bytes))` | Cryptographic commitment to the body. The body and salt live off-chain in a private table. See §4 for why. |
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

A reference TypeScript implementation lives in the backend at `server/src/lib/jcs.ts`. A reference Python implementation is in `tools/verify.py`. Both wrap the standard JCS libraries (`canonicalize` on npm, `jcs` on PyPI).

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
Erasure flow (operator triggered by an email request):
  1. DELETE FROM entry_bodies WHERE entry_id = X.
  2. Record a row in moderation_log (operator-controlled, off-chain audit trail).
  3. Append a NEW entry to the chain with kind="moderation", parent=X,
     body explaining the action ("Erased on request. Reason: harassment.").
  4. The new moderation entry goes through the normal append protocol.

Result on the chain:
  - Entry X is unchanged. body_commitment, prev_hash, hash all intact.
  - Chain still verifies end-to-end (no broken links).
  - When anyone fetches X's body via the API, the response is
    {erased: true, erased_reason: "..."}.
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
3. **No retroactive editing/deletion since some past observation** — requires that **at least one party** has saved a snapshot of the chain (or just the head hash) at any past moment. They can re-fetch and diff. This is the "weak assumption" that delivers the headline product promise. The HuggingFace dataset (Git-versioned, hourly push) makes this trivial — anyone who clones the dataset at any past point has a snapshot the operator cannot reach.
4. **Chain wasn't fabricated from genesis before anyone first looked** — **NOT guaranteed in v0.** This is what OpenTimestamps-via-Bitcoin would close (planned for v1). For now, the more downloads and clones exist in the wild, the smaller the undetected-rewrite window.

We deliberately do not claim things the math doesn't support. See <https://append.page/about> for the honest framing.

---

## 6. HTTP API

Base URL: `https://append.page` (or your own backend if you've deployed a fork). Machine-readable spec: `GET /api/spec.json` (JSON Schema).

### Read

| method | path | returns |
|---|---|---|
| `GET` | `/p/:slug` | HTML — the default frontend's rendering of the page (or whatever frontend the operator deployed). |
| `GET` | `/p/:slug/raw` | `application/x-ndjson` — one canonical JSON entry per line, in chain order. **This is the canonical data**; everything else is a presentation of it. Streamed; safe for arbitrarily large pages. |
| `GET` | `/p/:slug/e/:id` | JSON — `{entry, body, erased, erased_reason}` for a single entry. `body` is `null` if erased. |
| `GET` | `/p/:slug/audit` | HTML — chain explorer. Includes a "Verify all" button that runs the chain verifier in-browser. |
| `GET` | `/p/:slug/anchor.txt` | `text/plain` — current `head_hash` for this page. |
| `GET` | `/anchor/latest.txt` | `text/plain` — global `{slug head_hash}` listing, refreshed every 10 min. |
| `GET` | `/AGENTS.md`, `/agents.md` | `text/markdown` — this file. |
| `GET` | `/api/spec.json` | `application/json` — full machine-readable spec (entry schema + endpoints). |
| `GET` | `/status` | `application/json` — `{uptime, last_anchor_at, free_disk_bytes, llm_budget_remaining_today_usd}`. |

### Write (Turnstile + rate-limited)

| method | path | body | returns |
|---|---|---|---|
| `POST` | `/p/:slug/entries` | `{body: string, parent_id?: string, turnstile_token: string}` | `{entry}` — the canonical entry that just got committed (with `id`, `hash`, `prev_hash`, `seq`). |
| `POST` | `/p/:slug/entries/:id/flag` | `{turnstile_token: string}` | `{ok: true}`. |
| `POST` | `/pages` | `{slug: string, description?: string, turnstile_token: string}` | `{slug, status: "live"|"queued"}` — `queued` if the slug matches the name-shaped review pattern. |
| `POST` | `/p/:slug/views` | `{prompt: string, byok_key?: string}` | `{view_json, cached, cost_usd, source}` — generate or fetch a Custom view for `(prompt, head_hash)`. If `byok_key` is supplied it's used to call OpenAI directly (held in request-scoped memory only, never logged or persisted). |

### Conventions

- All write endpoints require a Turnstile token (`turnstile_token` field).
- Rate limits returned as `429 Too Many Requests` with `Retry-After` header.
- Optional optimistic concurrency on `POST /p/:slug/entries`: send `Expect-Prev-Hash: <hash>`; if it doesn't match the current head, returns `409 Conflict` with `{actual_head_hash}`.

### Bulk download

The full ledger is mirrored hourly to <https://huggingface.co/datasets/appendpage/ledger>:

```bash
git clone https://huggingface.co/datasets/appendpage/ledger
cd ledger
python verify.py pages/advisors.jsonl   # verify the chain
```

The dataset includes `verify.py` so it's self-verifying.

---

## 7. Verify a chain in one command

```bash
# from a downloaded JSONL:
python tools/verify.py path/to/page.jsonl

# from the live API:
curl -sS https://append.page/p/advisors/raw | python tools/verify.py /dev/stdin

# with body reveals (if you've saved bodies and want to confirm them against the commitments):
python tools/verify.py path/to/page.jsonl --with-bodies path/to/bodies.json
```

Exit code `0` = chain is intact. Exit code `1` = chain is broken (with a line number of the first failure on stderr).

The verifier is ~50 lines of Python with no third-party dependencies (uses only `hashlib` and `json` from stdlib + `jcs` for canonicalization). It ships in this repo at `tools/verify.py` and is copied into every HuggingFace dataset push.

---

## 8. Fork the frontend with your coding agent

Most "fork it" instructions assume a human reader. This one is written assuming you might be an agent (Cursor, Claude, etc.) reading this file at <https://append.page/AGENTS.md>.

**Step 1.** Clone the default frontend:

```bash
git clone https://github.com/appendpage/web my-viewer
cd my-viewer
```

**Step 2.** Point it at the public backend:

```bash
cp .env.example .env
# .env contains: APPEND_PAGE_API_URL=https://append.page
npm install
npm run codegen-types   # fetches https://append.page/api/spec.json and writes typed bindings
npm run dev
```

You now have a fully working alternative viewer for append.page on `localhost:3000` that uses the same canonical data the official frontend uses.

**Step 3.** Redesign it however you want. The contract you should keep:

- **The view-switcher pill bar at the top** (`AI view / Chronological / Raw JSONL`) — this is what makes the data/presentation disaggregation visible to a non-technical visitor. Don't hide it.
- **Honest framing of tamper-evidence** — see §5. Don't claim more than the math supports.
- **The compose box with a single body textarea** — posters write freeform markdown. Don't force structured fields on them.

Everything else is yours: layout, colors, typography, what the AI view looks like, what custom-view prompts you suggest, how you render moderation entries, etc.

**Step 4.** Deploy yours wherever. If you'd like it featured on `append.page` as an alternative visualizer, open an issue at <https://github.com/appendpage/appendpage/issues>.

---

## 9. Build your own backend

The wire format is small enough that you can build a fully spec-compliant backend in a weekend. Implement:

- The 9-field on-chain entry per §2.
- JCS canonicalization per §3.
- The 8 read endpoints + 4 write endpoints per §6.
- Single-writer-per-slug serialization (advisory lock or equivalent) so concurrent appends produce a linear chain.
- Salted commitments for bodies per §4 so legal erasure preserves chain validity.

The reference implementation in this repo at `appendpage/server/` is ~2000 lines of TypeScript. A minimal compliant backend is much smaller.

---

## 10. Operator and legal

- **Operator:** [@da03](https://github.com/da03) (Yuntian Deng).
- **Contact:** see [`docs/legal/contact.md`](./docs/legal/contact.md) — single email for erasure, takedown, abuse, general questions.
- **Privacy notice:** [`docs/legal/privacy.md`](./docs/legal/privacy.md).
- **Terms of use:** [`docs/legal/terms.md`](./docs/legal/terms.md).

---

## 11. Status of this document

This is the v0 spec. v1 will likely add:

- OpenTimestamps Bitcoin anchoring for absolute (not snapshot-dependent) tamper-evidence.
- Operator Ed25519 signatures on `kind=moderation` entries, so the chain proves *who* posted each moderation action.
- On-chain `kind=flag` entries so community moderation is also tamper-evident.
- Optional typed `references[]` annotations on entries (`annotates / corrects / endorses / disputes`) bound to the target's hash.

Spec changes will be minor-version bumps with backwards-compatible additions whenever possible. Watch the GitHub repo for releases.

---

*Last updated: 2026-04-20.*
