# Session Quill — Acceptance Results

Recorded: 2026-10-02 · Implementation revision: v0.1.0 (branch `feat/session-quill-v1`)
Scenarios are defined in [ACCEPTANCE.md](ACCEPTANCE.md). "Automated" means a scenario-named test in `tests/acceptance/` (or a unit suite named below) passed on the environment in the table. "Pending manual" means the scenario needs a live Claude Code host, real network providers or a human and has not been executed.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 11 Pro 10.0.26200 (x64), native (not WSL) |
| Node | 24.19.0 (plugin requires >= 22) |
| Git | 2.55.0.windows.3 |
| Claude Code | 2.1.284 (`claude plugin validate .` → Validation passed) |
| Hook contract | Verified against code.claude.com/docs/en/hooks on 2026-10-02 (field names, PreToolUse decision JSON, exit codes) |
| Test command | `npm test` → 464 tests, 463 passed, 1 skipped (symlink creation not permitted on this account), 0 failed (after zero-command tracking, the unlinked work inbox, schedules, agent recipes, environments and Today, ADRs 0005–0009) |

### Platform matrix (GitHub Actions, commit `bcd989e`)

| OS | Node 22 | Node 24 | Notes |
| --- | --- | --- | --- |
| Ubuntu (ubuntu-latest) | pass | pass | Unix socket lock, `git worktree`, fake `claude` subprocess |
| macOS (macos-latest) | pass | pass | same suite |
| Windows (windows-latest) | pass | pass | named-pipe lock; 8.3 short-name TEMP paths exercised the plan-path canonicalization fix |

Run: https://github.com/nulllvoid/session-quill/actions/runs/37018025766 (296 tests, 295 passed, 1 skipped per job; the full A19 profile also passed on Ubuntu). Two earlier runs failed and led to fixes: plan-path canonicalization for not-yet-created files, and an unhandled socket reset in the ownership lock's owner probe.

**WSL** has not been run. Hook timings on CI are not recorded (the perf test prints them in the job log).

## Phase 0 — host and transport compatibility

| ID | Status | Evidence |
| --- | --- | --- |
| A01 | Automated (in-process fixtures) | `tests/acceptance/phase0.test.js`, `tests/gate/*.test.js` — writes, unknown shell, redirects, substitutions, mutating MCP denied; reads and every allowlisted shell form pass |
| A02 | Automated (in-process) | plan-file exception only for the session's claimed plan path under the plan directory; source edits in plan mode denied. **Limitation:** the host exposes no plan path in hook input, so the first plan-mode `Write` of a Markdown file directly inside `~/.claude/plans` is taken as the session's plan file ([ADR 0004](decisions/0004-plan-path-first-claim.md)) |
| A03 | Automated | distinct identities for two sessions in one cwd and a subagent; missing `session_id` denies covered writes and never falls back to cwd |
| A04 | **Pending manual** | real approved/rejected/cancelled `ExitPlanMode` payloads and Stop/subagent payloads from a live host; fixtures in `tests/fixtures/hooks/` follow the documented shapes |
| A05 | Automated | `tests/acceptance/phase0.test.js`, `tests/server/http.test.js` — 202 after persistence, note revision change, confirmation; unauthenticated / wrong-Origin / wrong-Host / missing CSRF cannot mutate |
| A06 | **Pending manual** | installed command names (`/session-quill:*`) and status-line composition on a live host; `claude plugin validate` passes |
| A07 | Automated | the hook process never fails; a PreToolUse the gate cannot evaluate (malformed input, internal error, failed capture) fails closed for every covered tool while reads pass; non-gate hooks never block; bound sessions emit no decision (never an `allow` override). Host fail-open limit: a hook the host times out or cannot launch is outside the guarantee (TRD) |

## Phase 1 — persistence, attribution and recovery

