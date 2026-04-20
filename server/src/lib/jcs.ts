/**
 * RFC 8785 (JCS) JSON canonicalization.
 *
 * Wraps the well-tested `canonicalize` npm package so we can:
 *   1. Centralize where canonicalization happens.
 *   2. Swap implementations later if we ever need to (e.g. to a Wasm-backed
 *      verifier shared with the Python tools).
 *
 * The Python verifier (tools/verify.py) uses the `jcs` PyPI package or, as a
 * fallback, json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)
 * which is byte-equivalent for the v0 entry shape (we use only string and int
 * values; no floats, no number-format edge cases).
 */
import canonicalize from "canonicalize";
import { createHash } from "node:crypto";

/**
 * Canonicalize an object per RFC 8785 and return its UTF-8 bytes.
 * This is the input to SHA-256 for both `body_commitment` and `hash`.
 */
export function jcsBytes(obj: unknown): Buffer {
  const canonical = canonicalize(obj);
  if (canonical === undefined) {
    throw new Error("jcsBytes: canonicalize returned undefined; non-JSON input?");
  }
  return Buffer.from(canonical, "utf8");
}

/**
 * SHA-256 of arbitrary bytes, returned as the wire-format string `"sha256:" + hex`.
 */
export function sha256Hex(bytes: Buffer): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/**
 * Compute the entry `hash`: SHA-256 of the JCS-canonicalized entry MINUS the
 * `hash` field itself. The `hash` field is excluded so an entry's hash is
 * defined independently of its eventual placement on the chain.
 */
export function entryHash(entryWithoutHash: Record<string, unknown>): {
  hash: string;
  canonicalBytes: Buffer;
} {
  // Defensive: caller should not pass a hash field, but if they do, drop it.
  const { hash: _drop, ...stripped } = entryWithoutHash as { hash?: unknown };
  const canonicalBytes = jcsBytes(stripped);
  return { hash: sha256Hex(canonicalBytes), canonicalBytes };
}

/**
 * Compute body_commitment: SHA-256(salt ‖ body_utf8_bytes), formatted as the
 * wire-format string. Salt is 32 random bytes; body is the user's markdown
 * (post-validation: <= 4096 bytes UTF-8).
 */
export function bodyCommitment(salt: Buffer, body: string): string {
  if (salt.length !== 32) {
    throw new Error(`bodyCommitment: salt must be 32 bytes, got ${salt.length}`);
  }
  return sha256Hex(Buffer.concat([salt, Buffer.from(body, "utf8")]));
}

/**
 * Genesis seed for a page: SHA-256("genesis|<slug>|<page_created_at_iso>").
 * Used as `prev_hash` for the very first entry on a page.
 */
export function genesisSeed(slug: string, pageCreatedAtIso: string): string {
  return sha256Hex(Buffer.from(`genesis|${slug}|${pageCreatedAtIso}`, "utf8"));
}
