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
| Test command | `npm test` → 514 tests, 513 passed, 1 skipped (symlink creation not permitted on this account), 0 failed (after zero-command tracking, the unlinked work inbox, schedules, agent recipes, environments and Today, publishers, tracker sync and two-way artifacts, ADRs 0005–0011) |

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
| A04 | Partly verified live + **Pending manual** | Live host, Claude Code 2.1 on Windows, 2026-10-10 (session 8e4ba15a, 365 events): `Stop` delivered `last_assistant_message` and was captured as complete checkpoints; `PostToolUseFailure` carried the host error text; `SessionStart` arrived as `startup` and later `resume` (from another device, `cwd` = home directory) followed by `SessionEnd` reason `other` while the session kept working. **Finding, fixed in 0.6.1:** the host's own helper agents (next-prompt suggestion, side questions) fire `SubagentStop` with `agent_type: ""` and no `SubagentStart`; one message was the user's predicted next prompt and was stored as a checkpoint. The hook now ignores `SubagentStop` with an empty `agent_type`. Still pending: real `ExitPlanMode` approved/rejected/cancelled payloads and a real typed subagent run |
| A05 | Automated | `tests/acceptance/phase0.test.js`, `tests/server/http.test.js` — 202 after persistence, note revision change, confirmation; unauthenticated / wrong-Origin / wrong-Host / missing CSRF cannot mutate |
| A06 | Partly verified live + **Pending manual** | Live host, 2026-10-10: the installed plugin (`session-quill@quill-local` 0.6.0) exposes `/session-quill:agent`, `approve`, `doctor`, `handoff`, `publish`, `start`, `status`, `ticket` and `ui`, and the injected guidance names `/session-quill:ticket`. Still pending: status-line composition; `claude plugin validate` passes |
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

| Profile | Whole worker start | Hook p50 | Hook p95 | Hook max | Ingest 1,000 events | Publish generation |
| --- | --- | --- | --- | --- | --- | --- |
| 2,000 tickets / 20,000 events (default `npm test`) | 3.9 s | 1.4 ms | 1.7 ms | 13.2 ms | 648 ms | 18 ms |
| 10,000 tickets / 100,000 events (`QUILL_PERF_FULL=1`) | 12.9 s | 1.5 ms | 1.7 ms | 4.7 ms | 673 ms | 63 ms |

The "Whole worker start" column was first labelled "Replay on start". [ADR 0030](decisions/0030-state-checkpoint.md) split it and found it measures the whole `start()`: journal open, replay, binding publish and the first projection generation, which writes every ticket's detail file and takes most of the time. The reducer replay itself was about 0.2 s at 20k events and about 1 s at 100k; see "2.0.0 measurements" below.

Hook timings are in-process (`runHook`) and exclude Node process start-up (~40–80 ms on this machine), which the host incurs per hook invocation; the 200 ms budget still holds with margin.

Whole-process numbers, as the host sees them, come from `node scripts/bench-hooks.mjs` (a fresh `node` per call with a bound session). Windows 11, Node 24.19.0, 40 calls each, 2026-10-11:

| Entry | p50 | p95 | max |
| --- | --- | --- | --- |
| bare `node -e ""` | 47 ms | 51 ms | 52 ms |
| `bin/quill.js hook PreToolUse` (before 0.6.1) | 106 ms | 114 ms | 116 ms |
| `bin/quill-hook.js PreToolUse` (plugin hooks from 0.6.1) | 94 ms | 104 ms | 106 ms |

The rest is module loading on the hook path (about 34 ms, mostly `node:crypto` and event validation). Node's compile cache made no measurable difference. macOS and Linux numbers remain to be recorded.

**Correction (2.0.0, [ADR 0034](decisions/0034-hook-latency-and-daemon-ipc.md)).** The benchmark of that time passed `hook <Event>` to `bin/quill-hook.js`, which takes the event name alone. So the `bin/quill-hook.js PreToolUse` row measured an "unsupported hook event" early return plus module loading, not a full PreToolUse. The 2.0.0 benchmark below measures the real paths.

### 2.0.0 measurements