| ID | Status | Evidence |
| --- | --- | --- |
| A08 | Automated | parallel sessions on one/different tickets; in-flight rebind keeps attribution |
| A09 | Automated | termination after ingress flush, after journal append, and a half-written generation directory; restart preserves acknowledged events, MANIFEST only points at complete generations |
| A10 | Automated | redelivered tool events, approvals and requests have one effect |
| A11 | Automated | note materializes at 30 s from the first pending event; later events do not postpone |
| A12 | Automated | worker down + writable disk: ingress persists, backlog visible, restart drains; unusable ingress: no false receipt, non-gate hook exits 0 |
| A13 | Automated | stale heartbeat denies covered writes; gate off allows with audit; gate on restores |
| A14 | Automated | 4,000-char checkpoint fully retrievable after replay; duplicate approval idempotent; incomplete checkpoint not promotable |
| A15 | Automated (unit) | `tests/core/reducer.test.js`, `tests/core/approval.test.js` — heuristic off never approves; exact phrase, 10-minute window, same binding; quoted/negated/extended prompts never match |
| A16 | Automated | authored text byte-for-byte through update and replay; edited generated block → conflict with file kept; explicit restore and import create journal events; journal-only rebuild reports missing authored files |
| A17 | Automated | distinct keys for duplicate slugs and children; relink keeps id/history/alias and the alias stays bindable; collision, traversal, self-parent and cycle rejected; Jira link pending while offline |
| A18 | Automated | second worker refuses ownership (lock held); copy owned by another machine: doctor reports read-only, `worker start` refuses |
| A19 | Automated (scaled, see below) | hook p95 1.7 ms with 10,000 tickets / 100,000 events; hook path performs zero journal reads |
| A20 | Automated | torn tail quarantined and recovered from retained ingress; mid-log corruption stops the worker with `journal-corrupt` and doctor reports it; failed tool → partial coverage, not a verified write |

### A19 measurements (this machine, warm)

| Profile | Replay on start | Hook p50 | Hook p95 | Hook max | Ingest 1,000 events | Publish generation |
| --- | --- | --- | --- | --- | --- | --- |
| 2,000 tickets / 20,000 events (default `npm test`) | 3.9 s | 1.4 ms | 1.7 ms | 13.2 ms | 648 ms | 18 ms |
| 10,000 tickets / 100,000 events (`QUILL_PERF_FULL=1`) | 12.9 s | 1.5 ms | 1.7 ms | 4.7 ms | 673 ms | 63 ms |

Hook timings are in-process (`runHook`) and exclude Node process start-up (~40–80 ms on this machine), which the host incurs per hook invocation; the 200 ms budget still holds with margin. Cold-start numbers per OS remain to be recorded.

## Phase 2 — migration

| ID | Status | Evidence |
| --- | --- | --- |
| A21 | Automated | `tests/migrate/run.test.js` — dry run writes nothing; lists mapped and ambiguous records including stale and skipped-deployment cases; every source note accounted for (ignored files listed) |
| A22 | Automated | import creates replayable `migration` events, preserves originals and authored sections; counts, parent links, PR records, statuses and deployment obligations verified |
| A23 | Automated (partial) | re-running import yields no duplicate effects; rollback restores source notes and settings from the backup and exports newer quill events. **Pending manual:** the real PMLA layout (the profile assumes YAML frontmatter fields listed in `profiles/pmla/profile.json`) and pausing the legacy hooks |

## Phase 3 — reconciliation, UI and sharing

| ID | Status | Evidence |
| --- | --- | --- |
| A24 | Automated | idle/extinct and stale at boundaries without note mtime change; new work clears stale; compaction does not end a session |
| A25 | Automated | blocked/done excluded; overdue counted once; deterministic ties; cap at 100; fewer than five |
| A26 | Automated | identical polls cannot undo manual blocked; per-environment obligations; draft and closed-unmerged create none; done-with-pending remains listed |
| A27 | Automated | freshness states and offline display; provider failure keeps evidence age and shows a separate provider error |
| A28 | Automated | same-revision clients: one applies, one conflicts; idempotent repost; mismatched body 409; stale retry conflicts |
| A29 | Automated | cancel within the 10 s window; late cancel reports applied; reversal as a new revision-checked request |
| A30 | Automated | refresh runs within one tick regardless of schedule; duplicates join one run; failed run retryable |
| A31 | Automated | applying request after crash → applied or conflict, never permanent pending |
| A32 | Automated | export contains selected fields only; no endpoints, tokens, local paths or private links; fixed export and sync times |
| A33 | Automated (layout) + **Pending manual** (usability) | layouts verified in the built-in browser at 1440, 1024, 800 and 390 px (docked 420 px detail at 1440, modal at 1024, fullscreen below 900); read-only export has no mutation controls; 60-card / 200-row volumes and deep trees covered by `tests/ui/render.test.js`. Human usability timing not run |
| A34 | Automated (contrast) + **Pending manual** | both themes meet measured 4.5:1 for every text/background pair (`tests/ui/tokens.test.js`); keyboard shortcuts implemented and input-safe. First-time-user timing and screen-reader walkthrough not run |

