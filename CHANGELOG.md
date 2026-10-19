# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-19

Autonomous runs: an agent run can use your connected tools and read production like your own Claude Code session would. It still cannot change production unless you grant a write scope or approve an exact change. Runs leave what they learned for the next run. See [ADR 0026](docs/decisions/0026-autonomous-access-and-guard.md), [ADR 0027](docs/decisions/0027-run-memory.md), [ADR 0028](docs/decisions/0028-critical-changes.md) and README "Autonomous runs".

### Added

- **Autonomous access** (`access: autonomous`): every tool and connector. A per-run guard (`bin/quill-guard.js`, a PreToolUse hook with `onFailure: block` under `dontAsk` and an empty allow list) decides each call against a frozen, hashed `grant.json`. It covers:
  - readable and writable roots, with links resolved;
  - the per-run permissions (commit, push, draft PR, protected branches);
  - Quill's own CLI, which a run may only read;
  - MCP server trust by source (`[handoff] trusted_mcp_servers`) and read/write verbs (`[mcp_policy]` overrides);
  - production CLIs by verb; network writes (`external.write`); write scopes; action pins.

  Refusals reach the agent as `QUILL_CRITICAL_CHANGE scope=… target=…: …` or `QUILL_DENIED <reason>: …`. Autonomous needs Claude Code 2.1.295 or later (`runtime-too-old`).
- **Credential isolation**: Kubernetes, AWS, Google Cloud, Azure, databases, Argo CD, git (helper, ssh, gh, glab), netrc, npm and Docker credentials point at read-only profiles (`[prod.readonly]`) or empty stubs in the run directory. Other secret-looking variables are removed unless they are listed in `[handoff] keep_env`. Each run records a credential report, and the Run dialog shows it with warnings.
- **Write scopes**: `jira.write`, `confluence.write`, `slack.post`, `k8s.write:<context>`, `argo.sync:<app>`, `cloud.write:<target>`, `db.write:<target>`, `deploy:<target>`, `http.write:<host>` and `package.publish`, plus your own MCP-only `[scopes."<name>"]`. You grant them per run in the Run dialog (Advanced → Write scopes) or with `--scope`. A granted scope switches to its own credentials. A shell write is covered only by a strict per-tool allow-list with one exact target.
- **Full access is observed**: the guard runs in observe mode, never refuses, and records production writes as `prod_effects`. Run detail shows them as *Production writes (full access)*.
- **Run method and result contract**: every recipe gets a METHOD: plan, try at least two routes, verify, record critical changes, record learnings. The run's result may carry `stage_reached`, `plan`, `attempts`, `verification`, `critical_changes` and `learnings`, with caps. Results come from stream-json's final result event only. A redacted tool ledger is reconciled with the agent's claimed attempts.
- **Budgets**: per-run turn caps (80, fix runs 150; repair 4; self-check 20), wall clock up to 60 min (30 for autonomous), `max_budget_usd` (10) and `max_batch_budget_usd` (30). They are set in `[handoff]`, in recipe frontmatter (`max_turns`, `max_budget_usd`) or per run (`--max-turns`, `--budget`). A batch that reaches its spend budget starts no further member and shows *Batch budget reached*.
- **Recorded stage**: the worker's own record (tested, committed, pushed, PR opened) beside the agent's claim. Turns and cost are recorded, and the cost is marked *estimated* under a subscription.
- **Run memory**: journaled `memory-tx` events and projections under `~/.claude/quill/memory/`.
  - Filing by provenance: verified, sourced, observed or quarantined. Instruction-like text is always quarantined.
  - Delivery: up to 48 KB of ranked memory goes into the prompt, and the rest goes into the run's `context/` folder.
  - Each ticket gets local Run notes.
  - The owner-only **Memory** page (Track, shortcut 8) offers Approve, Edit, Pin and Retire.
  - `quill memory list|show|note|pin|retire`.
  - Quarantined learnings and memory conflicts appear in Runs → Needs you.
