#!/usr/bin/env bash
# tools/seed-demo.sh — populate /p/demo with hand-written, clearly-fictional
# entries about Westgate University's Marine Biology department.
#
# Usage:
#   BASE=https://append.page bash tools/seed-demo.sh
#
# Reads each entry's body from a separate file under tools/seed-demo-entries/
# (numbered 01.md, 02.md, ...). Lines starting with "PARENT_OF: <prevfile>"
# at the top of an entry file mark it as a reply to that previous entry.
set -e
BASE="${BASE:-https://append.page}"
SLUG="${SLUG:-demo}"
THISDIR="$(cd "$(dirname "$0")" && pwd)"
ENTRIES_DIR="$THISDIR/seed-demo-entries"

[[ -d "$ENTRIES_DIR" ]] || { echo "missing $ENTRIES_DIR" >&2; exit 1; }

echo "Creating page /p/$SLUG..." >&2
curl -sS -X POST "$BASE/pages" -H 'content-type: application/json' \
  --data "{\"slug\":\"$SLUG\",\"description\":\"Hand-written, clearly-fictional demo content about a fake Marine Biology department. See AGENTS.md.\"}" \
  >&2 || true
echo >&2
echo "Seeding entries from $ENTRIES_DIR..." >&2

declare -A IDS  # filename -> entry id

for f in $(ls "$ENTRIES_DIR"/*.md | sort); do
  fname=$(basename "$f")
  # parse PARENT_OF directive (first line, optional)
  parent_id=""
  parent_file=$(head -1 "$f" | sed -n 's/^PARENT_OF: //p')
  if [[ -n "$parent_file" ]]; then
    parent_id="${IDS[$parent_file]:-}"
    if [[ -z "$parent_id" ]]; then
      echo "  WARN: $fname references parent $parent_file with no known id; posting as top-level" >&2
    fi
    body_text=$(tail -n +2 "$f")
  else
    body_text=$(cat "$f")
  fi
  # Build JSON safely via Python (preserves all special chars).
  payload=$(python3 - "$body_text" "$parent_id" <<'PY'
import json, sys
body = sys.argv[1]
parent = sys.argv[2]
out = {"body": body}
if parent:
    out["parent_id"] = parent
print(json.dumps(out))
PY
)
  resp=$(curl -sS -X POST "$BASE/p/$SLUG/entries" \
    -H 'content-type: application/json' --data "$payload")
  id=$(python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('entry',{}).get('id',''))" <<<"$resp")
  if [[ -z "$id" ]]; then
    echo "  FAIL $fname: $resp" >&2
    exit 1
  fi
  IDS["$fname"]="$id"
  if [[ -n "$parent_id" ]]; then
    echo "  $fname -> $id  (reply to $parent_file -> $parent_id)" >&2
  else
    echo "  $fname -> $id" >&2
  fi
  sleep 0.4   # stay under nginx limit_req zone
done

echo >&2
echo "Done. Visit $BASE/p/$SLUG" >&2
