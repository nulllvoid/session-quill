# Orchestration-first 1.0 — delivery plan

Source: "Session Quill: Orchestration-First PRDs" (Claude Doc, 2026-10-11) and its "UI plan" tab. The doc's
**review** (the "Better approach" sections) is the spec. The original drafts are superseded wherever the
review changes them. Ticket: FEAT-9. Branch `feat/orchestration-1.0`, worktree `../session-quill-1.0`.

## Principles (from the review)

- Deterministic before agentic: repo resolution, test verification and batching are worker logic. Agents only suggest.
- Reuse what exists: hook boot (`ensureReady`), per-repo fix serialisation (`nextDispatchable`), idempotent requests (client UUIDs), reserved `quill/` tags, `applyFeedback` two-way path, `editRequestId`.
- Consent at trust boundaries: cloning from ticket data and runs started from a shared page both need the owner's approval.
- Measure before optimising: timings on runs; **no prewarmed worktree pool**.
- Never write a plain secret to disk. Never put a secret in the status line.

## Constraints

- Node >= 22, ES modules, no new runtime dependencies, no bundler. UI is plain ES modules rendering template-literal HTML (`ui/app.js`, `ui/components.js`, `ui/views/*.js`) with Graphite Ink tokens in `ui/styles.css`.
- TDD: write the failing test first (`node --test`), then the code. `npm test` must stay green (baseline 641 pass / 2 skipped).
- Every journal change goes through the existing event kinds where possible; a new event kind needs reducer + tests.
- Write an ADR in `docs/decisions/` (next free numbers start at 0022) for each phase; update README/docs where commands or config change; add entries under `## [Unreleased]` in CHANGELOG.md.
- Commit per logical unit with conventional messages ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push. Never touch the main checkout (`../session-tracker`) — Codex edits there.
- Tests must not touch the real user's machine: inject command runners for `schtasks`/`launchctl`/`systemctl`, git clone and tracker HTTP.

## Phase 1 — quick wins (PRD 4 + PRD 2 timings)

Backend
1. **Stable port.** `ui_port` default becomes a fixed port `47321` (config default). The server tries it first and falls back to a random port (0) if it is taken (EADDRINUSE). `ui_port = 0` keeps random. The result is still recorded in `ui-endpoint.json` (host, port, pid).
2. **Durable sign-in.** Session tokens are persisted as hashes with an expiry (7 days, sliding: renewed on use) in the worker state dir (same place as `control/ui-secrets` or beside it), so a worker restart keeps the browser signed in. Expired entries are pruned. `quill ui --revoke` clears all sessions (and any outstanding one-use secrets). Plain tokens are never written to disk.
3. **Sign-in page.** A request to the dashboard with no valid session gets an HTML page (status 401) saying "Run /session-quill:ui to sign in" (and `quill ui` for the CLI), styled minimally with the dashboard tokens, instead of a bare error. API requests (`/v1/...`) keep JSON errors.
4. **Status line link.** `quill status --statusline` (and `scripts/statusline.js` if it composes the line) reads `ui-endpoint.json` and appends the base URL as an OSC 8 hyperlink only when the file's pid matches the live/healthy worker. No secret. Nothing printed when the worker is down or the pid is stale.
5. **`quill worker install` / `quill worker uninstall`.** Per-user login entry, no admin: Windows Task Scheduler logon task (`schtasks /Create /SC ONLOGON /TN "Session Quill worker (quill)" ... /F` running node with `bin/quill.js worker start`; prefer a windowless launch, e.g. a generated .vbs as the existing manual setup does), macOS LaunchAgent plist in `~/Library/LaunchAgents/` (RunAtLoad true, KeepAlive false), Linux systemd user unit (`Type=oneshot`/`RemainAfterExit` or a simple service that runs `worker start` once; no Restart=). Idempotent: install twice = one entry; uninstall when absent = success. `quill doctor` reports whether it is installed. Restarts stay with `ensureReady`'s backoff, not OS keep-alive. All OS calls go through an injectable runner so tests use fakes.
6. **Run timings.** Record `queue_wait_ms` (request → dispatch), `worktree_ms` (worktree creation), `agent_ms` (agent process run, including the self-check turn) and `test_ms` placeholder-free (only fields that exist) on the handoff result / `handoff-tx` so they reach the run projection. Show them via `quill handoff show`/agent run output if such output exists.
7. **Mandatory self-check.** In the runner/extension, `selfCheck` is true whenever the run's permissions include `edit_source`, regardless of recipe frontmatter.

