# append.page

> A place to write things that can't be silently deleted.

Anyone can post on any page at `append.page/p/<slug>`. No one (including the operator) can edit or delete a post. If a post must be removed for legal reasons, the removal itself becomes a permanent public record.

This is the **backend** repo. The default frontend lives at [`appendpage/web`](https://github.com/appendpage/web). Both are MIT-licensed and forkable.

## Quick links

- **Spec for humans and coding agents:** [`AGENTS.md`](./AGENTS.md) — the wire format, the API, how to fork the frontend with a coding agent. Also served live at <https://append.page/AGENTS.md>.
- **Verify any chain in one command:** `python tools/verify.py path/to/page.jsonl`
- **Public dataset of all pages:** <https://huggingface.co/datasets/appendpage/ledger> (hourly mirror)
- **Default frontend:** <https://github.com/appendpage/web>
- **Live site:** <https://append.page>

## Status

Experimental research demo by Yuntian Deng's group. No SLA. May go down at any time. See [`docs/legal/terms.md`](./docs/legal/terms.md).

## What it does (one paragraph)

Each page is a per-page **append-only hash chain** stored in Postgres. Bodies live off-chain as **salted commitments** (`H(salt ‖ body)` on-chain; body and salt in a private table) so legal erasure can drop a body without invalidating the chain. The default visitor experience is an **LLM-generated structured view**; a top-of-page pill bar (`AI view / Chronological / Raw JSONL`) lets any visitor switch presentations with one click. Data layer and presentation layer are deliberately disaggregated — the chain stores what was written, the LLM extracts whatever structure the presentation needs at render time.

## What it doesn't do

- It is **not a blockchain.** Single-writer hash chain with a public mirror. (See `AGENTS.md` for the honest tamper-evidence claim.)
- It is **not deletion-proof in the absolute sense.** Bodies *can* be removed (legal request, harassment, etc.), but the removal is permanent public record on the chain. There is no silent deletion.
- It is **not a production service.** Research demo. No SLA.

## Run locally

```bash
cp infra/env.example .env
# edit .env: at minimum set OPENAI_API_KEY
docker compose -f infra/compose.yaml up -d
cd server && npm install && npm run dev
```

Then `curl -X POST http://localhost:3000/p/test/entries -H 'content-type: application/json' -d '{"body":"hello"}'` and `curl http://localhost:3000/p/test/raw | python tools/verify.py`.

## Repo layout

```
.
├── AGENTS.md            wire format + API + fork-the-frontend guide; served at /AGENTS.md
├── server/              Next.js 15 backend (API + AGENTS.md + spec.json)
│   └── src/
│       ├── lib/         core libs (jcs, chain, db, materializer, slug, types)
│       └── app/         App Router routes (API + static)
├── tools/
│   └── verify.py        ~50-line standalone chain verifier
├── migrations/          plain SQL migrations
├── docs/
│   ├── 01-spec.md       wire format spec (canonical: AGENTS.md)
│   ├── 02-api.md        API spec (canonical: /api/spec.json)
│   ├── 03-deployment.md deployment guide for the shared host
│   ├── 04-security.md   threat model, salt rotation, BYOK handling
│   ├── 05-moderation.md moderation policy
│   └── legal/           privacy, terms, contact pages (served on the site)
├── infra/
│   ├── bootstrap.sh     additive, co-tenant-safe server setup
│   ├── compose.yaml     Postgres + Redis + app, pinned digests
│   ├── nginx/           server block we drop into /etc/nginx/conf.d/
│   └── env.example      template for /etc/appendpage/.env
└── .github/workflows/
    └── ci.yml           lint + typecheck + unit tests + verify.py self-test
```

## Operator

Run by [@da03](https://github.com/da03) (Yuntian Deng) on a single Linux box.

## License

MIT. See [`LICENSE`](./LICENSE).
