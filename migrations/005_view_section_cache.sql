-- 005_view_section_cache.sql — per-subject Doc View section cache (v2 architecture).
--
-- The Phase 1 doc-view pipeline (lib/docview-v2.ts) replaces the single
-- whole-page LLM call with one LLM call PER SUBJECT-CLUSTER (one section
-- per row in this table). This lets:
--
--   1. Each section's prose grow with its member-post count instead of
--      being implicitly compressed by the model's "fit everything in one
--      response" pressure.
--   2. Incremental updates re-synthesize only the affected sections when
--      a new entry is appended, instead of re-running the whole page.
--
-- Cache key: (page_slug, prompt_version, subject_key, members_hash).
--
--   prompt_version  the per-section synthesizer's prompt version, so a
--                   prompt change cleanly invalidates without truncating.
--   subject_key     the SHA-256 of the cluster's `subject` string from
--                   entry_tags.subject (NULL is keyed as the empty string
--                   for the "Uncategorized" bucket). Hashed to keep the
--                   key bounded; the original subject string is in
--                   view_json.heading for display.
--   members_hash    SHA-256 of (sorted member entry seqs || sorted
--                   body_commitments). Changes whenever the member set
--                   changes OR any included entry's body changes (the
--                   commitment is bound to the body+salt). Hits exactly
--                   when the section's input is identical to a previous
--                   render.
--
-- Coexists with the existing whole-page `view_cache` table — old code
-- paths keep using view_cache; v2 uses this table.
--
-- Additive migration; safe to apply against a live DB (CREATE TABLE only).

BEGIN;

CREATE TABLE view_section_cache (
    page_slug       TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
    prompt_version  TEXT NOT NULL,             -- e.g. "docsec-v1.2026.04.22"
    subject_key     TEXT NOT NULL,             -- SHA-256 of subject string
    members_hash    TEXT NOT NULL,             -- SHA-256 of sorted seqs + commitments
    view_json       JSONB NOT NULL,            -- {heading, summary, key_points, member_seqs}
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    tokens_used     INTEGER NOT NULL DEFAULT 0,
    cost_usd        NUMERIC(10, 6) NOT NULL DEFAULT 0,
    model           TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (page_slug, prompt_version, subject_key, members_hash)
);

-- Used by the page-level orchestration to find "is there ANY cached
-- version of this section, even one with a different members_hash?" so
-- we can show a stale section while regenerating the fresh one in the
-- background (same SWR pattern as view_cache).
CREATE INDEX view_section_cache_recent_per_subject_idx
  ON view_section_cache (page_slug, prompt_version, subject_key, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('005_view_section_cache');

COMMIT;
