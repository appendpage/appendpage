# Spec

The canonical wire-format and API spec lives in [`AGENTS.md`](../AGENTS.md). It's served live at <https://append.page/AGENTS.md>.

The machine-readable JSON Schema is at [`server/src/app/api/spec.json/route.ts`](../server/src/app/api/spec.json/route.ts) (served at `/api/spec.json`). The frontend (`appendpage/web`) codegens types from this at build time.

This file exists so that anyone browsing `docs/` finds a pointer to the source of truth.