All on Windows 11 with Node 24.19.0, on a machine shared with other test runs (up to ten agents, CPU often at 88–99%), so absolute numbers run high and tails are noisy.

**Worker start split** ([ADR 0030](decisions/0030-state-checkpoint.md)), A19 journal shape, before the state checkpoint:

| Phase | 20k events | 100k events |
| --- | --- | --- |
| `Journal.open` (read, parse, sequence and id check) | 49 ms | 263 ms |
| Replay: read and parse again | 47 ms | 228 ms |
| Replay: reducer apply | 126 ms | 473 ms |
| `publishAllBindings` (200 sessions) | 510 ms | 580 ms |
| First `publishGeneration` (every ticket detail written) | 6.4 s | 25.3 s |

**State checkpoint** (ADR 0030): building state at worker start, from `stateLoad`.

| Journal | Full replay | From checkpoint | Speed-up |
| --- | --- | --- | --- |
| 20k events (acceptance, best of three) | 212 ms | 42 ms | 5.0× |
| 100k events (one run, machine heavily loaded) | 4.2 s | 0.29 s | 15× |

`tests/acceptance/perf.test.js` asserts at least 3× at 20k events and that the hydrated state deep-equals the replayed state. The first projection generation, which dominates whole worker start, is unchanged.

**Hooks and the status line** ([ADR 0034](decisions/0034-hook-latency-and-daemon-ipc.md)). Command: `node scripts/bench-hooks.mjs --json --baseline <1.1.1 checkout>`, 200 calls per case, alternating call by call with the 1.1.1 checkout. The least loaded of three runs is shown, with the p95 change of all three runs:

| Case | 1.1.1 p50 / p95 / p99 | 2.0.0 p50 / p95 / p99 | p95 change, runs 1 / 2 / 3 |
| --- | --- | --- | --- |
| bare `node -e ""` | 50.8 / 62.1 / 68.8 ms | (same series) | |
| `quill-hook PreToolUse` | 129.9 / 176.1 / 208.2 ms | 131.1 / 178.5 / 207.5 ms | −8 / −30 / +2 ms (noise) |
| `quill-hook PostToolUse` | 118.6 / 132.2 / 146.1 ms | 118.5 / 131.7 / 143.2 ms | +13 / +33 / −0.5 ms (noise) |
| `quill-hook SessionStart` | 220.8 / 322.3 / 628.2 ms | 149.3 / 228.8 / 496.6 ms | −441 / −108 / −94 ms |
| `scripts/statusline.js` | 192.3 / 223.6 / 242.3 ms | 112.0 / 132.0 / 140.4 ms | −217 / −92 / −92 ms |
| in-process `runHook` PreToolUse | | 5.5 / 6.8 / 10.8 ms | |
| in-process `runHook` PostToolUse | | 6.4 / 7.8 / 12.1 ms | |

