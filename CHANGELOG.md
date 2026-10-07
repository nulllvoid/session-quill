# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Recipe runs see much more of their ticket ([ADR 0013](docs/decisions/0013-recipe-context-and-reply-contract.md)): the owner's Notes section (previously never sent), the full latest approved plan and checkpoint instead of previews, and three new inputs: `work` (files touched, commits and, with source access, their diff), `related` (parent, siblings, children) and `history` (earlier runs and how their suggestions were decided).
- Every run follows a stated method and evidence rule, and its reply adds `confidence` and `sources`, shown on the run in ticket detail. The built-in recipes were rewritten as step-by-step instructions with a quality bar.
- A reply that breaks the output contract gets one repair turn in the same session; a recipe with `self_check: true` (`attempt-fix`, `deploy-check`) verifies each claim against its source in a read-only follow-up turn.

### Fixed

- Built-in handoff runs applied their next action almost never: the agent's own tool calls are recorded on the ticket and moved its revision, so the result was always treated as a conflict. A run now conflicts only when the next action itself changed after it was queued.
- The recipe Run dialog offered "Open a draft PR" for a repository without a PR provider, which the worker then refused; the option is now disabled with the reason, as in the handoff form.

### Changed

- The agent runtime receives its prompt on stdin, so large prompts no longer hit the Windows command-line limit.

## [0.2.0] - 2026-10-07

### Added

