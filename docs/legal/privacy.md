# Privacy Notice

Last updated: 2026-04-20.

`append.page` is an experimental research demo. We collect the minimum needed to operate the site and prevent abuse.

## What we collect

When you visit any page on `append.page`, our server logs the request as nginx does by default (timestamp, path, status code, referrer, user-agent — kept for 14 days for debugging, then rotated out).

When you **post an entry**, we additionally store, in a private database table:

- `ip_hash` — `SHA-256(daily_rotating_salt ‖ your_ip_normalized)`. Your IP address is **not** stored in plaintext anywhere. The daily salt rotates at 00:00 UTC; we keep a 7-day rolling history of past salts so we can enforce week-scale rate limits, then they expire. After 7 days, the link from your original IP to your post is mathematically severed.
- `captcha_id` — the Cloudflare Turnstile token id from your post. Used to detect captcha-bypass abuse.
- `user_agent_hash` — `SHA-256(your_user_agent_string)`. Used for abuse detection only; we don't store the raw user-agent.
- The body of your post and a 32-byte random salt.

When you **request an LLM-generated custom view** (the "Custom view" textbox on a page), your prompt is sent to OpenAI's API. The prompt is also cached on our server keyed by `(page, prompt_hash, head_hash)` so popular queries don't re-run. **No part of your IP, IP hash, or any identifier is sent to OpenAI** with the prompt.

If you supply your own OpenAI key in the BYOK ("bring your own key") field next to the Custom view textbox: **the key is used for that single request and discarded.** It is held only in request-scoped server memory; it is not written to disk, not logged, not stored in any database, and not transmitted to any third party other than OpenAI itself.

## What we publish

The body of every entry you post is **public the moment you post it**, and is mirrored hourly to the public HuggingFace dataset at <https://huggingface.co/datasets/appendpage/ledger>. The on-chain `body_commitment` (a SHA-256 hash of the body with a random salt) is also public. Your `ip_hash`, `captcha_id`, and `user_agent_hash` are **never** published.

## How long we keep things

| data | retention |
|---|---|
| nginx access logs | 14 days, then rotated |
| `ip_hash` daily salt history | 7 days, then expired |
| post body (in our database) | indefinitely, unless you request erasure or a moderator removes it |
| post body (on the public HuggingFace mirror) | until the next hourly push after our database stops serving it; then removed from current `pages/<slug>.jsonl` (but earlier Git commits in the dataset still contain it — the HF Git history is public and not in our control) |
| LLM cost logs (per-request token count, per-request USD cost) | 30 days for budget accounting |
| moderation log entries | indefinitely (these are the public record of moderation actions) |

## How to remove your post

Email **[contact email — see `docs/legal/contact.md`]** with the URL of the entry. We will, where appropriate:

1. `DELETE` the body and salt from our private `entry_bodies` table. The body is gone forever from our database.
2. Append a public on-chain `kind="moderation"` entry to the page noting the erasure (e.g. *"Body erased at author's request, 2026-05-01."*).
3. Reply to your email confirming the action.

The on-chain entry itself (the `body_commitment`, `hash`, `prev_hash`, etc.) **stays on the chain forever** — this is what makes the platform tamper-evident. We can erase the body; we cannot rewrite the historical fact that something was committed at that position. See `AGENTS.md` §4 for the full mechanics.

Past Git commits in the public HuggingFace dataset will still contain the body until HuggingFace prunes them or the org performs a force-push (which we will do on legitimate erasure requests). We cannot, by design, control downloads of past commits that already happened.

Target SLA: 7 days.

## What we don't do

- We don't run third-party trackers or analytics on `append.page`.
- We don't sell, share, or rent any data we collect.
- We don't have ads.
- We don't require accounts or logins for posting or reading.
- We don't share your `ip_hash` or `captcha_id` with anyone, including with the OpenAI API.

## Updates

If we change this notice, we'll update the "Last updated" date and post a `kind="moderation"` entry on `/p/about` describing the change. Material changes will also be announced on the project's GitHub releases.

## Contact

See [`./contact.md`](./contact.md).

## Legal scope

This is a research-demo notice, not a formal GDPR/DSA/etc. compliance document. The salted-commitment design lets us honor erasure requests in the spirit of the right-to-be-forgotten. If you have a formal legal request and need a signed response, please say so in your email and we will engage counsel.