## Phase 4 — handoff

| ID | Status | Evidence |
| --- | --- | --- |
| A35 | Automated | source-off runs in an empty sandbox with Read/Glob/Grep/Bash disallowed; attempt-fix without read/edit rejected; commit/push/PR each need their own permission |
| A36 | Automated | isolated worktree at the recorded base commit; live dirty checkout untouched; unavailable repo fails the run rather than degrading to note-only |
| A37 | Automated | one reservation per ticket; fixes per repo serialize; duplicate result delivery does not duplicate children |
| A38 | Automated (shortened deadline) + **Pending manual** | timeout and cancellation kill the subprocess, preserve logs and partial results and show timed-out/cancelled (`tests/handoff/runner.test.js` with a 400 ms deadline). A real 20-minute wall-clock run including sleep has not been executed |
| A39 | Automated | restart marks running runs failed/interrupted; no automatic rerun; uncertain effects recorded; explicit retry is a new run |
| A40 | **Pending manual** | default fix returns local diff and tests (automated); explicitly authorized push to a non-default branch and draft PR creation need a real remote and `gh` |
| A41 | Automated | parent change during a handoff conflicts the suggested next action; owner fields remain; missing runtime fails at dispatch with a reason |

## Phase 6 — zero-command tracking (ADR 0005)

| ID | Status | Evidence |
| --- | --- | --- |
| A42 | Automated | `tests/acceptance/phase6.test.js` — prompt key links the session with no command; ticket created under the key with its rendered link; later writes attributed; provisional binding confirmed; note written |
| A43 | Automated | branch key linked at SessionStart; a later prompt key switches forward only |
| A44 | Automated | nudge never blocks; asks once at Stop and never while the stop hook is active; the reply links later work only |
| A45 | Automated | strict deny matrix kept with a key hint; mentioning a key lets the next call through |
| A46 | Automated | over the authenticated HTTP API: unlinked work in the snapshot; create-from-key applies after 10 s; ticket has the files and link; session linked |
| A47 | Automated | attach conflicts after new work; dismiss applies; a POST without the owner cookie is refused |
| A48 | Automated | link-external relinks with a rendered https link; old key kept as alias |

## Phase 7 — schedules and the Bitbucket provider (ADR 0007)

| ID | Status | Evidence |
| --- | --- | --- |
| A49 | Automated | `tests/acceptance/phase7.test.js` — Kolkata store, weekday 19:30 cron fires once at 14:00 UTC; snapshot next run moves to Monday |
| A50 | Automated | five missed hourly slots across a restart give one catch-up run; next slot 14:00 UTC |
| A51 | Automated | run-job over the HTTP API: 202 with no delay, trigger manual; unknown schedule 400; Refresh applied |
| A52 | Automated (loopback Bitbucket Server) | bearer token from `QUILL_TEST_BB_TOKEN`; PR merged → deploy-pending with staging and production obligations; token absent from snapshot, journal and health log. **Pending manual:** Bitbucket Cloud and a real Server/Data Center instance |

Unit coverage: `tests/schedule/cron.test.js` (DST gap, day OR rule, time zones), `tests/schedule/config.test.js`, `tests/schedule/schedule-run.test.js`, `tests/schedule/extension.test.js` (one run per job, catch-up, interrupted runs, live config edits), `tests/reconcile/bitbucket.test.js` (host pinning, auth, errors that never include the token). The Schedules panel was checked in the built-in browser against the dev seed, including Run now.

