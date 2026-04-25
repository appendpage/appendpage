-- 006_subject_dedup_cache.sql — alias map for the post-hoc subject deduplicator.
--
-- The doc-view pipeline (lib/docview-v2.ts) groups entries into sections by
-- exact-string equality of entry_tags.subject. Per-batch tag extraction has
-- no global view of a page's subject registry, so the same person/place can
-- end up under slightly different subject strings — e.g. "Rutgers · Yingying
-- Chen" in one batch and "Rutgers ECE · Yingying Chen" in another. Without
-- a merge step, those become two separate sections in the rendered article.
--
-- lib/subject-dedup.ts handles this by sending the unique subject list to a
-- single LLM call that returns merge groups + a canonical form for each. The
-- result is cached here so repeat visits never re-pay; the cache key includes
-- a hash of the sorted unique subjects so a brand-new subject naturally
-- invalidates the old map.
--
-- Cache key: (page_slug, subject_set_hash).
--
--   subject_set_hash  SHA-256 over `${DEDUP_PROMPT_VERSION}\n${sorted unique subjects joined by \n}`.
--                     Includes the prompt version so a prompt change cleanly
--                     invalidates without truncating the table.
--   alias_map         JSONB object {alias_subject: canonical_subject, ...}.
--                     Identity entries (alias === canonical) are omitted to
--                     keep payloads small; planClusters falls through to the
--                     original string when there's no alias.
--
-- Additive migration; safe to apply against a live DB (CREATE TABLE only).

BEGIN;

CREATE TABLE subject_dedup_cache (
    page_slug         TEXT          NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
    subject_set_hash  TEXT          NOT NULL,
    alias_map         JSONB         NOT NULL,
    model             TEXT          NOT NULL DEFAULT '',
    prompt_version    TEXT          NOT NULL,
    tokens_used       INTEGER       NOT NULL DEFAULT 0,
    cost_usd          NUMERIC(10, 6) NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (page_slug, subject_set_hash)
);

-- Lookup is always by (page_slug, subject_set_hash) — the primary key already
-- covers it. No additional indexes needed.

INSERT INTO schema_migrations (version) VALUES ('006_subject_dedup_cache');

COMMIT;
