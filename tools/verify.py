#!/usr/bin/env python3
"""
verify.py - standalone chain + body verifier for append.page

Common usage (one URL, full check):
    python verify.py https://append.page/p/<slug>

Other modes:
    python verify.py path/to/page.jsonl                       # chain only, offline
    curl -sS https://append.page/p/<slug>/raw | \\
        python verify.py /dev/stdin                           # chain only, offline
    python verify.py path/to/page.jsonl \\
        --with-bodies path/to/bodies.json                     # chain + bodies, offline

Exit codes:
    0  chain (and optionally bodies) intact
    1  verification failed (details on stderr)
    2  usage error / network failure

What it checks:
    1. Each entry's `hash` matches SHA-256(JCS-canonical(entry_minus_hash)).
    2. Each entry's `prev_hash` matches the previous entry's `hash`.
    3. seq increments by 1 from 0; page slug is constant across the chain.
    4. The first entry's `prev_hash` matches the genesis seed
       SHA-256("genesis|<slug>|<page_created_at>"). Pass --genesis-at <ISO>
       to enforce this; without it the genesis check is skipped with a note.
    5. URL mode + bodies mode: each non-erased entry's body+salt satisfies
       SHA-256(salt || body) == entry.body_commitment. Erased entries skip
       this check (the body is gone). The API still returns salt for
       erased entries, so anyone who archived a body privately before
       erasure can re-verify it offline by passing --with-bodies on a
       JSON file they assemble themselves.

Dependencies: stdlib only (json, hashlib, sys, argparse, urllib) + the
`jcs` PyPI package for RFC 8785 canonicalization. Install with:
    pip install jcs
(falls back to sort_keys + compact-separators, which is byte-equivalent
for our entry shape since we use only string and integer values).
"""
import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from typing import Optional

try:
    import jcs as _jcs

    def canonicalize(obj: dict) -> bytes:
        return _jcs.canonicalize(obj)
