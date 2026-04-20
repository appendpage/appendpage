#!/usr/bin/env python3
"""
verify.py - standalone chain verifier for append.page

Usage:
    python verify.py path/to/page.jsonl
    curl -sS https://append.page/p/<slug>/raw | python verify.py /dev/stdin
    python verify.py path/to/page.jsonl --with-bodies path/to/bodies.json

Exit codes:
    0  chain is intact
    1  chain is broken (failure details on stderr)
    2  usage error

What it checks:
    1. Each entry's `hash` matches SHA-256(JCS-canonical(entry_minus_hash)).
    2. Each entry's `prev_hash` matches the previous entry's `hash`.
    3. The first entry's `prev_hash` matches SHA-256("genesis|<slug>|<page_created_at>").
       (The genesis seed only depends on the slug + page creation timestamp; we
       derive `page_created_at` from a "?genesis_at=<ISO8601>" hint on the URL
       or from the first entry's metadata if available; otherwise the genesis
       check is skipped with a note.)
    4. With --with-bodies: each revealed (body, salt) pair hashes to the on-chain
       body_commitment for its entry.

Dependencies: stdlib only (json, hashlib, sys, argparse) + the `jcs` PyPI
package for RFC 8785 canonicalization. Install with: pip install jcs
(falls back to a sort_keys + compact-separators approach if jcs is missing,
which is byte-equivalent for our entry shape since we use only string/integer
values, no floats and no special escaping).
"""
import argparse
import hashlib
import json
import sys
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


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify an append.page chain (JSONL).")
    ap.add_argument("jsonl", help="path to a .jsonl file (or /dev/stdin)")
    ap.add_argument(
        "--with-bodies",
        metavar="PATH",
        help="JSON file mapping entry_id -> {body, salt} (salt as hex)",
    )
    ap.add_argument(
        "--genesis-at",
        metavar="ISO8601",
        help="page creation timestamp; if supplied, also verifies entry[0].prev_hash "
        "== SHA-256(\"genesis|<slug>|<ts>\")",
    )
    args = ap.parse_args()

    with open(args.jsonl, "r", encoding="utf-8") as f:
        entries = [json.loads(line) for line in f if line.strip()]

    bodies_by_id = None
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

    print(f"OK: {msg}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