- **Critical changes**: a write a run was refused becomes a local-only child ticket and a run-origin proposal with an exact action pin. **Approve and queue (scopes: …)** on the dashboard queues one run of the new built-in `critical-change` recipe, which may perform exactly that action. A change that cannot be pinned is listed on the run with the reason.
- **Run detail** sections: Recorded stage, Plan, Attempts, Verification, Critical changes, Production writes (full access), Learnings filed, Tools used, Turns & cost. The ticket Runs tab shows Run notes. Access badges read "Autonomous", "Autonomous + scopes (n)" and "Full access".
- **Resume as new run** (and `quill agent resume <run-id>`) continues an interrupted run's Claude Code session in a new run with the same access and limits. The interrupted run's guard-allowed writes are listed as "may have run".
- The Run dialog lists "Connected tools this run can use" from the latest run's inventory, and each production CLI's credential state.
- The built-in `verify-deploy` recipe checks post-deploy health read-only (Argo CD sync and health, Kibana error rates).
- Recipe frontmatter: `max_turns`, `max_budget_usd`, `requires` and `quill_min_version`. Keys starting with `x-` are ignored.
- Each run gets a map of the repository's documentation: entry docs, `docs/**/*.md` and runbooks, with their titles and headings.
- New request kinds: `memory-approve`, `memory-edit`, `memory-forget`, `memory-pin`, `memory-note` and `resume-run`. New events: `memory-tx` and `critical-proposal`. Every new field and error code is listed in DATA-CONTRACT, section "Autonomous runs index (1.1.0)".

### Changed

- New runs from the dashboard, the bulk dialog, `quill agent run` and `quill handoff` default to **Autonomous** (they used your Claude Code settings). "Use my Claude Code settings" moved under Advanced. Schedules, page proposals and `file-task` stay Standard. A queued run keeps the access it was recorded with.
- Built-in recipes gained "Definition of done" lines. `attempt-fix` no longer stops at the first blocker. `deploy-check` names the Argo CD and Kibana read routes. Built-in recipe hashes changed.
- The default wall clock is 30 minutes for autonomous runs and stays 20 otherwise. Recipes may set up to 60. `quill agent list`, `show` and the install preview print the cap a run actually gets, not the recipe's raw `timeout_min`.
- Run worktrees, run directories and context snapshots are removed when a run ends. Fix checkouts are kept 7 days. Ledgers and logs are kept `[handoff] log_retention_days` (30). Logs no longer contain tool results.
- The worktree is based on the ticket's branch when it is known.
- The plugin's own PreToolUse hook only records events inside a guarded run, so each call is decided once.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are removed from autonomous runs unless `[handoff] api_billing = true`, because they would drop claude.ai connectors.
- `quill doctor` warns when Claude Code is older than 2.1.295 or git is older than 2.31.
- `npm test` and `npm run test:acceptance` run in a private temp root that is removed afterwards.

### Fixed

- Runs honour `claude_path`.
- Long scope targets in run detail and in the Needs you critical change item wrap inside the panel instead of running past it.

### Security

- Static exports, the mirror, publisher payloads, tracker push bodies and vault notes use allow-lists. None of the following ever leaves the machine:
  - attempts, learnings, critical changes and their specs, action pins, scope names and targets, the ledger, `prod_effects`, the inventory, the credential report or memory;
  - local-only tickets (with their runs and notes): the daily digest leaves them out entirely, and a session that worked on one keeps no prompt title or final message in its vault note.

  Exports carry only counts, the recorded stage and `scope_count`. A run error about write scopes (`scope-changed`, `scope-credentials-missing`, `unknown-scope` …) reaches exports, the mirror and vault notes with a generic message, never the scope name or target. A sentinel test enforces this.
