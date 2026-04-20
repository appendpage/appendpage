# Terms of Use

Last updated: 2026-04-20.

`append.page` is an experimental research demo run by Yuntian Deng's group. By posting on or using the site, you agree to these terms.

## What this is

A public, append-only feedback platform. Anyone can post on any page. **Posts cannot be silently edited or deleted by anyone, including the operator.** Bodies can be removed for legal reasons, but body removal is itself a permanent public chain entry — there is no silent deletion.

## What this is **not**

- It is **not a production service.** No SLA. The site may be slow, broken, or down at any time. We may take it down permanently with no notice.
- It is **not a moderated forum.** Moderation is best-effort by a single operator. Don't assume bad content gets removed quickly.
- It is **not anonymous to law enforcement.** Posts are anonymous to other visitors, but we keep `ip_hash` provenance for abuse detection. A court order can in principle compel disclosure of what we have. Our 7-day salt rotation limits how far back this goes.

## What you may post

- Your own opinions, experiences, and observations.
- Factual claims you can stand behind.
- Questions, replies, discussions.

## What you may not post

- **Illegal content** under the laws of Finland (where the server is hosted), the EU, or your own jurisdiction. This includes but is not limited to: child sexual abuse material; content that incites violence; criminal copyright infringement; threats of violence against identifiable individuals.
- **Doxing** — deliberately publishing identifying information (home address, phone number, place of work where the person hasn't put it themselves) of any private individual.
- **Targeted harassment** — repeated posts attacking the same individual.
- **Impersonation** — posting in a way that falsely claims to be a specific real person or organization.
- **Spam** — automated posting, mass-identical posts, link spam, advertising.
- **Personal data of identifiable third parties** beyond what's necessary to make a substantive point. Saying "Prof. X at University Y was hostile to my research direction" is fine; posting Prof. X's home phone number is not.

If you violate these terms, we may erase your body (per the erasure flow in `privacy.md`) without notice. Repeat offenders' `ip_hash` ranges may be rate-limited or blocked.

## Your responsibilities

- **You are responsible for what you post.** The operator does not pre-screen posts.
- **You should assume your post is permanent.** Even though we can erase the body, anyone could have downloaded a copy of the data before erasure. Don't post things you wouldn't be comfortable with persisting publicly forever.
- **Don't rely on us for anything important.** Back up anything you care about elsewhere. We may take the site down at any time.

## Our responsibilities

- We will operate the chain protocol honestly: we do not silently edit or delete entries. The hash chain plus public HuggingFace mirror make any retroactive change detectable by anyone who has a snapshot.
- We will respond to erasure requests in good faith with a target SLA of 7 days, per `privacy.md`.
- We will publish a moderation log at `/p/<slug>/moderation` showing every body erasure and dismissal, with reasons.
- We will not sell data we collect, run trackers, or share data with third parties beyond what's described in `privacy.md`.

## Disputes

The site is operated from Finland. To the maximum extent permitted by law, you agree that:

- The site is provided "as is" with no warranties of any kind.
- The operator's total liability for any claim related to your use of the site is capped at €0.
- Any disputes that can't be resolved by emailing the operator first will be resolved in the courts of Finland.

This clause is intentionally simple. We are not running a business; we are not insured; we have no resources for litigation. If you might want to sue us for something, please reconsider, or at minimum email us first — we will probably just do whatever you ask.

## Changes to these terms

If we update these terms, we'll change the "Last updated" date and post a `kind="moderation"` entry on `/p/about` describing the change. Material changes also get a GitHub release note.

## Contact

See [`./contact.md`](./contact.md).