The KPI is restated in ADR 0034: in-process hook logic p99 under 15 ms, met on the least loaded run (the in-process rows include each ingress file's fsync; on the more loaded runs their p99 reached 19–31 ms, which is disk contention). The second target is whole-process hook p95 within 15 ms of a bare Node start. It is **not met**: PreToolUse and PostToolUse sit about 70–115 ms above bare Node at p95 here, almost all of it loading the hook's roughly 30 modules. The TRD's 200 ms p95 hook budget still holds.

**Ingress redaction** ([ADR 0029](decisions/0029-ingress-redaction.md)): the hook p95 stayed within the machine's noise and the plan's 10 ms. Back to back at the same load, `bin/quill-hook.js` Pre p95 was 122 ms against 127 ms unchanged, and Post 120 ms against 125 ms. In process, a `pre-tool` `redactEvent` takes about 0.007 ms and redacting a 5 KB Stop message about 0.15 ms.

**Context card** ([ADR 0038](decisions/0038-context-card.md)): 300 in-process SessionStart calls with and without a card measured p50 6.4 ms and p95 13–17 ms in both cases.

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

## Phase 10 — publishers (ADR 0010)

| ID | Status | Evidence |
| --- | --- | --- |
| A61 | Automated | `tests/acceptance/phase10.test.js` — html copy not written before confirmation; written after; a new path asks again |
| A62 | Automated | roll-up lists the demo project only, Windows path redacted |
| A63 | Automated (simulated artifact) | page-edited title kept, next action written, done status written, all pinned |
| A64 | Automated (simulated artifact); verified once against claude.ai | needs-session from the worker; --plan / --result loop records the URL. **Manual check:** a Claude Code session executed the real plan on a private claude.ai artifact — republish, reads with versions, a 12-write pinned batch, and a stale pin refused atomically. Headless `claude -p` (Claude Code 2.1.288) reported that the Artifact tools are unavailable, which is why the session executor is the default |

Unit coverage: `tests/publish/publish.test.js`, `tests/publish/artifact.test.js`, `tests/publish/job.test.js`, `tests/cli/publish.test.js`, `tests/cli/publish-session.test.js`, and the Publish dialog in `tests/ui/render.test.js`.

## Phase 11 — tracker sync and two-way artifacts (ADR 0011)

| ID | Status | Evidence |
| --- | --- | --- |
| A65 | Automated (simulated artifact) | `tests/acceptance/phase11.test.js` — status edit applied after the undo window; next-action edit on a ticket changed since publishing conflicts and is overwritten on the next publish; one comment entry |
| A66 | Automated | run-job of a tracker-sync schedule: PROJ-1 valid with remote status, PROJ-2 not-found, ticket revision unchanged |
| A67 | Automated | repository .quill.toml naming another host and token variable: every request went to example.atlassian.net; error names JIRA_TOKEN; no token in state |
| A68 | Automated (simulated artifact) | one-way page: no requests, no comments, "1 field edited on the page kept" |

**Pending manual:** tracker-sync against real Jira, GitHub and Linear accounts, and a two-way page edited and commented on by a second person on claude.ai.

Unit coverage: `tests/tracker/sync.test.js`, `tests/publish/two-way.test.js`, `tests/publish/review6.test.js`, `tests/publish/review7.test.js`, and the tracker line in `tests/ui/render.test.js`.

CI now runs `npm run test:ci`, which also writes TAP; when a job fails, `scripts/ci-annotate.mjs` publishes each failing test as a check annotation, readable without signing in to GitHub.

Inbox and key chips were also checked in the built-in browser against the dev seed (`node scripts/dev-seed.mjs`): create-from-key queued with an undo countdown, applied after the window and emptied the inbox; tracker keys render as new-tab links with copy buttons; local keys offer "Link to external…". At 375 px the page is wider than the screen because of the header and sidebar, which predates this step.

Unit coverage: `tests/core/external-keys.test.js` (validation, bounded scans, non-ticket tokens, URL templates), `tests/hooks/autobind.test.js`, `tests/hooks/nudge.test.js`, `tests/hooks/gate-modes.test.js`, `tests/worker/identity.test.js`, `tests/core/external-bind.test.js`. **Verified live (2026-10-10):** `SessionStart` and `UserPromptSubmit` `additionalContext` reach the model on Claude Code 2.1. **Pending manual:** the Stop `decision: "block"` nudge, which needs an unbound session that writes files.

## Phase 5 — release evidence

Partially done. Done: license (MIT), repository owner (github.com/nulllvoid/session-quill), Ubuntu/macOS/Windows test matrix in CI, public documentation (README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG, architecture guide), tagged releases from v0.2.0, A04/A06 partly against a live host (above).

First-run smoke (`node scripts/install-smoke.mjs`, also in CI on every OS): `quill start`, the SessionStart hook, Claude's first `ticket work`, a Write through PreToolUse/PostToolUse, `quill status` and `quill ui --no-open` on a throwaway home and a fresh Git repository. Windows 11, Node 24.19.0, 2026-10-11: 7/7 steps in 2.2 s (start 675 ms, dashboard link 720 ms, each hook about 100 ms). This covers the CLI side of installation only; the `/plugin marketplace add` and `/plugin install` steps need a live host.

Still required: two outside installs under 10 minutes using the README only (needs people); WSL run; hook timings on macOS and Linux (CI now prints them).