- `quill ticket set <KEY>` edits title, status and blocker, next action, priority, category, due, parent and repository after creation or migration, as one revision-checked update; `none` clears due, parent and repository ([#4](https://github.com/nulllvoid/session-quill/issues/4)).
- `quill repo add <path>`, `quill repo list` and `quill repo remove <id>` register repositories without re-running `init`: a git work tree is required, the id comes from the folder, the default branch is detected, `.quill.toml` is written only with `--repo-file`, and a running worker picks up additions and removals. `quill doctor` warns about repositories whose path is gone or isn't a git work tree ([#5](https://github.com/nulllvoid/session-quill/issues/5)).
- Migration profiles accept a list of candidate names per field, a `repo` field mapped to registered repositories, and `ignore_globs` (default `templates/**`); the bundled profile also reads `key`, `next` and `pri` and maps `progress` to active. `--profile <path.json>` is documented ([#3](https://github.com/nulllvoid/session-quill/issues/3)).

### Fixed

- Dashboard review fixes: the ticket drawer opens at its title, closes on view switch without rewriting the URL, keeps close/previous/next pinned on phones, and shows the next action once with an Edit button; a tracker key that was not found is one chip that relinks. Provider errors collapse into one plain-language chip with details on demand, and Refresh sits on the health line. Pick next cards show one reason with the score breakdown in a tooltip, and equal scores rank the longest deployment wait first. Blocked work groups by project and collapses behind Show all; unlinked work and the Sessions table lead with the session title. Deployments says Waive instead of N/A.
- Prompt-derived titles no longer keep harness markup such as `<scheduled-task …>`; slash commands read as the command and its arguments.

- `quill migrate` no longer drops notes that share a key: the note named after the key (else the newest) is kept and the others import as its children (`KEY.1`, `KEY.2`). The dry run lists duplicate keys and warns when no tracker keys were found, and the summary counts only applied events, names rejected notes and exits non-zero ([#2](https://github.com/nulllvoid/session-quill/issues/2)).
- `quill init` refuses a folder that isn't a git work tree unless `--force`, detects the default branch, and gives a second repository of a project its own id instead of overwriting the first ([#5](https://github.com/nulllvoid/session-quill/issues/5)).

### Changed

- Dashboard redesign, "Graphite Ink" ([docs/ui/graphite_ink/DESIGN.md](docs/ui/graphite_ink/DESIGN.md)): warm graphite neutrals with one highlighter accent, vendored Geist and Geist Mono variable fonts, hairline separation instead of nested boxes, a floating top bar with a single status line, the brand and workspace details in the sidebar, a framed top Pick next candidate, board cards without the redundant status chip, a loading skeleton, and entry motion that plays once and respects reduced motion. Light and dark tokens still meet WCAG AA.

### Added

- A plugin marketplace manifest: install with `claude plugin marketplace add nulllvoid/session-quill` and `claude plugin install session-quill@session-quill`. The README install steps and a new example walkthrough cover recipes, deployments, Today, publishing and tracker sync.
- Tracker sync ([ADR 0011](docs/decisions/0011-tracker-sync-and-two-way.md)): a `tracker-sync` schedule job reads title, status, assignee and fix versions for linked tickets from Jira, GitHub or Linear with a token from a named environment variable, validates keys, and never writes to the tracker or changes Quill's own fields.
- Two-way artifacts: with `two_way = true`, editors change status and next action on the live page, and the next publish turns each change into a revision-checked request; page comments that name a ticket join its timeline. Acceptance scenarios A65–A68.

- Publishers ([ADR 0010](docs/decisions/0010-publishers.md)): `[[publish]]` entries publish a markdown roll-up note, a read-only HTML copy, or a live claude.ai artifact whose rows update with version-pinned writes that keep edits made on the page. Every destination needs a one-time confirmation. Publish on demand (header Publish dialog, `quill publish`, `/session-quill:publish`), after reconciliation, or as a `publish` schedule job; acceptance scenarios A61–A64.

- Per-environment deployments ([ADR 0009](docs/decisions/0009-environments-and-today.md)): `[tracker].environments` lists environments for repositories without their own; each ticket shows pending, done or N/A per environment with its evidence kind (tag bump, ArgoCD sync, release, merge, manual, agent); Deployments is a PR by environment matrix.
- Today view (sixth tab, shortcut 6): the last seven days by store-local day and ticket. The `digest` schedule job writes a day of it into the store's daily note or a file, never over an edited section.
- Pick next adds points for a fresh merge awaiting deployment and for days since last touch; acceptance scenarios A57–A60.

- Agent recipes ([ADR 0008](docs/decisions/0008-agent-recipes.md)): Markdown recipes with frontmatter in `.quill/agents/` (repository), `~/.claude/quill/agents/` (personal) or built in. The three handoff modes are now recipe files, and `deploy-check` and `standup` ship beside them. Frontmatter permissions are a ceiling, tools only narrow them, each recipe has its own time cap, and a recipe edited after a run was queued fails that run instead of running unreviewed.
- Typed recipe outputs (next action, blocker, follow-ups, deployment evidence, comment draft) arrive as suggestions you accept or dismiss (request kinds `accept-suggestion`, `dismiss-suggestion`); a comment draft is never posted.
- Agents panel on ticket detail, `quill agent list|show|run|suggestions|accept|dismiss`, `/session-quill:agent`, and the `agent` schedule job for read-only runs over a ticket scope; acceptance scenarios A53–A56.

- Schedules ([ADR 0007](docs/decisions/0007-schedules-and-bitbucket.md)): `[[schedule]]` tables in user config run named jobs on cron (store time zone) or interval schedules. Missed slots catch up once, each job runs one at a time, every run is journaled, and an unfinished run is marked interrupted and reruns once on restart. Reconciliation now runs as the `reconcile` job; the default stays every two hours.
- Schedules panel in the dashboard header with next and last runs, recent history and Run now (request kind `run-job`).
- Bitbucket Cloud and Server/Data Center PR provider (`provider = "bitbucket"`, `provider_url`, `token_env`, `username_env`). Tokens come from environment variables and are sent only to the configured host.
- The configuration parser accepts top-level TOML array tables (`[[schedule]]`).
- CI publishes failing tests, including test files that crash while loading, as check annotations readable without signing in; acceptance scenarios A49–A52.

- Unlinked work inbox on Pick next ([ADR 0006](docs/decisions/0006-unlinked-work-inbox.md)): files and commits captured while a session had no ticket are kept on the session and can be attached to a ticket, attached to a ticket created from its key, or dismissed. Each action is revision-checked and has the 10-second undo window.
- External key chips: tracker keys open their ticket in a new tab and have a copy button; local keys offer "Link to external…" (request kind `link-external`).
- Request kinds `attach-unbound`, `dismiss-unbound` and `link-external`; acceptance scenarios A46–A48.
- Empty states suggest mentioning a ticket key, using the configured prefix.

- Zero-command tracking ([ADR 0005](docs/decisions/0005-gate-modes-and-auto-binding.md)): a configured ticket key in a prompt or in the branch name links the session, creating the ticket under that key when needed.
- `[tracker]` configuration (`system`, `domain`, `url_template`, `key_pattern`, `prefixes`, `sources`, `on_new_key`) in user config or a repository's `.quill.toml`, with validated patterns and bounded scans.
- Gate modes `off`, `nudge` and `strict`; `nudge` asks once at the end of a turn about unlinked work instead of denying mid-task.
- `ticket relink --external <KEY> [--system s] [--url https://...]` and a ticket `external` field for any tracker.
- Acceptance scenarios A42–A45.

### Changed

- `quill init` no longer writes `deployment_environments = ["production"]` for a new repository, so `[tracker].environments` applies; production remains the fallback.
- A `job = "digest"` schedule, accepted and skipped by earlier versions, now runs and writes into the store's `daily/` folder by default.
- The default gate mode is `nudge`. Set `[gate] mode = "strict"` for the v0.1 deny-until-bound behaviour. A repository can tighten the mode but never loosen it.
- `ticket relink --jira` is now an alias of `--external` with `system = jira`; links may be any https URL.
- Sessions started before `quill init` learn their session id on the first prompt.
- The `.quill.toml` parser accepts single-quoted literal strings.

### Security

- Handoff and recipe agents can no longer use git read commands to write or read outside their checkout. Session Quill no longer passes allow rules for `git log`, `git show`, `git diff` or `git status`, because those rules approved options like `git log --output=<path>` before Claude Code's own read-only check could see them. Those commands now go through that check, which refuses `--output`, `--ext-diff`, `--textconv` and `--no-index` in any spelling. Deny rules for the literal forms back it up, and the agent's environment no longer carries `GIT_EXTERNAL_DIFF` or `GIT_CONFIG_*` overrides. See [TRD §Handoff execution](docs/TRD.md#handoff-execution) for what is and is not enforced.

## [0.1.0] - 2026-10-02

First implementation of the v0.2 design (PRD, TRD, data contract, UI specification, acceptance scenarios).

### Added

- Ticket gate on Claude Code hooks: supported write tools, unknown shell commands and unregistered tools are denied until the session is bound; dedicated reads and a tested read-only shell subset pass through; per-session gate off/on with audit.
- Durable capture: ingress files persisted before acknowledgement, fsync'd JSONL journal, content-addressed blobs, torn-tail quarantine, duplicate suppression and deterministic replay.
- Single-writer worker with an OS-released ownership lock, 30-second note materialization, binding snapshots for hooks, health heartbeat and incremental projections.
- Markdown/Obsidian notes with hash-guarded generated sections; authored Summary and Notes preserved byte for byte; unrecognized or edited generated content becomes an explicit conflict with `quill note restore` and `quill import`.
- CLI: `init`, `ticket` (create/bind/show/off/on/relink/list/children), `approve`, `dismiss`, `status` (including status-line mode), `doctor`, `worker`, `sync`, `replay`, `import`, `note`, `ui`, `export`, `handoff`, `migrate`, `hook`.
- Deterministic reconciliation every two hours with catch-up on start, session lifecycle (live/idle/ended/extinct), stale derivation, pick-next ranking with explained scores, GitHub PR polling through `gh`, deployment obligations per environment.
- Loopback dashboard API with one-use bootstrap secrets, HttpOnly SameSite cookies, CSRF and Origin/Host checks, generation-consistent detail endpoints, and revision-checked mutation requests with a 10-second undo window, conflicts, cancellation and crash recovery.
- Dashboard UI (Pick next, Board, Tree, Sessions, Deployments, ticket detail, handoff form, export dialog) in the Terminal Slate visual system with light and dark themes meeting measured WCAG AA contrast, keyboard shortcuts and responsive layouts from 390 px up.
- Read-only standalone HTML export with field and project selection, exact preview and privacy sanitization.
- Agent handoffs (analyse, analyse with follow-ups, attempt fix) in isolated Git worktrees with explicit permissions, a 20-minute wall-clock cap, cancellation, interrupted-run recovery and redelivery-safe child tickets.
- Migration framework with dry run, backups, replayable migration events, a PMLA profile and rollback.
- Plugin packaging: manifest, exec-form hooks, namespaced commands, handoff agent, status-line script.
- Acceptance suite mirroring `docs/ACCEPTANCE.md` and a results record with performance measurements (hook p95 1.7 ms at 10,000 tickets / 100,000 events).

### Changed

- Project renamed from Session Tracker to Session Quill (`/session-quill:*`, `bin/quill.js`, `~/.claude/quill`, `.quill.toml`).

### Security

- The gate fails closed for every covered tool on malformed hook input, internal errors or capture failure.
- Reducer exceptions are contained and recorded instead of becoming replay poison pills.
- Export redaction covers any absolute path; handoff agents get test-runner-only shell access and no provider tokens unless push/PR permission is granted.
- Plan-mode file exception limited to the first `Write` of a Markdown file directly inside the plan directory (ADR 0004).

[Unreleased]: https://github.com/nulllvoid/session-quill/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nulllvoid/session-quill/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nulllvoid/session-quill/releases/tag/v0.1.0
