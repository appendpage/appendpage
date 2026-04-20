-- 001_init.sql — initial schema for append.page
--
-- Design notes:
--   * `entries.canonical_bytes` is BYTEA storing the JCS-canonicalized JSON of
--     the FULL on-chain entry (with the `hash` field). This is what gets emitted
--     verbatim as one line of /p/<slug>/raw and written to the materialized
--     JSONL cache file. To verify, callers strip the `hash` field, re-canonicalize,
--     and check that re-hashing the result equals the stored `hash` (this is
--     exactly what tools/verify.py does).
--   * `entry_bodies` is the only table that holds plaintext body and salt.
--     ON DELETE here is what implements "erasure" (body and salt gone forever;
--     on-chain `body_commitment` unchanged).
--   * `entry_provenance` is private and never exposed by any public endpoint.
--   * Single-writer-per-slug serialization is enforced at append time via
--     `pg_advisory_xact_lock(hashtext(slug))`, not via DB constraints; this
--     keeps the path free of constraint-violation retry logic.

BEGIN;

CREATE TABLE pages (
    slug                TEXT PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    head_hash           TEXT NOT NULL,            -- "sha256:..." of the latest entry; equals genesis_seed for empty pages
    head_seq            INTEGER NOT NULL DEFAULT -1, -- next seq is head_seq + 1; -1 for empty pages
    description         TEXT NOT NULL DEFAULT '',
    default_view_prompt TEXT,                     -- nullable; null = use the global default
    status              TEXT NOT NULL DEFAULT 'live'
                        CHECK (status IN ('live', 'queued_review')),
    CONSTRAINT pages_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$')
);

CREATE TABLE entries (
    id              TEXT PRIMARY KEY,             -- ULID
    page_slug       TEXT NOT NULL REFERENCES pages(slug) ON DELETE RESTRICT,
    seq             INTEGER NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('entry', 'moderation')),
    parent_id       TEXT REFERENCES entries(id) ON DELETE RESTRICT,
    body_commitment TEXT NOT NULL,                -- "sha256:..."
    created_at      TIMESTAMPTZ NOT NULL,         -- server-stamped at append time (matches the on-chain field)
    prev_hash       TEXT NOT NULL,                -- "sha256:..." of the previous entry (or genesis seed for seq=0)
    hash            TEXT NOT NULL,                -- "sha256:..." of canonical_bytes
    canonical_bytes BYTEA NOT NULL,               -- JCS-canonicalized public entry minus the hash field
    UNIQUE (page_slug, seq),
    UNIQUE (hash)                                 -- defensive; collisions are astronomically unlikely
);

CREATE INDEX entries_page_slug_seq_idx ON entries (page_slug, seq);
CREATE INDEX entries_parent_id_idx     ON entries (parent_id) WHERE parent_id IS NOT NULL;

-- The plaintext body + 32-byte salt. Erasure = DELETE this row. The on-chain
-- entry (in `entries`) is untouched; the chain stays mathematically valid.
CREATE TABLE entry_bodies (
    entry_id      TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    body          TEXT NOT NULL CHECK (octet_length(body) <= 4096),
    salt          BYTEA NOT NULL CHECK (octet_length(salt) = 32),
    erased_at     TIMESTAMPTZ,
    erased_reason TEXT
    -- NOTE: actual erasure is implemented by DELETE-ing this row. The
    -- erased_at/erased_reason columns are reserved for any future
    -- soft-erase pattern; for now we hard-delete and rely on a kind=moderation
    -- entry on-chain plus the moderation_log row for the public record.
);

CREATE TABLE entry_provenance (
    entry_id        TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    ip_hash         TEXT NOT NULL,                -- H(active_salt || ip_normalized)
    ip_salt_id      INTEGER NOT NULL,             -- which daily salt was active; ties to redis salt_history
    captcha_id      TEXT NOT NULL,
    user_agent_hash TEXT NOT NULL,
    inserted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE flags (
    id           BIGSERIAL PRIMARY KEY,
    entry_id     TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    ip_hash      TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    dismissed_at TIMESTAMPTZ,
    UNIQUE (entry_id, ip_hash)                    -- one flag per (entry, IP)
);

CREATE INDEX flags_entry_active_idx ON flags (entry_id) WHERE dismissed_at IS NULL;

-- view_json cache (Phase B fills this in; created here so we don't migrate later)
CREATE TABLE view_cache (
    page_slug         TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
    view_prompt_hash  TEXT NOT NULL,              -- SHA-256 of the prompt text
    head_hash         TEXT NOT NULL,              -- chain head at render time
    view_json         JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    tokens_used       INTEGER NOT NULL DEFAULT 0,
    cost_usd          NUMERIC(10, 6) NOT NULL DEFAULT 0,
    PRIMARY KEY (page_slug, view_prompt_hash, head_hash)
);

-- moderation_log: operator-controlled audit trail (off-chain).
-- The TAMPER-EVIDENT public record of moderation lives in the chain itself
-- as kind="moderation" entries. This table exists for the admin UI and for
-- the human-readable /p/<slug>/moderation page.
CREATE TABLE moderation_log (
    id          BIGSERIAL PRIMARY KEY,
    entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE RESTRICT,
    action      TEXT NOT NULL CHECK (action IN ('erase', 'dismiss', 'deny_takedown')),
    reason      TEXT NOT NULL,
    actor       TEXT NOT NULL,                    -- GitHub username of the admin who acted
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX moderation_log_entry_idx ON moderation_log (entry_id);

-- Tracks which migrations have been applied. Hand-rolled (no Drizzle).
CREATE TABLE schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('001_init');

COMMIT;
