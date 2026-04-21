#!/usr/bin/env python3
"""seed-demo.py — populate /p/demo with hand-written, clearly-fictional entries.

Reads bodies from tools/seed-demo-entries/*.md (numerically sorted).
A first line of `PARENT_OF: <prev-filename>` marks an entry as a reply to that
prior file's entry id (recorded in-memory as we post).

Idempotent over the page-creation step (409 is fine). NOT idempotent over
entries: re-running creates duplicates. Run it once per fresh page.

Usage:
    BASE=https://append.page python3 tools/seed-demo.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.environ.get("BASE", "https://append.page").rstrip("/")
SLUG = os.environ.get("SLUG", "demo")
ENTRIES_DIR = Path(__file__).resolve().parent / "seed-demo-entries"


def post_json(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        return {"_status": e.code, **(json.loads(body) if body else {})}
    return {"_status": 200, **(json.loads(body) if body else {})}


def main() -> int:
    if not ENTRIES_DIR.is_dir():
        print(f"missing {ENTRIES_DIR}", file=sys.stderr)
        return 1

    print(f"Creating page /p/{SLUG} ...", file=sys.stderr)
    r = post_json(
        "/pages",
        {
            "slug": SLUG,
            "description": (
                "Hand-written, clearly-fictional demo content about a fake "
                "Marine Biology department. See AGENTS.md."
            ),
        },
    )
    if r.get("_status") not in (200, 201):
        if r.get("error") == "slug_taken":
            print(f"  page /p/{SLUG} already exists, continuing", file=sys.stderr)
        else:
            print(f"  WARN: pages POST returned {r}", file=sys.stderr)

    files = sorted(ENTRIES_DIR.glob("*.md"), key=lambda p: p.name)
    if not files:
        print(f"no entries in {ENTRIES_DIR}", file=sys.stderr)
        return 1

    ids: dict[str, str] = {}
    for f in files:
        text = f.read_text(encoding="utf-8")
        parent_id: str | None = None
        first, _, rest = text.partition("\n")
        if first.startswith("PARENT_OF: "):
            parent_file = first[len("PARENT_OF: "):].strip()
            parent_id = ids.get(parent_file)
            if not parent_id:
                print(
                    f"  WARN: {f.name} references parent {parent_file!r} not yet posted; "
                    "posting top-level",
                    file=sys.stderr,
                )
            text = rest
        text = text.strip()

        payload: dict = {"body": text}
        if parent_id:
            payload["parent_id"] = parent_id

        resp = post_json(f"/p/{SLUG}/entries", payload)
        entry = resp.get("entry", {})
        eid = entry.get("id")
        if not eid:
            print(f"  FAIL {f.name}: {resp}", file=sys.stderr)
            return 1
        ids[f.name] = eid
        if parent_id:
            print(
                f"  {f.name} -> {eid}  (reply to {parent_file} -> {parent_id})",
                file=sys.stderr,
            )
        else:
            print(f"  {f.name} -> {eid}", file=sys.stderr)
        time.sleep(0.4)  # stay under nginx limit_req zone

    print(file=sys.stderr)
    print(f"Done. Visit {BASE}/p/{SLUG}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
