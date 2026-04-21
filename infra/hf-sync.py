#!/usr/bin/env python3
"""
infra/hf-sync.py — mirror append.page to huggingface.co/datasets/appendpage/ledger

Runs as a systemd oneshot unit triggered by a 10-minute timer. For each live
page in Postgres, fetches the canonical JSONL from the local backend, stages
it under /var/lib/appendpage/hf-mirror/pages/<slug>.jsonl, copies verify.py
and a README into the mirror, and uploads via the HuggingFace Hub API as a
single atomic commit. Skips if nothing changed.

Env (from /etc/appendpage/.env):
    HF_TOKEN           — HF write token for the appendpage org (REQUIRED)
    HF_DATASET_REPO    — dataset repo id (default "appendpage/ledger")
    DATABASE_URL       — not used directly; we query via docker exec instead

Paths:
    /var/lib/appendpage/hf-mirror         — local staging dir
    /var/lib/appendpage/compose/tools/verify.py — verifier to bundle
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# -------- config --------

MIRROR_DIR = Path(os.environ.get("HF_MIRROR_DIR", "/var/lib/appendpage/hf-mirror"))
API_URL = os.environ.get("APPENDPAGE_API_URL", "http://127.0.0.1:38080")
REPO_ID = os.environ.get("HF_DATASET_REPO", "appendpage/ledger")
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
VERIFY_SRC = Path(
    os.environ.get(
        "VERIFY_PY_SRC",
        "/var/lib/appendpage/compose/tools/verify.py",
    )
)
PG_CONTAINER = os.environ.get("PG_CONTAINER", "appendpage-db-1")
PG_USER = os.environ.get("POSTGRES_USER", "appendpage")
PG_DB = os.environ.get("POSTGRES_DB", "appendpage")


# -------- helpers --------


def log(msg: str) -> None:
    print(f"[hf-sync] {msg}", flush=True)


def run(*args: str, check: bool = True, timeout: int = 30) -> str:
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(
            f"{' '.join(args)} failed ({r.returncode}): {r.stderr.strip()}"
        )
    return r.stdout


def fetch_live_slugs() -> list[str]:
    """Read live slugs from Postgres via docker exec (no psql on the host)."""
    out = run(
        "docker",
        "exec",
        PG_CONTAINER,
        "psql",
        "-U",
        PG_USER,
        "-d",
        PG_DB,
        "-t",
        "-A",
        "-c",
        "SELECT slug FROM pages WHERE status = 'live' AND head_seq >= 0 ORDER BY slug",
    )
    return [s.strip() for s in out.splitlines() if s.strip()]


def fetch_page_jsonl(slug: str) -> bytes:
    """GET /p/<slug>/raw from the local backend. Returns raw bytes."""
    req = urllib.request.Request(
        f"{API_URL}/p/{slug}/raw",
        headers={"accept": "application/x-ndjson"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"GET /p/{slug}/raw: {e.code} {e.reason}") from e


README_TEMPLATE = """\
---
license: mit
pretty_name: append.page ledger
tags:
- feedback
- append-only
- public-ledger
---

# appendpage/ledger

Public mirror of every page on [append.page](https://append.page), pushed
roughly every 10 minutes when any chain changes.

Each file under `pages/` is the JCS-canonicalized JSONL chain of one page.
Every entry is hash-chained to the one before it, so any later edit,
deletion, or reorder is mathematically detectable by anyone who kept a copy
of a prior snapshot (this dataset is one such copy — HuggingFace also
keeps a full Git history).

## Verify a page in one command

```bash
python verify.py pages/advisors.jsonl
```

Exit code `0` means the chain is intact. The verifier is ~50 lines of
self-contained Python (stdlib + the `jcs` package for RFC 8785
canonicalization) and ships in this repo.

## Load into Python

```python
import json
with open("pages/advisors.jsonl") as f:
    entries = [json.loads(line) for line in f if line.strip()]
print(len(entries), "entries")
```

## Docs

- Wire format + API + verifier model: <https://append.page/AGENTS.md>
- Machine-readable spec: <https://append.page/api/spec.json>

## Source

- Backend: <https://github.com/appendpage/appendpage>
- Frontend: <https://github.com/appendpage/web>
- License: MIT

Run by [@da03](https://github.com/da03).

Last auto-generated: {timestamp}
"""


def write_readme() -> None:
    (MIRROR_DIR / "README.md").write_text(
        README_TEMPLATE.format(
            timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        )
    )


def stage_pages(slugs: list[str]) -> None:
    pages = MIRROR_DIR / "pages"
    pages.mkdir(parents=True, exist_ok=True)

    existing = {p.name for p in pages.iterdir() if p.is_file()}
    wanted = {f"{s}.jsonl" for s in slugs}

    for slug in slugs:
        data = fetch_page_jsonl(slug)
        target = pages / f"{slug}.jsonl"
        if target.exists() and target.read_bytes() == data:
            continue
        target.write_bytes(data)
        log(f"updated pages/{slug}.jsonl ({len(data)} bytes)")

    # Remove JSONL files whose slug no longer exists on the site.
    for name in existing - wanted:
        (pages / name).unlink()
        log(f"removed pages/{name}")


def stage_verifier() -> None:
    if not VERIFY_SRC.exists():
        log(f"WARN: verifier not at {VERIFY_SRC}; skipping")
        return
    dst = MIRROR_DIR / "verify.py"
    data = VERIFY_SRC.read_bytes()
    if not dst.exists() or dst.read_bytes() != data:
        dst.write_bytes(data)
        log("updated verify.py")


def upload_via_hub() -> bool:
    """Upload the staged mirror to HF as one commit. Returns True if pushed."""
    try:
        from huggingface_hub import HfApi
    except ImportError:
        log(
            "huggingface_hub not installed; run: "
            "pip install --user --break-system-packages huggingface_hub"
        )
        raise

    api = HfApi(token=HF_TOKEN)

    # upload_folder does its own diffing — only uploads files that differ from
    # the remote. Returns the commit url (or None if nothing to commit).
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    result = api.upload_folder(
        folder_path=str(MIRROR_DIR),
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message=f"snapshot {stamp}",
        allow_patterns=["pages/*.jsonl", "verify.py", "README.md"],
    )
    if result is None:
        log("no changes to push (remote already up to date)")
        return False
    log(f"pushed: {result}")
    return True


# -------- main --------


def main() -> int:
    if not HF_TOKEN:
        log("HF_TOKEN is not set — configure /etc/appendpage/.env")
        return 1
    MIRROR_DIR.mkdir(parents=True, exist_ok=True)

    slugs = fetch_live_slugs()
    log(f"{len(slugs)} live pages: {', '.join(slugs) if slugs else '(none)'}")

    stage_pages(slugs)
    stage_verifier()
    write_readme()

    upload_via_hub()
    return 0


if __name__ == "__main__":
    sys.exit(main())