- Inside any agent run the `quill` CLI refuses every mutating command (`cli-in-run`). Approving a run's critical change, approving or editing memory, and resuming a scoped run are owner dashboard actions only: they are honoured only when the authenticated dashboard server journaled the request, never on an actor claim, so the CLI and ingress requests are refused whatever actor they name (ADR 0026 amends ADR 0017 and ADR 0025; ADR 0028 amends ADR 0025).
- **Ingress cannot speak for the worker.** Event kinds only the worker writes (`request-tx`, `handoff-tx`, `memory-tx`, `reconcile`, `notify`, `schedule-run`, `tracker-sync`, `critical-proposal`) are quarantined when they arrive through ingress, with an `ingress-forged` health problem. In every access level except Full access the guard also protects the Quill home (store, ingress, config, journal, handoffs, memory) and the run's own credential files. Code a run executes that the guard does not follow, such as a script run by name, can still write the Quill home and act with your CLI's power, and in Full access any run code can (ADR 0026, residual 17).
- Repository `.mcp.json` servers, `.claude/` and `.git/` hooks and config, Quill's own guard code and the run's grant cannot be changed by an autonomous run.
- **Git cannot write your repository from a read-only run.** A run checkout is a worktree whose refs, objects, index and config live in your own repository. Without the commit permission a run may use only read-only git (status, log, show, diff, blame, grep, ls-files, rev-parse, branch and tag listings, `remote -v`, `config --get`, `fetch` without a refspec into local branches); `checkout -- <paths>`, `restore`, `clean` and `apply` need edit permission; `update-ref`, `commit-tree`, branch and tag writes, `stash`, `notes`, `replace`, `gc`, `prune`, `reflog expire`, `pull`, ref-moving `checkout`/`switch`/`reset`, `add`, `worktree add|remove` and config writes need commit. A ref write naming the default or a protected branch is always refused (ADR 0026, R58).
- **No nested Claude Code.** A script that starts Claude Code, or any client holding your claude.ai login, can use your connectors without the guard; credential redirection does not cover Claude Code's own login. In every access level except Full access the guard refuses (`QUILL_DENIED nested-claude-code`) every way of starting it that it can see: `claude` or `claude.exe` by any path, `npx`/`pnpm dlx`/`bunx`/`yarn dlx`/`npm exec` of `@anthropic-ai/claude-code`, `node …/@anthropic-ai/claude-code/…`, behind any wrapper or environment prefix, and any call with `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`. Subagents (Task, Agent) keep the guard. Full access may still start Claude Code (ADR 0026).
- **Boundary statement**: the guard is defence in depth. The boundary for production is credential redirection plus server-side read-only credentials. ADR 0026 lists the owner credentials no redirect closes; one example is `ssh` reading `~/.ssh` directly.

### Not done in this release

- **Real end-to-end acceptance is still open.** It needs your read-only credentials in `[prod.readonly]` and the Argo CD and Elastic MCP servers installed. The planned scenarios have not been run against real systems:
  - a run reads Jira, the repository, Argo CD and Kibana;
  - a second run reuses memory;
  - an unscoped run proposes a critical change;
  - the approved run makes exactly that change and is refused another;
  - a full run is not blocked.

  A live recipe-driven check that an autonomous run's production write is refused is also open. kubectl, aws, gcloud, az, argocd, glab and psql were not available to verify against the redirected environment; git and gh were.
- `quill doctor` does not yet report read-only profile health or the tool inventory (spec §4.4, §8); the Run dialog shows both.
- The Run dialog has no turn or spend fields (use `--max-turns` and `--budget`).
- An approved critical run's live phase and verify outcome are not shown on its Needs you item.

## [1.0.0] - 2026-10-11

Orchestration-first 1.0: the dashboard is always reachable, runs can be queued in bulk and are verified by the worker's own test run, assigned issues arrive with their repositories resolved, a shared page can propose (never start) a run, and a Runs page brings dispatch, monitoring and review into one place.

### Added

