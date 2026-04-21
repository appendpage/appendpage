# About append.page

`append.page` is a personal research demo by [Yuntian Deng (@da03)](https://github.com/da03), University of Waterloo. It's an experiment in append-only public-feedback platforms — not a business, not a moderated forum, not a production service. I run it on a small server out of personal interest in giving the community something more honest than a Google Doc that keeps getting deleted.

If anything below feels like generic legal text, it's not — this is what I actually do, in plain English.

## How posting works

- Anyone can post on any page. No accounts, no sign-up, no name or email collected.
- Once you post, no one — **including me** — can silently edit or delete your post. Bodies can be removed for legal reasons, but the on-chain record that "something was posted at this position" stays forever. Technical detail in [AGENTS.md](https://append.page/AGENTS.md).
- Posts are public the moment you post them and are mirrored hourly to a public dataset on HuggingFace.

## What I store

- Server access logs (timestamp, path, status code, user-agent), kept ~14 days like any nginx default.
- For each post: a SHA-256 hash of your IP address, a hash of your user-agent, the body of your post, and a 32-byte salt used to compute the on-chain commitment. The raw IP and the raw user-agent are never written to disk.
- The body and salt live in a private database table; only the hash-commitment goes on the public chain.

## What I share

- Every post body, the moment you post it. Plus the public HuggingFace mirror, refreshed hourly.
- For the AI-synthesized **Doc** view: post bodies (already public) plus my prompt go to OpenAI. Your IP hash and user-agent hash are never sent anywhere outside this server.

## What I don't do

- I don't sell data, run trackers, run analytics, or show ads.
- I don't require accounts or logins.
- I don't share your IP hash or user-agent hash with anyone.

## Before you post, please know

- **Treat every post as permanent.** Even if I erase the body later, anyone could have downloaded a copy first; the chain still records what was committed at that position.
- Don't post things you'd be devastated to have persist forever.
- This site might be slow, broken, or down at any time. I might take it down permanently with no notice.
- Your post is anonymous to other visitors, but not necessarily to law enforcement — a court order can in principle compel disclosure of what I have. (I have very little: an IP hash, a UA hash. But not nothing.)

## What you can't post

- **Illegal content** under Finnish, EU, or your own jurisdiction's law (CSAM, threats of violence, criminal copyright infringement).
- **Doxing** — publishing someone's private contact information.
- **Targeted harassment** — repeated posts attacking the same individual.
- **Impersonation** of a specific person or organization.
- **Spam** — automated posts, link spam, advertising.
- **Personal data of identifiable third parties** beyond what's needed to make a substantive point. "Prof. X was hostile to my research direction" is fine; posting Prof. X's home phone number is not.

If you violate this, I'll erase the body without notice. Repeat offenders' IP-hash ranges may be rate-limited or blocked.

## How to remove your post (or report something)

Open a [GitHub issue](https://github.com/appendpage/appendpage/issues) with the URL of the entry. A title like one of these helps me triage fast:

- `erasure: <slug>/<entry-id>` — you want your own post removed
- `takedown: <slug>/<entry-id>` — content that violates the rules above
- `[abuse] ...` — spam, harassment

Target response: ~7 days, best effort. For [security disclosures](https://github.com/appendpage/appendpage/security/advisories/new), use GitHub Security Advisories instead so the discussion is private.

## Disputes & limits

I am not running a business and I am not insured. The site is provided as-is, with no warranty of any kind. My total liability for anything related to your use of this site is capped at €0. If you might want to sue me, please open a GitHub issue first — I will probably just do whatever you ask.

## Updates

If anything material changes here, I'll note it on the [GitHub release notes](https://github.com/appendpage/appendpage/releases).
