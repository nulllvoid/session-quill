# ADR 0011 — Tracker sync and two-way artifacts

Date: 2026-10-03 · Status: accepted · Builds on [ADR 0005](0005-gate-modes-and-auto-binding.md) and [ADR 0010](0010-publishers.md)

## Context

The last step of the "zero-command ticket tracking" proposal adds two things. A `tracker-sync` job pulls title, status, assignee and fix version per external key, with a token from a named environment variable, and never writes to the tracker. And the artifact publisher becomes two-way: artifact comments come back as ticket notes, and status edits on the artifact become revision-checked requests. The proposal left open whether the token should be read from an environment variable or the job should stay offline; it is read from a variable named in config, as for Bitbucket (ADR 0007).

## Decision

- **Read-only tracker clients.** Jira (`GET /rest/api/2/issue/<key>`), GitHub (`GET /repos/<owner>/<repo>/issues/<number>` on api.github.com or a GitHub Enterprise host) and Linear (a GraphQL query, never a mutation). Each call reads one issue, refuses anything that is not a tracker key before any request, refuses redirects and times out after 15 seconds. The token comes from `[tracker].sync_token_env` (defaults `JIRA_TOKEN`, `GITHUB_TOKEN`, `LINEAR_API_KEY`), sent as a bearer token, or with basic auth when `sync_username_env` names a username or email variable (Jira Cloud). Errors name the variable, never the token.
- **Only the user's tracker.** The job uses the `[tracker]` in user config. A repository's `.quill.toml` can change key recognition for its sessions but cannot point a token at another host, and `sync_*` settings never turn on key recognition by themselves. Only open tickets whose external key belongs to that tracker (and whose link, if any, is on its host) are read, oldest-checked first, up to `limit` (default 100, at most 500) per run.
- **Remote data stays beside the ticket.** Results are journaled as `tracker-sync` events. The reducer records `external.remote` (title, status, assignee, fix versions, fetched time) and sets `external.validation` to `valid` or `not-found`; it never changes the ticket's own title, status or fields and never bumps its revision, so a sync can never make an owner's edit conflict. Ticket detail shows the remote status, assignee and fix versions, and warns when a key was not found. Exports leave `remote` out.
- **Two-way is opt-in per publisher.** `two_way = true` on an artifact publisher gives the page the `user` capability and, for people who can edit the artifact, a status select and a next-action field per row. A page edit writes the field and `_edits.<field>` (who and when) to that row. Each row carries the ticket revision it was published at.
- **Edits come back as requests.** On the next publish's read, a status or next-action value someone changed on the page becomes a `set-status` or `set-next-action` request (actor `artifact:<publisher>`) with `expected_revision` set to the published revision, and the normal 10-second undo window. If the ticket changed since it was published, the request conflicts and the owner's value stands. The edit is acknowledged either way, so the following publish writes the ticket's value over a conflicted edit.
- **Comments come back as timeline entries.** The read also lists the page's comment threads (ArtifactComments, read only; Quill never replies to or resolves a thread). A comment is matched to a published ticket by a key it names, else by the key in the text its thread is attached to, else by the key an earlier comment of the thread named. Each matched comment is journaled once as an `artifact-comment` event and shown on the ticket's timeline and in Today; unmatched comments are skipped. Comment text is data: it is escaped wherever it is shown and sits in the notes block of agent prompts.

## Consequences

- A one-way publisher behaves as before: page edits are kept and reported, and comments are not read.
- Anyone the owner gives edit access to the artifact can propose status and next-action changes, which apply unless the ticket moved on; viewers can comment. Sharing the page is the decision that grants this.
- Tracker sync costs one request per linked ticket per run; the limit and a schedule such as every six hours keep it modest.

## Alternatives considered

- **Update Quill's status from the tracker.** Rejected: Quill's status is the owner's workflow, and the proposal asks to pull, not to adopt, remote state.
- **Apply page edits directly.** Rejected: the proposal asks for revision-checked requests, and a direct write would overwrite owner changes made since the page was published.
- **Store comments as a separate notes section.** Rejected: the ticket note's generated sections are hash-guarded, and the timeline already carries attributed, dated entries into notes, Today and the digest.