- **Runs** page (shortcut 7): Needs you, Live, Failed and All, grouped by batch, with run detail showing the result, changed files, worker test gate, PR, uncertain effects and the checkout path. Batch summaries survive a reload.
- A run strip and a Runs tab on every ticket; one **Run agent** dialog with a plain summary of what the run will do and any blockers.
- Always-on dashboard ([ADR 0022](docs/decisions/0022-always-on-dashboard.md)): the dashboard prefers the fixed port 47321 (`ui_port`, falling back to a random port when it is taken; `ui_port = 0` keeps random), and a signed-in browser stays signed in for 7 days from its last use, across worker restarts. Sessions are stored only as hashes. `quill ui --revoke` signs every browser out.
- A browser without a session gets a sign-in page that says to run `/session-quill:ui` (or `quill ui`) instead of a bare error.
- `quill status --statusline` ends with the dashboard address as a clickable link while the worker that serves it is healthy. It never carries a secret.
- `quill worker install` / `quill worker uninstall` register or remove a per-user login entry that runs `quill worker start` once (Task Scheduler on Windows, a LaunchAgent on macOS, a systemd user unit on Linux), with no administrator rights. `quill doctor` and the dashboard's worker health item say when it is installed.
- Runs record `timings` (queue wait, worktree setup, agent time including follow-up turns), shown on each run in the dashboard and in `quill handoff list`.
- A copy button on the dashboard address in the top bar.
- Bulk runs ([ADR 0023](docs/decisions/0023-bulk-runs-and-test-gate.md)): a **Select** mode on Board and Pick next (`x` toggles the focused card, Shift-click selects a range, Esc clears) with a bulk action bar for Analyze, Attempt fix, Change status and Clear. Bulk runs are one request per ticket sharing a `batch_id`, with per-ticket outcomes, a progress strip per batch and **Cancel batch**; bulk status changes undo together with **Undo all**.
- `handoff` requests accept an optional `batch_id`, stored on the run; `quill handoff cancel --batch <id>` cancels a batch's queued runs, and `quill handoff list` shows the batch.
- Worker test gate: with `test_command` (and `test_timeout_ms`, default 10 minutes) on a repository, the worker runs the tests itself after each fix and records `test_gate` and `timings.test_ms` on the run. A failure gets one repair turn with the failing output; a fix whose tests still fail is not suggested (no commit, push or PR). Runs show *Tests passed (worker)*, *Tests failed* with the output, or *Not test-verified*, and draft PR bodies say "Tests passed (worker)" only after a real pass.
- `[handoff] max_concurrent_readonly` (default 2) and `max_concurrent_fix` (default 1) cap read-only and fix runs separately.
- Read-only analyse runs with source access may use Claude Code subagents, and the built-in analyse recipes split large analyses by module and merge the results.
- Onboarding from the tracker ([ADR 0024](docs/decisions/0024-tracker-onboarding.md)): with `[tracker] import_assigned = true`, `tracker-sync` imports the open issues assigned to you (Jira and GitHub) as tickets, once each. `quill tracker import` imports now; `quill init --bootstrap-from-tracker` turns the import on, adds a `tracker-sync` schedule and imports once.
- Rule-based repository resolver: `tracker-sync` links tickets without a repository through `[tracker.repo_map]` (Jira component or project, GitHub `owner/repo`, to a repository id or remote), a registered repository whose origin matches a repository the issue links to, or a clone already on disk. A remote with no clone shows **Needs clone** on the card and in the snapshot's `repo_state`; no agent runs.
- Clone with consent: `quill repo clone <KEY>` previews the remote, host check and target folder, and `--confirm` clones into `[tracker] auto_clone_dir` (default `~/quill-repos`), registers the clone and links the ticket. The dashboard's **Clone…** dialog sends the new `repo-clone` request. Only https and ssh remotes on a `[tracker] clone_hosts` host (default github.com, gitlab.com, bitbucket.org) are cloned, without credentials in the address, file/ext transports or submodules, and a remote that already has a clone is linked instead of cloned again.
- `quill/no-code`: `quill ticket set <KEY> --no-code yes|no` (or `ticket-update` field `no_code`) marks a ticket as needing no repository; it shows **No code** and the resolver skips it.
- The dashboard's Repo filter has a **Needs clone** value, and cards show **Cloning** while a clone runs.
- A read-only built-in `workspace-setup` recipe suggests a repository and a `repo_map` line for a ticket the rules could not place.
- The TOML subset accepts double-quoted keys, so `[tracker.repo_map]` can name `"owner/repo"` and `"PROJ/Component"`.
- Runs proposed from a shared page ([ADR 0025](docs/decisions/0025-remote-run-proposals.md)): `run_agent = true` on a two-way artifact publisher adds a **Run agent** select offering read-only recipes plus `run_recipes`. A pick becomes one proposed run (journaled as `run-proposal`, with an id derived from the edit) naming the editor, recipe and access; nothing runs until you approve it.
- **Proposed runs** in Today and ticket detail with **Approve** and **Dismiss**, a live-region notice and receipt when a page proposes one, and `quill approve --run [<id>]` / `quill dismiss --run <id>`. Approval queues an ordinary suggest-only run through the normal reservation and says so when the ticket already has one; dismissals are journaled. Open proposals lapse after 7 days, or for good once the ticket is done. Every proposal needs the owner: there is no auto-approval (`auto_run_editors` and `auto_run_recipes` from a pre-release build are ignored with a warning), and `/session-quill:approve` is not model-invocable. An approved run's origin is kept as `handoff.proposal` and shown to the agent only as labelled untrusted data, never as the owner's note. A repository recipe that shadows the offered one is refused.

