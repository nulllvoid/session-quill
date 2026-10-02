# ADR 0009 — Per-environment deployments, Today and the daily digest

Date: 2026-10-03 · Status: accepted · Builds on [ADR 0007](0007-schedules-and-bitbucket.md) and [ADR 0008](0008-agent-recipes.md)

## Context

Deployment obligations were already one per merged PR and environment, but environments came only from each repository's `deployment_environments` (default `production`), evidence was free text, and the Deployments view listed obligations one by one. The "zero-command ticket tracking" proposal asks for environments from config, each ticket showing pending / done / n-a per environment with its evidence (a merge, a values-file tag bump, an ArgoCD sync), done tickets staying on Deployments until each obligation is confirmed or waived, a Today view (a day-by-day feed of sessions, commits, PRs, deployments and status changes, grouped by ticket) whose data also feeds a daily digest, and Pick next weighing pending deployments and days since last touch.

## Decision

- **Environments from config.** `[tracker].environments` (up to ten lowercase names, in user config or a repository's `.quill.toml`) lists the environments for repositories that do not set their own `deployment_environments`. A repository's own list wins, then the repository's tracker, then the user's tracker, then `production`. `quill init` no longer writes `deployment_environments = ["production"]`, so new repositories follow the tracker; existing entries keep working as written.
- **Obligations are journaled with their environments.** A reconcile event's merged-PR update carries the effective environment list, and the reducer creates one obligation per entry. Replay therefore rebuilds the same obligations even after the config changes. Events journaled before this change fall back to the repository list, as before.
- **Evidence kinds.** A recorded deployment has `evidence_kind`: `merge`, `tag` (values-file or manifest tag bump), `argocd`, `release`, `manual` (the default) or `agent` (an accepted recipe suggestion). The record dialog asks for it.
- **Per-environment status.** Each ticket in the snapshot carries `environments[]`: for every configured environment (plus any environment that only appears on an obligation), `pending` if any obligation is pending, otherwise `done` with the latest deployment's time and evidence, otherwise `n-a` when every obligation was waived (the UI labels waivers N/A), otherwise `none`. Deployments shows each ticket with outstanding work as a PR-by-environment matrix with the evidence in each cell; a done ticket stays until nothing is pending.
- **Today.** The worker builds a feed of the last seven days in the store's time zone: per day, the tickets with activity (newest activity first), counts per kind and up to twelve items each, plus the number of sessions started. Tool calls are left out as noise. It is a sixth view (shortcut 6) and is never exported.
- **Digest.** A `digest` job in `[[schedule]]` writes one day (`day = "today"` or `"yesterday"`) of that feed as markdown to `to = ["vault-daily"]` (the store's `daily/YYYY-MM-DD.md`) and/or `"file"` with a `path`. It writes only between `<!-- quill:digest:start -->` and `<!-- quill:digest:end -->`, keeps everything else, and records a hash of what it wrote; if the section was edited since, the run fails with `digest-conflict` instead of overwriting. A Slack draft target is not provided.
- **Pick next.** A merged PR awaiting deployment now earns 10 points as soon as it merges (20 from two days, as before), and a ticket untouched for two or more days earns one point per day until the stale flag's 10 points take over.

## Consequences

- Repositories configured before this change keep their explicit `["production"]` until the owner removes it; the README says so.
- The snapshot grows by the Today feed and per-ticket environment status; publish time at 2,000 tickets went from about 20 ms to about 30 ms in the scaled performance test.
- Exports include per-environment status only with the deployments field, with evidence text omitted unless links are included, like obligations.

## Alternatives considered

- **Ticket-level "not applicable" environments.** Rejected for now: a waiver with a reason already records it per obligation and is what the deploy-check recipe produces.
- **Computing Today in the browser.** Rejected: the snapshot carries only the last 20 timeline entries per ticket, and the digest needs the same data on the worker.
- **Overwriting the daily note.** Rejected: the store is the owner's notes; a generated section that someone edited is theirs.
