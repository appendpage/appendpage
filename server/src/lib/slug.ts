/**
 * Slug rules per AGENTS.md / docs/05-moderation.md.
 *
 *   - regex: ^[a-z0-9][a-z0-9-]{1,48}$
 *   - reserved namespace
 *   - name-shaped slugs (^[a-z]+-[a-z]+$) go to manual review (status=queued_review)
 *   - profanity / lookalike block list (placeholder for v0; expand as needed)
 */
import { SLUG_REGEX } from "./types";

/**
 * Reserved slugs that point at platform features. Matches the AGENTS.md list.
 * Keep in sync with the SQL CHECK constraint and any path-routing in the app.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "agents.md",
  "anchor",
  "api",
  "assets",
  "about",
  "contact",
  "dmca",
  "erasure",
  "export",
  "favicon.ico",
  "help",
  "legal",
  "new",
  "notice",
  "p",
  "privacy",
  "robots.txt",
  "sitemap",
  "static",
  "status",
  "terms",
  ".well-known",
]);

/** Looks like "first-last", which is a name-shaped pattern that needs review. */
const NAME_SHAPED = /^[a-z]+-[a-z]+$/;

/**
 * Lightweight profanity/lookalike block list. Intentionally short for v0.
 * Expand as we encounter abuse.
 */
const BLOCKED_SUBSTRINGS: readonly string[] = ["fuck", "nigger", "kike", "tranny"];

export type SlugDecision =
  | { ok: true; status: "live" | "queued_review" }
  | { ok: false; reason: string };

export function classifySlug(slug: string): SlugDecision {
  if (!SLUG_REGEX.test(slug)) {
    return {
      ok: false,
      reason: "slug must match ^[a-z0-9][a-z0-9-]{1,48}$",
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, reason: `slug "${slug}" is reserved` };
  }
  for (const bad of BLOCKED_SUBSTRINGS) {
    if (slug.includes(bad)) {
      return { ok: false, reason: "slug contains a blocked substring" };
    }
  }
  if (NAME_SHAPED.test(slug)) {
    // Looks like a person's name — queue for human review before activating.
    return { ok: true, status: "queued_review" };
  }
  return { ok: true, status: "live" };
}