## Phase 8 — agent recipes (ADR 0008)

| ID | Status | Evidence |
| --- | --- | --- |
| A53 | Automated | `tests/acceptance/phase8.test.js` — repository standup overrides personal and built-in for repo demo only; snapshot without paths; invalid recipe refused with recipe-invalid over the HTTP API |
| A54 | Automated | edit_source on deploy-check refused (permission-beyond-recipe); run capped at 10 min with the recipe's tools (Read, Grep, Glob allowed; git log/show left to Claude Code's read-only check; git diff/status denied); recipe appended to after queueing fails with recipe-changed |
| A55 | Automated | next action and deployment evidence suggestions; stale and back-to-back accepts conflict; resubmitted accept records the deployment; comment draft accepted with no ticket change |
| A56 | Automated | agent job over the active scope queues two read-only runs, then zero with two already running; attempt-fix refused |

Unit coverage: `tests/agents/frontmatter.test.js`, `tests/agents/recipes.test.js` (validation, precedence, tool narrowing, catalog cache), `tests/agents/run.test.js` (prompt, tools, time cap, suggestions, accept/dismiss, legacy modes, snapshot and export), `tests/agents/schedule.test.js`, `tests/cli/agent.test.js`, and the Agents panel and run dialog in `tests/ui/render.test.js`. The Agents panel was checked in the built-in browser against the dev seed with the fake agent runtime: Run on deploy-check, two suggestions, Accept moved the ticket's next action after the undo window. **Pending manual:** a recipe run against a real Claude Code runtime.

## Phase 9 — environments, Today and the digest (ADR 0009)

| ID | Status | Evidence |
| --- | --- | --- |
| A57 | Automated | `tests/acceptance/phase9.test.js` — tracker environments stage and prod; ArgoCD evidence for stage over the HTTP API, prod waived; outstanding until both resolved, then done |
| A58 | Automated | Kolkata store at 19:00 UTC reports 2026-10-03; tool call excluded; sanitized export has no today |
| A59 | Automated | 19:30 cron digest writes daily/2026-10-02.md; owner text kept; edited section makes Run now fail with digest-conflict |
| A60 | Automated | reasons "Merged PR awaiting deployment for 3 day(s): +20" and "Untouched for 3 days: +3" |

Unit coverage: `tests/deploy/environments.test.js` (validation, precedence, status, journaled environments and replay, evidence kinds), `tests/today/today.test.js`, `tests/today/digest-job.test.js`, `tests/reconcile/picknext.test.js`, and the Today view, Deployments matrix and record dialog in `tests/ui/render.test.js`.

CI now runs `npm run test:ci`, which also writes TAP; when a job fails, `scripts/ci-annotate.mjs` publishes each failing test as a check annotation, readable without signing in to GitHub.

Inbox and key chips were also checked in the built-in browser against the dev seed (`node scripts/dev-seed.mjs`): create-from-key queued with an undo countdown, applied after the window and emptied the inbox; tracker keys render as new-tab links with copy buttons; local keys offer "Link to external…". At 375 px the page is wider than the screen because of the header and sidebar, which predates this step.

Unit coverage: `tests/core/external-keys.test.js` (validation, bounded scans, non-ticket tokens, URL templates), `tests/hooks/autobind.test.js`, `tests/hooks/nudge.test.js`, `tests/hooks/gate-modes.test.js`, `tests/worker/identity.test.js`, `tests/core/external-bind.test.js`. **Pending manual:** the Stop `decision: "block"` nudge and `UserPromptSubmit` context against a live Claude Code host (the same host gap as A04/A06).

## Phase 5 — release evidence

Partially done. Done: license (MIT), repository owner (github.com/nulllvoid/session-quill), Ubuntu/macOS/Windows test matrix in CI, public documentation (README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG, architecture guide). Still required: two outside installs under 10 minutes using the README only; WSL run; cold-start hook timings per OS; A04/A06 against a live Claude Code host; a tagged `v0.1.0` release.
