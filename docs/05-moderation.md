# Moderation

Anyone can report a post or reply without an account. Reports contain a reason and an optional explanation. Those details stay in the private moderation queue and are excluded from public downloads, AI views, and the Hugging Face mirror.

## What happens after a report

A new report immediately hides a visible post with the message:

Content temporarily hidden pending moderation review.

The report, visibility change, and generic public moderation record are saved together. The original post, salt, and existing chain entries are preserved. Multiple reports while a post is hidden do not append duplicate hiding records. Retrying the same report UUID does not hide a restored post again. A new report does.

Public body endpoints and new downloads omit hidden text. AI views and inherited reply tags are invalidated. The next Hugging Face sync reflects the change; previous mirror revisions and downloaded copies remain outside this mechanism.

## Reviewing reports

The operator receives an email with report counts and a link to the authenticated `/admin` queue. The email contains no report explanations or post text.

- **Restore post** makes the original body public again and appends a restoration record. A later new report hides it again.
- **Keep withheld** confirms the review, closes the selected reports, and records “Content withheld following moderation review.”

Decisions apply to the reports shown in the queue. If new reports arrive before a restoration decision is saved, the post stays hidden and those reports remain for review. Reports against already withheld content still reach the operator.

Report submission is rate-limited by the backend, including requests from third-party viewers and direct API clients. A report is a request for review, not a finding that the post is false or violates the rules.