UI
- Copy button on the top-bar endpoint span using the existing `data-copy` handler (`ui/views/header.js`).
- Timings line on each run item: queue wait, setup, agent (`ui/views/agents.js`).
- *Starts at login* line in the health popover when the worker install entry is present (health payload gains a boolean).
- Keep *Worker: connected* wording.

Done when: render tests cover the copy button and timings; auth tests show a session surviving an auth re-create from the same state dir and `--revoke` clearing it; port fallback is tested; statusline prints nothing for a stale pid; install/uninstall idempotence tested per OS with a fake runner.

## Phase 2 — bulk work, verified (PRD 3 fan-out + PRD 2 test gate)

Backend
1. **Worker test gate.** Optional `test_command` (string) and `test_timeout_ms` (default 600000) per repo in `[repos.<id>]`. After an `attempt-fix` (any run with `edit_source`) agent finishes with a diff, the worker itself runs `test_command` in the run's worktree (shell, timeout, no stdin) and records exit code, duration and the last ~4 KB of output as evidence on the run (`test_gate: { status: 'passed'|'failed'|'timeout'|'skipped', exit_code, ms, tail }`). On failure the worker grants **one repair turn**: it resumes/re-invokes the agent with the failing output, then runs the gate again. A second failure yields **no suggestion** and records the reason. A repo without `test_command` → `status: 'skipped'` and the UI says fixes are not test-verified. PR bodies / suggestion text say "tests passed (worker)" only on a real pass.
2. **Concurrency caps.** `maxConcurrent` configurable: `[handoff] max_concurrent_readonly` (default 2) and `max_concurrent_fix` (default 1) — read-only runs counted separately from runs with `edit_source`; fixes keep per-repo serialisation.
3. **Batch id.** `handoff` request payload accepts an optional `batch_id` (string, ≤ 64 chars) that is stored on the handoff and exposed in the projection. A `handoff-cancel` per queued run of a batch implements **Cancel batch** (UI-side fan-out; optional convenience: a CLI `quill handoff cancel --batch <id>`). No transactional batch endpoint.
4. **Fan-out analysis inside one run.** The built-in analyse recipe(s) may use Claude Code subagents (allow the `Task`/`Agent` tool for read-only analyse runs if the tools allowlist blocks it) and are instructed to split large analyses by module and merge results. No runner fan-out, one reservation per ticket stays.

UI (UI plan phase 2)
- `appState.checked` Set (never reuse `selected`), a **Select** toggle in the view toolbar of Board and Pick next; in select mode checkboxes render on every card as siblings of the `<article role="button">`, always visible; keys `x` toggles focused card, Shift-click selects a range, `Esc` clears.
- `renderBulkActionBar()`: `role="toolbar"`, `aria-label="Bulk actions"`, count, Analyze, Attempt fix, Change status, Clear; `--z-bulk: 25` token; on narrow layouts sits above the bottom nav (`calc(56px + env(safe-area-inset-bottom))`) and hides while the detail panel is open; slide-in only outside `prefers-reduced-motion`; count changes announced via `#live`.
- `renderBulkHandoffForm(ids)` listing each ticket as *ready*, *already running*, *no repo*, *not eligible*; recipe and access chosen once; shows run count, recipe, access, concurrency cap; bulk Attempt fix needs an explicit `edit_source` confirmation; fixes on one repo show *waits for repo*.
- Fan-out submit with a shared `batch_id` via `api.submit` per ticket; per-ticket results (*queued*, *already running*, *stale, refresh*); bulk status changes keep per-request undo gathered under **Undo all (N)**; bulk runs get **Cancel batch** and a progress strip grouped by `batch_id`.
- Test gate chips on runs: *Tests passed (worker)* (good) and *Tests failed* (critical) linking to recorded output; *Self-checked* stays neutral; the handoff form names the `test_command` or says *No test command: fixes are not test-verified*.

Done when: selecting 5 cards and choosing Analyze sends 5 requests and shows 5 outcomes; bulk status changes undo together inside 10 s; `tokens.test.js` and `motion.test.js` pass with new rules; keyboard-only selection works (render/unit tests); test gate pass, fail→repair→pass, fail→repair→fail (no suggestion) and timeout are tested with fake agents/commands.