except ImportError:
    # Fallback: byte-equivalent for the v0 entry shape (string + int values only).
    # If you start using floats, install jcs.
    def canonicalize(obj: dict) -> bytes:
        return json.dumps(
            obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def genesis_seed(slug: str, page_created_at_iso: str) -> str:
    return sha256_hex(f"genesis|{slug}|{page_created_at_iso}".encode("utf-8"))


def verify_chain(
    entries: list[dict], bodies_by_id: Optional[dict[str, dict]] = None
) -> tuple[bool, str]:
    if not entries:
        return True, "empty chain (0 entries)"

    page_slug = entries[0].get("page")
    expected_prev_hash: Optional[str] = None  # set after we see entry[0]

    for i, entry in enumerate(entries):
        # 1. recompute the entry's own hash
        recorded_hash = entry.get("hash")
        if not recorded_hash:
            return False, f"entry {i} (id={entry.get('id')}) has no `hash` field"
        body = {k: v for k, v in entry.items() if k != "hash"}
        recomputed = sha256_hex(canonicalize(body))
        if recomputed != recorded_hash:
            return (
                False,
                f"entry {i} (id={entry.get('id')}): recorded hash {recorded_hash} "
                f"!= recomputed {recomputed}",
            )

        # 2. check prev_hash against the previous entry's hash
        prev_hash = entry.get("prev_hash")
        if i == 0:
            # We can't verify the genesis seed without knowing the page's
            # creation timestamp. Just record what we'd expect; skip enforcement
            # unless the caller supplies it via --genesis-at.
            pass
        else:
            if prev_hash != expected_prev_hash:
                return (
                    False,
                    f"entry {i} (id={entry.get('id')}): prev_hash {prev_hash} "
                    f"!= entry[{i - 1}].hash {expected_prev_hash}",
                )

        # 3. seq must increase by 1
        seq = entry.get("seq")
        if seq != i:
            return False, f"entry {i}: seq={seq}, expected {i}"

        # 4. page must match across the chain
        if entry.get("page") != page_slug:
            return False, (
                f"entry {i}: page={entry.get('page')!r}, expected {page_slug!r} "
                f"(mixed pages in one chain?)"
            )

        # 5. optional body verification
        if bodies_by_id:
            entry_id = entry.get("id")
            if entry_id in bodies_by_id:
                reveal = bodies_by_id[entry_id]
                body_text = reveal.get("body")
                salt_hex = reveal.get("salt")
                if body_text is None or salt_hex is None:
                    return False, (
                        f"entry {i} (id={entry_id}): bodies file is missing "
                        f"`body` or `salt`"
                    )
                salt_bytes = bytes.fromhex(salt_hex)
                computed = sha256_hex(salt_bytes + body_text.encode("utf-8"))
                if computed != entry.get("body_commitment"):
                    return False, (
                        f"entry {i} (id={entry_id}): revealed body_commitment "
                        f"{computed} != on-chain {entry.get('body_commitment')}"
                    )

        expected_prev_hash = recorded_hash

    return True, f"verified {len(entries)} entries, chain intact, head: {expected_prev_hash}"


def _http_get_jsonl(url: str) -> list[dict]:
    """Download a JSONL endpoint and parse one object per non-empty line."""
    with urllib.request.urlopen(url, timeout=30) as resp:
        text = resp.read().decode("utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def _http_post_json(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_url(base_url: str) -> tuple[list[dict], dict[str, dict]]:
    """
    Fetch the chain (one HTTP call) plus all bodies+salts (one bulk POST per
    200-id batch). Returns (entries, bodies_by_id) where bodies_by_id maps
    entry id -> {body, salt}. Erased entries are omitted from bodies_by_id
    (no body to verify against); the chain check still applies to them.
    The API does still return salt for erased entries — useful if you
    have a private archive of the body and want to recheck offline.
    """
    base_url = base_url.rstrip("/")
    raw_url = base_url + "/raw"
    bodies_url = base_url + "/bodies"

    entries = _http_get_jsonl(raw_url)
    if not entries:
        return entries, {}

    ids = [e["id"] for e in entries]
    bodies_by_id: dict[str, dict] = {}
    for batch_start in range(0, len(ids), 200):
        batch = ids[batch_start : batch_start + 200]
        resp = _http_post_json(bodies_url, {"ids": batch})
        for item in resp.get("entries", []):
            entry = item.get("entry", {})
            entry_id = entry.get("id")
            if not entry_id:
                continue
            if item.get("erased"):
                continue
            body = item.get("body")
            salt = item.get("salt")
            if body is None or salt is None:
                continue
            bodies_by_id[entry_id] = {"body": body, "salt": salt}
    return entries, bodies_by_id


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Verify an append.page chain (and optionally bodies)."
    )
    ap.add_argument(
        "source",
        help=(
            "either an append.page URL like https://append.page/p/<slug> "
            "(fetches chain + bodies + salts and verifies everything), or a "
            "path to a .jsonl file (chain-only unless --with-bodies given)"
        ),
    )
    ap.add_argument(
        "--with-bodies",
        metavar="PATH",
        help=(
            "JSON file mapping entry_id -> {body, salt} (salt as hex). "
            "Ignored when SOURCE is a URL — bodies are fetched live in "
            "that case."
        ),
    )
    ap.add_argument(
        "--genesis-at",
        metavar="ISO8601",
        help=(
            "page creation timestamp; if supplied, also verifies "
            'entry[0].prev_hash == SHA-256("genesis|<slug>|<ts>")'
        ),
    )
    args = ap.parse_args()

    is_url = args.source.startswith("http://") or args.source.startswith(
        "https://"
    )

    bodies_by_id: Optional[dict[str, dict]] = None
    if is_url:
        try:
            entries, bodies_by_id = fetch_url(args.source)
        except urllib.error.URLError as e:
            print(f"FAIL: could not fetch {args.source}: {e}", file=sys.stderr)
            return 2
    else:
        with open(args.source, "r", encoding="utf-8") as f:
            entries = [json.loads(line) for line in f if line.strip()]
        if args.with_bodies:
            with open(args.with_bodies, "r", encoding="utf-8") as f:
                bodies_by_id = json.load(f)

    ok, msg = verify_chain(entries, bodies_by_id)
    if not ok:
        print(f"FAIL: {msg}", file=sys.stderr)
        return 1

    if args.genesis_at and entries:
        expected = genesis_seed(entries[0]["page"], args.genesis_at)
        if entries[0]["prev_hash"] != expected:
            print(
                f"FAIL: entry[0].prev_hash {entries[0]['prev_hash']} != "
                f"genesis seed {expected} (slug={entries[0]['page']}, "
                f"genesis_at={args.genesis_at})",
                file=sys.stderr,
            )
            return 1

    body_note = ""
    if bodies_by_id is not None:
        verified = sum(1 for _ in bodies_by_id)
        skipped = len(entries) - verified
        body_note = (
            f"; verified {verified} bodies (commitment matches),"
            f" skipped {skipped} (erased or no body)"
        )
    print(f"OK: {msg}{body_note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