### Changed

- Navigation is grouped into Work and Track; phones show Pick next, Board, Runs, Activity and More.
- The top bar is one row: workspace status, refresh and connection details live in one popover; filters sit behind a Filter button; receipts are toasts, and errors stay until dismissed.
- Proposed runs moved from Activity to Runs → Needs you.
- Form controls have 3:1 borders; dark-mode faint text is a distinct level.
- Put Pick next recommendations before the collapsed unlinked-work inbox, with compact workspace statistics and a recent-context section.
- Group ticket details into Overview, Activity and Delivery, with next action, latest checkpoint and status controls first; add an expanded ticket view and collapsible navigation.
- Consolidate workspace health details, surface pending run approvals in the header, and add direct checkpoint access from Sessions. Rename Today to Activity and Tree to Relationships.
- Improve keyboard focus in modal ticket details and responsive layouts; refresh dashboard screenshots.
- A run that may edit source (`edit_source`) always self-checks its reply, whatever its recipe's `self_check` says.
- At most one run that edits source executes at a time by default (it was any two runs of either kind); set `max_concurrent_fix` to allow more.
- `agent_ms` no longer includes the worker's test runs, which are `test_ms`.

### Fixed

- Full run results and timeline text now display after loading, and failed loads show Retry.
- Sessions → View checkpoints opens the ticket the checkpoint was captured on.
- Static exports bundle every dashboard module; ticket detail and Activity no longer fail in an exported page.
- Onboarding ([ADR 0024](docs/decisions/0024-tracker-onboarding.md)): an assigned issue counts as imported only when a ticket points at that very issue; a key another ticket holds is reported as a collision and skipped. The fallback GitHub key prefix drops separators (`WEBAPP-12`, not `WEB_APP-12`) so it matches the key pattern.
- The repository resolver records a failed read of an issue's hints and moves the ticket to the back of its queue; after a 404 or 403 it waits a day, doubling to a week. Origins are read without blocking the worker, four at a time, and cached until a folder's git config changes.
- Clones also disable Git LFS filters (`GIT_LFS_SKIP_SMUDGE=1`) and HTTP redirects, kill git's whole process tree on timeout or cancel (Windows too), and register a folder of the target name that already holds the remote instead of cloning beside it. The worker removes unfinished `.*.partial-*` clone folders when it starts. Folder names are cleaned again after the 64-character cut and never a Windows device name with an extension.
- `[tracker.repo_map]` remotes carrying credentials are ignored with a warning; remotes are stored and shown without userinfo.
- `quill/no-code` is no longer dropped by a `tags` update that omits it; only `no_code: false` clears it.
- Linking a ticket to a just-registered repository no longer races the worker's config reload, and registering a clone re-reads `config.toml` right before writing, keeping a `quill repo add` made meanwhile.
- Dashboard bulk selection: a bulk run no longer reopens its results dialog after you close it or overwrite another batch's, and clears only the tickets it submitted. **Undo all** also covers changes still being sent and keeps earlier bulk changes inside their window. Changing filters drops checked tickets they hide. `x` with ctrl, meta or alt is left to the browser. The bulk bar is a labelled group and updates its count in place, keeping focus and not replaying its entrance.
- Queued runs of a built-in recipe no longer fail with `recipe-changed` after an upgrade changes the built-in's text; they run the current built-in. Personal and repository recipes still must match the hash that was reviewed.
- `quill handoff cancel --batch` without a value no longer cancels the first run it finds; it, an empty batch id, and `quill handoff cancel` without a run id are usage errors.
- Fix runs could reach Claude Code subagents (`Task`/`Agent`) under `settings` or `full` access, and a fix run's self-check turn was given them. Only read-only `analyse` and `analyse-followups` runs get subagents now, under every access level, and the self-check never does.
- Worker test gate: a passing test command that leaves a background process holding its output is recorded as passed, not as a timeout. The exit code decides; the gate then waits 2 s for the output to close and kills the leftover tree (the process group on POSIX, `taskkill /T` on Windows), also after a cancellation or deadline. Stopping the worker during the gate waits for it, so the run ends as stopped rather than interrupted.
- Runs that fail during setup or cannot spawn the runtime keep the timings measured so far (queue wait, setup, agent time) instead of dropping them. A run whose self-check was skipped or did not finish records why in `result_quality.self_check_skipped`.
- When the dashboard port is taken, `ui-endpoint.json` records `configured_port`, `quill ui` warns that bookmarks to it do not reach the dashboard, and the status line ends with "⚠ port 47321 taken; using N". The host and port read from that file are validated (loopback host, port 1-65535) before they reach a URL or the status line's OSC 8 sequence.
- The `st_owner` cookie has a 7-day `Max-Age`, renewed on every authenticated response, so a browser really stays signed in for 7 days across browser restarts. CSRF tokens are compared in constant time.
- `quill worker install`: the macOS LaunchAgent and the Linux systemd unit carry the install-time `PATH`, so `claude`, git and node resolve at login; the Linux unit escapes `%` (and `$` in `ExecStart=`); the Windows `worker-login.vbs` is written as UTF-16LE with a BOM, so a profile path outside ASCII works. `quill doctor` checks on Windows that the Task Scheduler task still exists and warns "marker present but task missing".
- Configs from earlier releases stored `ui_port = 0` (the old default) and so never got the fixed dashboard port. The user config now carries `config_version = 1`; loading a file without it once drops a stored `ui_port = 0` and adds the marker, so a `ui_port = 0` set afterwards still means random. Saving no longer pins an untouched default `ui_port`.
- `quill ui --revoke` always leaves the sign-out for the worker (`control/ui-revoke.json`), so a stopped worker applies it at its next start and a slow one on its next tick; until then no session verifies and a running worker can no longer write a revoked session back to `ui-sessions.json`. A worker that does not confirm within 5 s is reported, not treated as an error.
- Cancelling or timing out a run on Windows kills its whole process tree; the parent was killed before `taskkill` walked the tree, which could leave children running and holding the run open.
- Dashboard, after a browser audit of the orchestration UI: on phone-width layouts the bulk action bar no longer overlaps the bottom nav (it sits 68px up, the nav being 61px tall) and the worker health popover ("Starts at login") no longer runs off the right edge of the screen. In select mode the top-ranked Pick next card keeps its full-width row. **Undo all (N)** reads as one label instead of "Undo all ( N )". Rows of the bulk run form keep their eligibility chip on the ticket's line, truncating a long title on wide screens and wrapping on phones.

