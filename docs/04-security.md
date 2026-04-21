# Security threat model (v0)

## What we're protecting

- **Chain integrity.** No silent edits, no silent deletions, no silent reorderings of past entries — given the assumption in `AGENTS.md §6` that at least one third party has a snapshot of the chain at any past point. (Body changes are detectable without that assumption.)
- **Erasure honesty.** When a body is removed, the removal is on-chain and permanent record. We never silently drop a body.
- **Poster privacy.** Posters' IP addresses and User-Agents are never stored in plaintext, never published, and the `ip_hash` rotates daily with a 7-day window.
- **BYOK key handling.** A visitor's `byok_key` for the Custom-view feature is held only in request-scoped memory. Never logged, never persisted, never sent anywhere except OpenAI itself.

## What we're not trying to protect (v0)

- **Identity disclosure under court order.** We retain `ip_hash` for 7 days for abuse detection. A court could compel disclosure of what we have. The 7-day window limits how far back this goes.
- **Tamper-evidence against an operator who acts before anyone has ever seen the chain.** Closed by OpenTimestamps in v1.
- **Tamper-evidence on moderation actions beyond chain serialization.** A `kind=moderation` entry can't be silently rewritten without breaking subsequent `prev_hash` links, but the operator can still inject any moderation entry they want. Closed by Ed25519-signed moderation entries in v1.
- **DDoS resilience.** Single-server deployment behind one nginx; no CDN; no WAF. Cloudflare is pre-configured (planned for v1) but not deployed in v0.

## Threat model summary table

| Threat | Mitigated by | Residual risk |
|---|---|---|
| Operator silently changes a body | `body_commitment` mismatch detectable by anyone with the chain | None — body change is detectable without snapshot |
| Operator silently changes a chain entry | `prev_hash` chain breaks | None — internal break detectable without snapshot |
| Operator full forward-rewrite | Snapshot comparison (anyone who downloaded the chain) | Detectable only if at least one third party kept a snapshot |
| Operator fabricates from genesis before anyone looks | Nothing in v0 | **Open** — closed by OTS in v1 |
| Operator silently fakes a moderation action's reason | `kind=moderation` chained, but text is operator-controlled | Operator can lie in the body; v1 adds Ed25519 signature on chain |
| Operator silently injects fake community flags | Flags are off-chain in v0 | **Open** — closed by `kind=flag` on-chain in v1 |
| Compromised operator credentials | None in v0 | Open — single admin (`da03`); v1 adds 2-of-N when 2nd admin onboards |
| Mass-poster abuse / spam | Turnstile + Redis token buckets (Phase B) | Determined attacker can scale via captcha-solving services |
| Doxing of named third parties | Editorial moderation + `terms.md` | Can occur between post and admin review (best-effort 7-day SLO) |
| Body-text prompt injection of the LLM render | Strict `view_json` schema, no raw HTML emission, content-as-data prompting (Phase B) | Some prompt-injection mitigation can fail; we deliberately don't allow LLM to emit raw URLs/HTML |
| Cross-tenant blast radius (DDoS / IP null-route on append.page also takes down `aggregativeqa.com` / `interactivetraining.ai`) | Short DNS TTL + pre-baked Cloudflare config | Open — host-level concern; v1 mitigates via dedicated VPS or CF-in-front |

## Salt rotation (Phase B)

`ip_hash` is computed as `SHA-256(active_daily_salt ‖ ip_normalized)`:

- IPv4 IPs are normalized to `/32` (the full IP).
- IPv6 IPs are normalized to `/64` (the prefix that ISPs typically delegate). This is critical: per-`/128` hashing would let an attacker with a `/48` allocation rotate through 65k addresses for free.
- The daily salt rotates at 00:00 UTC.
- The previous 7 daily salts are kept in Redis with TTL = 7 days. Rate limits across the rotation boundary query all 7.
- After 7 days, the link from a stored `ip_hash` to its original IP is mathematically severed (we no longer have the salt).

## BYOK key handling (Phase B)

When a visitor supplies `byok_key` to `POST /p/:slug/views`:

1. The key is held in the request handler's local variable.
2. We pass it as the `Authorization` header to OpenAI.
3. After the response is returned, the local variable goes out of scope.
4. **No part of the key is logged, persisted, or stored in any database table.** This is enforced by routing all `byok_key`-handling code through a single function that has no access to the logger or to the DB pool.
5. If we ever need to debug a BYOK request, we can use the request id (synthetic, server-side only) to find the request in our logs — but the logs do not contain the key.
6. Documented in `docs/legal/privacy.md`.

## Operator key (v1)

`docs/04-security.md` will publish the operator's Ed25519 public key fingerprint when v1 ships signed moderation. The fingerprint will also be in `SECURITY.md` and on `/about`.

## Reporting

Security disclosures: email the contact address in [`docs/legal/contact.md`](./legal/contact.md) with `[security]` in the subject. We aim to acknowledge within 7 days.
