# ADR 0007 — Schedules and the Bitbucket provider

Date: 2026-10-03 · Status: accepted · Builds on [ADR 0005](0005-gate-modes-and-auto-binding.md) and [ADR 0006](0006-unlinked-work-inbox.md)

## Context

Reconciliation ran on one fixed two-hour timer inside its extension, and PR state came only from GitHub through `gh`. The "zero-command ticket tracking" proposal moves recurring work into named jobs the worker runs (reconcile now; digest, publish, agent and tracker sync later) and asks for a Bitbucket provider next to GitHub. Its rules: hooks stay offline, a missed run catches up once, one run per job at a time, and every run is a journal event visible in the UI and in replay.

## Decision

- **`[[schedule]]` in user config only.** Each entry has a `name`, a `job` and exactly one of `cron` (five fields, evaluated in the store's IANA time zone) or `every` (`30m`, `2h`, `1d`), plus optional `enabled = false`. A repository `.quill.toml` cannot schedule worker jobs. With no `[[schedule]]`, `reconcile` runs every `sync_interval_hours`, exactly as before.
- **Dependency-free cron.** Lists, ranges, steps and month/day names are supported, and day-of-month and day-of-week combine with OR as in standard cron. Wall times that do not exist on a DST change are skipped. An expression that never fires is rejected.
- **One scheduler, journaled runs.** A worker extension replaces the reconcile timer. Every run emits `schedule-run` events (started, then finished with `ok`, `failed` or `interrupted`, a summary and an error). The reducer keeps the last 20 runs per schedule. A run left unfinished by a crash or stop is marked `interrupted` on the next start. Each job runs at most once at a time; triggers that arrive during a run wait for it and join the next one.
- **Catch-up once.** An interval schedule that has never run is due at start. Otherwise the next run follows the last start, so any number of missed slots collapse into one `catch-up` run, and the next run is the next future slot.
- **Run now.** A `run-job` request names a schedule and has no undo delay. `refresh` stays as "run reconcile now". Unknown names are refused before the queue.
- **Planned jobs are accepted, not run.** `stale-sweep`, `digest`, `publish`, `agent` and `tracker-sync` in config produce a warning and are skipped, so later releases need no config migration.
- **Bitbucket Cloud and Server/Data Center.** A repository with `provider = "bitbucket"` is polled over REST: Cloud at `api.bitbucket.org`, or Server at the configured `provider_url`. The token comes from the environment variable named by `token_env` (default `BITBUCKET_TOKEN`). It is sent as a bearer token, or with basic auth when `username_env` names a username variable. It goes only to that host, never to a host taken from a PR link, and redirects are refused. Errors name the variable, never the token.

## Consequences

- The header gains a Schedules panel with next and last runs, recent history and Run now. `meta.next_sync_due` follows the reconcile schedule.
- Editing `[[schedule]]` in `config.toml` applies within about 10 seconds without restarting the worker, like the tracker and gate settings.
- Bitbucket Cloud reports no merge timestamp, so a merged PR's last update time stands in for it. Server/Data Center reports the real close time.
- Scheduled cloud agents (work that must run while the laptop is off) are left for a later step.

## Alternatives considered

- **A cron library.** Rejected: the project uses Node built-ins only, and five-field cron with `Intl` time zones is small enough to own and test.
- **Repository-defined schedules.** Rejected: schedules run network jobs on the owner's machine, which a repository should not decide.
- **A Bitbucket CLI like `gh`.** Rejected: there is no standard one; REST with a scoped token is simpler to audit.