## [0.7.2] - 2026-10-11

### Fixed

- Running `start`, `init`, `ui --session` or `repo add` inside a linked git worktree registers the repository's main working tree instead of the worktree, which is usually deleted once its branch merges.
- A `repo_id` read from a `.quill.toml` (including a parent folder's) no longer overwrites a repository registered at another path; the new folder gets its own id unless `--repo-id` is given.
- Hooks attribute work done in a worktree outside the repository's folder to that repository.

## [0.7.1] - 2026-10-11

### Added

- A merged PR closes every ticket whose work it carried ([ADR 0021](docs/decisions/0021-pr-closes-its-tickets.md)): hooks record the branch each write or commit landed on, reconciliation finds that branch's GitHub PRs with `gh pr list --head` and links them to each ticket, and `deploy_on = "merge"` on a repository makes the merge its deployment so tickets go straight to done.

### Fixed

- PR state on done tickets is refreshed; a merged PR no longer shows as open on the board and in resume briefs.

## [0.7.0] - 2026-10-11

### Added

- Resume brief: a session that binds to a ticket with history (session start, compaction, a prompt naming its key, `ticket bind`, `ticket work` reusing a task) gets a short brief of the goal, next action or blocker, plan, recent conclusions, changed files, PRs and pending deployments, capped at 1,200 characters.
- Effort per ticket: active time (gaps of up to 5 minutes between a bound main session's events), turns, and the tokens Claude Code reports for those turns, read by the Stop hook from new transcript lines without keeping text. Shown in ticket detail and `ticket show`.
- `quill tracker push <KEY>` ([ADR 0018](docs/decisions/0018-tracker-write-back.md)): opt-in (`[tracker] write_back = true` in config.toml only) write of a ticket's status and an optional comment to Jira, GitHub or Linear; previews by default, sends only with `--confirm`, journaled as `tracker-push`.
- Read-only mirror ([ADR 0019](docs/decisions/0019-read-only-mirror.md)): with `[mirror] enabled = true` the owner's worker keeps a sanitized dashboard and snapshot in `<store>/.quill-mirror`; `quill mirror status|open` reads it on any machine and `quill mirror write` refreshes it.
- `quill agent install <https git URL | folder>` and `agent uninstall` ([ADR 0020](docs/decisions/0020-shared-recipes.md)): preview of each recipe's permissions, `--confirm` to install, provenance recorded, unchanged-only removal.
- `quill ticket stale [--apply]`: lists shipped, children-done and idle tickets; `--apply` closes the first two with revision-checked updates (`ticket-update` accepts an optional `expected_revision`).
- `quill doctor` reports hook latency (p50/p95 of real hook processes), capture gaps and ticket coverage for the last 7 days, computed locally.
- `scripts/bench-hooks.mjs` (whole-process hook latency) and `scripts/install-smoke.mjs` (timed first run), both in CI.

### Changed

- Plugin hooks run `bin/quill-hook.js`, which loads only the hook path (PreToolUse p95 114 → 104 ms on Windows).
- The full task-tracking guidance is sent at session start (and after compaction); later prompts get one line naming the bound task.
- Pick next ranks within the active filters; sidebar badges count what each view shows under the filters; the Board header counts open tickets like its badge; every Board column can be hidden; a link's hash fully decides its filters; `quill ui` help documents `--no-open`.
- The reducer is split into domain modules under `src/core/reduce/` with no behaviour change.

### Fixed

- `quill … | head` no longer crashes with EPIPE.
- Host helper agents (empty `agent_type`, no SubagentStart) are no longer captured as checkpoints; one stored the user's predicted next prompt.
- `/favicon.ico` returns 204 instead of a 404 on every dashboard load.

## [0.6.0] - 2026-10-07

### Added

- Run access levels ([ADR 0017](docs/decisions/0017-run-access-levels.md)): handoff and recipe runs use the owner's Claude Code settings and connectors by default (anything needing approval is refused; commit, push and draft PRs still need their permissions), or Full access with no permission checks, chosen per run in the dashboard or with `--access`. Schedules, file runs and runs that name no level keep the standard profile.

## [0.5.0] - 2026-10-07

### Added

- Done when check ([ADR 0016](docs/decisions/0016-done-when-check.md)): after a turn that worked on a bound ticket without a repository, the Stop hook asks Claude once to check the ticket's Done when items and set it to Review when they are met. It never loops, repeats only after new work and 30 quiet minutes, and leaves repository tickets to their PR evidence.

## [0.4.0] - 2026-10-07

### Added

- File runs ([ADR 0015](docs/decisions/0015-file-runs.md)): the built-in `file-task` recipe works on a repo-less ticket's attached files from the dashboard or `quill agent run file-task <KEY> --delete-files --edit-files`. The agent sees only staged copies through sandbox-scoped tools; the worker applies edits and deletions to originals unchanged since staging, keeps what it replaced or removed in a Quill trash folder, and offers Undo for each change. Edit and delete permissions are off by default and never scheduled; a run that changed files moves the ticket to Review.

## [0.3.0] - 2026-10-07

### Added

- Ticket descriptions are mandatory for agent-created tickets ([ADR 0014](docs/decisions/0014-ticket-descriptions.md)): `ticket create` and `ticket work` require `--description` in the Goal / Context / Done when format and print the format when it is missing or malformed; `ticket set --description` writes or replaces one. Hook instructions tell Claude to write it, and a session bound to a ticket without one is asked to add it. Ticket detail shows Goal, Context and Done when, or a "Missing description" warning.
- Agent runs: follow-up children carry a description, checked like the rest of the reply contract; a new `description` output fills a missing ticket description (applied directly by built-in modes only when none is valid, a suggestion otherwise).
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

[Unreleased]: https://github.com/nulllvoid/session-quill/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/nulllvoid/session-quill/compare/v0.7.2...v1.0.0
[0.7.2]: https://github.com/nulllvoid/session-quill/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/nulllvoid/session-quill/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/nulllvoid/session-quill/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/nulllvoid/session-quill/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/nulllvoid/session-quill/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/nulllvoid/session-quill/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nulllvoid/session-quill/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nulllvoid/session-quill/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nulllvoid/session-quill/releases/tag/v0.1.0
