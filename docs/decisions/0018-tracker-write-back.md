# ADR 0018 — Tracker write-back, opt-in and confirmed per ticket

Date: 2026-10-11 · Status: accepted · Amends [ADR 0011](0011-tracker-sync-and-two-way.md)

## Context

ADR 0011 made tracker sync read-only. Owners still copy each Quill status change into Jira, GitHub or Linear by hand, and that copy is the step most often forgotten. A tracker is a shared system, though: a write is seen by teammates, can trigger their automations, and cannot be taken back quietly. So writing back has to be something the owner chooses for one ticket at a time, after seeing exactly what will be sent.

## Decision

- **Off by default, on only in the user's config.** `write_back = true` in the `[tracker]` table of `config.toml` enables it. A repository's `.quill.toml` cannot turn it on or change where a status goes; the command reads only the user config.
- **One ticket, previewed, then confirmed.** `quill tracker push <KEY>` reads the issue and shows its current status, the target and any comment, and sends nothing. The same command with `--confirm` sends it. Nothing in the worker, a schedule, a hook or an agent recipe calls the write methods.
- **What it writes.** One status change and, with `--comment`, one comment (at most 4,000 characters), on the issue the ticket is linked to on the configured tracker (the same link rule as sync). Jira: the transition whose destination has the target name. GitHub: issue state `open` or `closed`. Linear: the team workflow state with the target name. If no transition leads there, the command lists the ones that do and sends nothing.
- **Which status.** `--to "<remote status>"` names it. Otherwise `[tracker.status_map]` maps Quill statuses to remote names, falling back to defaults: Jira `To Do`, `In Progress`, `In Review`, `Done`; Linear `Todo`, `In Progress`, `In Review`, `Done`; GitHub `closed` for done and `open` otherwise. Blocked and deploy-pending have no default on Jira and Linear.
- **Journaled.** Each confirmed push, and each failure, is a `tracker-push` event: a timeline entry on the ticket ("Pushed status In Progress → Done to jira PROJ-7"), and, on success, the recorded remote status. The ticket's own fields and revision do not change.
- **Same credentials and limits as sync.** The token comes from `sync_token_env` (or the system default), redirects are refused, each call times out after 15 seconds and errors never include the token. The token needs write scope; a read-only token fails with the tracker's HTTP status.

## Consequences

- Owners who never set `write_back` see no change.
- A push is one explicit command per ticket, so bulk changes stay manual. That is deliberate for now; a confirmed batch can come later if it is asked for.
- Remote automations (Jira post-functions, GitHub workflows) run on the owner's push like on any manual change.

## Alternatives considered

- **Push automatically on every status change.** Rejected: a write to a shared system needs the owner's decision each time, and a mistaken or retried status change would reach teammates.
- **A dashboard button.** Deferred: the dashboard has no confirm-with-preview flow for remote writes yet, and the CLI preview is the clearest place to show what will be sent.
