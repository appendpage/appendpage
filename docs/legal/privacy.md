# Privacy Notice

Last updated: 2026-04-21.

`append.page` is an experimental research demo. We collect the minimum needed to operate the site and prevent abuse.

## What we collect

When you visit any page on `append.page`, our server logs the request as nginx does by default (timestamp, path, status code, referrer, user-agent — kept for 14 days for debugging, then rotated out).

When you **post an entry**, we additionally store, in a private database table:

- `ip_hash` — `SHA-256(internal_salt ‖ your_ip_normalized)`. Your IP address is **not** stored in plaintext anywhere. The hash is used for rate-limiting and abuse detection. We use a fixed internal salt rather than rotating salts, so the hash provides pseudonymity but not unlinkability over time.
- `user_agent_hash` — `SHA-256(your_user_agent_string)`. Used for abuse detection only; we don't store the raw user-agent.
- The body of your post and a 32-byte random salt (the salt is used to compute the on-chain `body_commitment`).

When you **view a page's AI-synthesized doc** (the "Doc" tab), the bodies of the posts on that page are sent to OpenAI's API along with our prompt so it can produce the synthesized document. The output is cached on our server keyed by `(page, prompt_hash, head_hash)` so popular pages don't re-run on every visit. **No part of your IP, IP hash, or any identifier is sent to OpenAI** — only the post bodies (which are already public) and our prompt.

## What we publish

The body of every entry you post is **public the moment you post it**, and is mirrored hourly to the public HuggingFace dataset at <https://huggingface.co/datasets/appendpage/ledger>. The on-chain `body_commitment` (a SHA-256 hash of the body with a random salt) is also public. Your `ip_hash` and `user_agent_hash` are **never** published.

## How long we keep things

| data | retention |
|---|---|
| nginx access logs | 14 days, then rotated |
| `ip_hash` | indefinitely (used for ongoing rate-limiting / abuse detection) |
| post body (in our database) | indefinitely, unless you request erasure or a moderator removes it |
| post body (on the public HuggingFace mirror) | until the next hourly push after our database stops serving it; then removed from the current `pages/<slug>.jsonl` (but earlier Git commits in the dataset still contain it — the HF Git history is public and not in our control) |
| LLM cost logs (per-request token count, per-request USD cost) | 30 days for budget accounting |
| moderation log entries | indefinitely (these are the public record of moderation actions) |

## How to remove your post

Open a GitHub issue at <https://github.com/appendpage/appendpage/issues> with the title `erasure: <slug>/<entry-id>` and the URL of the entry. We will, where appropriate:

1. `UPDATE` the body to empty and the `erased_at` timestamp on our private `entry_bodies` table. The body is gone from our database.
2. Append a public on-chain `kind="moderation"` entry to the page noting the erasure (e.g. *"Body erased at author's request, 2026-05-01."*).
3. Reply on the GitHub issue confirming the action.

The on-chain entry itself (the `body_commitment`, `hash`, `prev_hash`, etc.) **stays on the chain forever** — this is what makes the platform tamper-evident. We can erase the body; we cannot rewrite the historical fact that something was committed at that position. See `AGENTS.md` §4 for the full mechanics.

Past Git commits in the public HuggingFace dataset will still contain the body until HuggingFace prunes them or we perform a force-push (which we will do on legitimate erasure requests). We cannot, by design, control downloads of past commits that already happened.

Target response time: 7 days, best effort.

## What we don't do

- We don't run third-party trackers or analytics on `append.page`.
- We don't sell, share, or rent any data we collect.
- We don't have ads.
- We don't require accounts or logins for posting or reading.
- We don't share your `ip_hash` or `user_agent_hash` with anyone, including with the OpenAI API.

## Updates

If we change this notice, we'll update the "Last updated" date at the top. Material changes are also announced on the project's [GitHub releases](https://github.com/appendpage/appendpage/releases).

## Contact

See [`./contact.md`](./contact.md). All requests go through GitHub issues.

## Legal scope

This is a research-demo notice, not a formal GDPR/DSA/etc. compliance document. The salted-commitment design lets us honor erasure requests in the spirit of the right-to-be-forgotten. If you have a formal legal request and need a signed response, please say so in your GitHub issue and we will engage counsel.