## Phase 3 — onboarding (PRD 1 resolver)

Backend
1. **Import assigned issues.** `[tracker] import_assigned = true` (opt-in) makes the `tracker-sync` job run an `assigned-import` step: Jira `assignee = currentUser() AND statusCategory != Done`; GitHub `is:open assignee:@me` via the search API (repos from config). New issues become tickets through the existing `ticket-create` path with the external key set; already-imported keys are skipped (idempotent). No agent. `quill init --bootstrap-from-tracker` enables it in config and runs one import immediately, listing what was imported.
2. **Rule-based repo resolver** (first match wins): (a) `[tracker.repo_map]` maps a Jira project key / component / GitHub `owner/repo` to a registered repo id or a remote URL; (b) a registered repo whose `git remote get-url origin` matches a repository URL found in the issue's linked development data (GitHub: the issue's repository itself; Jira: remote links / dev panel URLs when available); (c) a scan of `auto_clone_dir` (new `[tracker] auto_clone_dir`) and known repo roots for a clone whose origin matches. Matching normalises https/ssh forms. Result: `linked` (sets ticket `repo_id` via `ticket-update`), `needs-clone` (remote known, no local clone) or `none`.
3. **Clone with consent.** `needs-clone` is surfaced on the ticket (a derived field in the projection and/or a suggestion); nothing clones automatically. `quill repo clone <KEY> [--confirm]` previews then clones over https/ssh only from `[tracker] clone_hosts` (default `["github.com", "gitlab.com", "bitbucket.org"]`), into `auto_clone_dir/<repo-name>`, registers it like `repo add` and links the ticket. Dashboard request kind `repo-clone` (not delayed) does the same after the dialog. Refuse URLs with credentials, non-allowed hosts, `file:`/`ext::` transports, or paths escaping `auto_clone_dir`. Never clone the same remote twice.
4. **Fallback suggestion.** A read-only built-in `workspace-setup` recipe may suggest a mapping as a pending suggestion; it never clones or writes config. It is not run automatically by sync.
5. **No code.** The owner can set the reserved tag `quill/no-code` through `ticket-update` (allowed despite the `quill/` reservation); such tickets show *No code* and the resolver skips them. No new event kind.

UI (UI plan phase 3)
- Repo chip in the card meta row beside the branch icon: *Needs clone* (warning, with **Clone…**), *Cloning* (pulse, static under reduced motion), *No code* (neutral).
- A **Repo** filter value *Needs clone*.
- Clone confirmation dialog (`ui/views/dialogs.js`) showing remote URL, target folder and the host check.

Done when: a ticket with a mapped but missing repo shows *Needs clone*; confirming clones (fake git in tests) and the chip becomes the repo name; import is idempotent; disallowed hosts are refused.

## Phase 4 — remote and scale

Backend
1. **Remote runs become proposals.** Two-way artifact publishers gain an editable `run` field ("Run agent": a recipe name from a dropdown of read-only recipes plus any the owner allows). `applyFeedback` turns that edit into a **proposed run** on the ticket (journaled; deterministic id from `editRequestId` so repeated reconciles create exactly one), naming the page editor and recipe. Nothing queues until the owner approves on the dashboard or via `quill approve --run <id>` (or the existing approve command extended); dismiss is supported. ~~Optional auto-run for allowlisted editors~~ dropped in review: the editor id is page data any editor can forge (ADR 0025).
2. **Worktree recycling** stays deferred until phase-1 timings show worktree time matters (document in the ADR).

UI (UI plan phase 4)
- *Proposed runs* list on Today and in ticket detail with editor, recipe, access, Approve and Dismiss (`ui/views/today.js`, `ui/views/detail.js`).
- Receipt (`setReceipt()`) plus live-region notice when a page edit proposes a run (`ui/app.js` `syncRequests`).
- No nested run display (run groups do not ship).

Done when: a "Run agent" edit on a two-way page appears as one proposal after two reconciles, and nothing runs until Approve.

## Release 1.0.0

Version bump in package.json, .claude-plugin/plugin.json, src state/worker version constants and CHANGELOG (`## [1.0.0] - <date>`), README overview of the orchestration features, PR to main, merge, annotated tag `v1.0.0`, push, reinstall plugin (see memory), restart worker.
