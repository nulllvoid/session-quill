# Session Quill 2.0.0: PRD gap analysis

Date: 21 October 2026. Source: `00-prd.md`, a text copy of the owner's "Session Quill 2.0.0 PRD" (Draft / RFC). Base: `main` at 2658268 (v1.1.1), 4,707 tests passing.

The PRD was partly written without the code in view. This document maps each requirement onto the code, corrects the premises that do not hold, and records how each requirement is adopted. Where adopting a requirement as written would weaken a shipped safety contract, it is reshaped and the reason is given. The plan is `docs/superpowers/plans/2026-10-21-quill-2.0.0.md`.

## Premises that do not hold

| PRD says | The code |
| --- | --- |
| `quill start <ticket>` starts work on a ticket | `quill start` enables tracking in a repository (`src/cli/commands/start.js`). The ticket commands are `quill ticket work` and `ticket bind`. |
| `recipes/workspace-setup.md` lists env files to copy | It is an `analyse` recipe that suggests which repository a ticket belongs to. |
| `src/core/cleanup.js` tears down worktrees | It lists stale and closable tickets. Run worktree teardown is in `src/handoff/extension.js`. |
| `blobs.js` can hold git tree objects | It is a sha256 text store. Tree objects live in the repository's object database and need refs to survive `git gc`. |
| Tickets become "Published" or "Closed" | Statuses are todo, active, blocked, review, deploy-pending and done; ADR 0021 closes to done. |
| The Edit / Conflict / Undo UI can roll back files | It handles ticket-field revision conflicts and the 10 s request undo. |
| ADR 0004 means agents declare target files | ADR 0004 is the one plan file a plan-mode session may create. Nothing lets an agent declare target files. |
| `quill approve` is a command approval prompt | It approves a checkpoint or a page-proposed run. Scope grants and critical approvals are dashboard-only (ADR 0028 §4). |
| `sanitize.js` holds secret redaction | It projects export fields and redacts absolute paths. Secret patterns are in `src/handoff/stream.js` and cover run ledgers and memory only. |
| `quill publish` opens PRs | It runs tracker publishers (ADR 0010). The only PR Quill opens is a fix run's draft PR (`fixExtras`). |
| The statusline replays the journal | It reads the binding snapshot and the heartbeat. Full replays happen at worker start, `quill sync` and `quill memory`: 3.9 s at 20k events, 12.9 s at 100k (`ACCEPTANCE-RESULTS.md`). |
| A hook thin client can run in under 5 ms | A bare `node -e ""` takes 47 ms p50 on this Windows machine; the hook takes 94 ms p50, of which 1.7 ms is Quill's logic. |
| A dashboard daemon on `~/.quill/daemon.sock` | ADR 0022 rejected a separate daemon; the dashboard is a worker extension. The worker already owns a named pipe (`src/worker/lock.js`). |
| SCREAMING_CASE event names | Event kinds are kebab-case, partitioned into ingress and worker-only kinds (ruling R59). |
| "Waiting on quill-guard" | The guard refuses calls; it never pauses a run (ADR 0017: runs are unattended). |
| Runs pass "done-when checks" | ADR 0016: handoff and recipe sessions are never asked. |
| CI logs go to the "session inbox (0006)" | ADR 0006's inbox holds unlinked files and commits. |

## Requirement map

Status is what exists today. "Adopted as" is the 2.0.0 design; the task number refers to the plan.

| FR | Status | Adopted as | Task |
| --- | --- | --- | --- |
| 1.1 Worktree provisioning | Runs: yes (per-run detached checkouts). Interactive: none | `quill ticket work|bind --worktree` and `[worktree] auto`: a named-branch worktree outside the repository under the Quill home; ignored env files from `[worktree] copy` are copied, never linked; never applied to worker runs (their credentials go through `cred-env`) | 8 |
| 1.2 Checkpoint snapshots + rollback | Missing | Run snapshots: the worker snapshots a fix run's checkout at step boundaries with a temporary index (`write-tree` + `commit-tree` + a ref under `refs/quill/snapshots/`); the owner restores one from run detail through a `restore-snapshot` request with a pre-restore snapshot. Called "snapshots" because "checkpoint" already means a captured turn | 7 |
| 1.3 Teardown | Runs: yes | A worker sweep removes a clean ticket worktree 7 days after the ticket is done; a dirty one is kept and reported; the branch is kept for ADR 0021; snapshot refs of removed run checkouts move to `refs/quill/archive/` | 7, 8 |
| 2.1 Blast-radius brief | Missing | A worker-computed context card (co-change partners from a cached `git log` index, overlapping tickets and runs, guard facts) written as a projection; hooks only read it; runs get it inside the data fence | 10 |
| 2.2 SHA/symbol-anchored memory | Partial (blob pins in evidence, line re-check at dispatch) | Structured `anchors` on filed entries, a worker-journaled `staled` memory op when an anchored source changes beyond `[memory] anchor_stale_ratio`, pinned and owner entries exempt (R27) | 4 |
| 2.3 Failure ledger | Partial (Run notes of failed runs) | A `failure` record on the Run note (test-gate status, command, exit code, signature, files), repeat detection before the repair turn, "Failed before" in the resume brief, optional dismissal reason. Raw test output never crosses runs (ADR 0027 tool-output rule) | 4 |
| 3.1 Plan-path drift | Missing | "Planned files": paths from an `ExitPlanMode` plan and from an optional run request field; writes outside them are counted as drift and shown amber in the statusline, run detail and Needs you grouping. Observe only: never pauses a run, never blocks in nudge mode | 9 |
| 3.2 Dry-run enforcement | Partial (dry-runs classify as reads) | In an approved critical-change run, a pinned `k8s.write` or `db.write` action is refused until the run's ledger holds its server dry-run twin with exit 0 (`[critical] require_dry_run`, default on). terraform, gh and aws are deferred: terraform cannot be pinned, gh has no dry-run, aws covers only ec2 | 3 |
| 3.3 Ingress redaction | Partial (runs only) | A shared `src/lib/redact.js`; `writeIngress` redacts every hook and CLI event's free text; the worker redacts again at ingest; blobs are redacted before storage; tracker-push comments are redacted before preview. KPI restated as "known credential formats" | 1 |
| 3.4 JIT leases `quill approve --ttl` | Missing; the CLI form conflicts with ADR 0028 §4 and with the grant hash | A "Valid for" choice on the dashboard approval of a critical change, frozen as `notAfter` in the hashed grant; the guard refuses with `lease-expired` after it. It only narrows | 3 |
| 4.1 Attention-first triage | Partial (Needs you) | Grouping inside Runs → Needs you (`group=attention`): Needs your decision, Tests or CI failed, Ready to review, Live; worded as recorded facts; finished fixes with changes join Needs you as "Ready to review" | 11 |
| 4.2 Adversarial critic | Missing | `recipes/critic-review.md`, opt-in per repository; a fresh read-only process after the test gate passes; findings stored as a blob and shown as "Review notes: the critic agent's opinion, not Quill's check"; never blocks | 12 |
| 4.3 Intent-grouped diff | Missing (patch file only) | The patch is stored as a blob; run detail groups hunks by a path table, labelled "Grouped by file path"; per-hunk "Retry as new run" with a pre-filled note. Per-hunk revert deferred | 12 |
| 4.4 Self-healing CI watcher | Missing | A `ci-watch` job polls checks of PRs opened by Quill runs (GitHub), records a worker-only `ci-observation`, and stages a worker-only `ci-proposal` the owner approves on the dashboard (no auto-approval, ADR 0025), at most two per PR. Bitbucket deferred | 11 |
| 5.1 PR evidence receipt | Partial (one gate line in the draft PR body) | `src/handoff/receipt.js` builds a deterministic Markdown receipt from journaled run facts (test gate, tested tree equals commit tree, guard counts, approvals, change counts) with a sha256 digest, called a digest, never proof; scopes, targets and test output never leave the machine; `quill receipt <run>` prints it | 5 |
| 5.2 Autonomy score, recipe CFR | Partial data | Per-recipe counts in `quill doctor` (runs, done, first-time test pass, owner interventions) and "reverted within 48 h of merge" from merge commits and revert detection. Counts, not an opaque score | 5 |
| §4 Daemon socket IPC | Missing; conflicts with ADR 0022 | Deferred with reasons (ADR 0034). Instead: p99 and a statusline case in `bench-hooks.mjs`, a lean statusline entry, lazy loading on the hook path | 6 |
| §4 Snapshot compaction | Missing | A worker state checkpoint with reducer and package versions; `Journal.open` resumes from an offset; worker start hydrates and replays the tail; any mismatch falls back to a full replay | 2 |
| §5 New events | — | `worktree` (ingress), `snapshot-tx`, `ci-observation`, `ci-proposal` (worker-only). Everything else is a field or op on an existing kind | 2–12 |

## Safety contracts kept

- Credentials are the boundary; the guard is defence in depth (ADR 0026).
- Scope grants and critical approvals stay dashboard-only; an approved grant is frozen by its hash (ADR 0028).
- Nudge mode never blocks; runs are never paused waiting for the owner (ADR 0005, 0017).
- No git spawned on the hook path (ADR 0021).
- Only the worker writes generated state (ADR 0001).
- Static exports gain nothing new beyond counts; new local fields stay off the export, mirror, vault and publisher allow-lists.
- §6 honest-state language: no new run states; critic opinions are not Quill's verification; "done" is not "deployed".

## KPIs restated

| PRD KPI | Restated |
| --- | --- |
| Hook P99 < 15 ms | In-process hook logic p99 < 15 ms; whole-process p95 within 15 ms of bare Node startup, measured by `bench-hooks.mjs` |
| 40% less review time | Not measurable from the journal today; recipe stats report time from done to PR merge per recipe |
| Zero repeated identical test failures | Repeat detection by failure signature; doctor reports repeats per ticket |
| 100% secret interception | Every known credential format in `src/lib/redact.js` is redacted before the journal; tests cover each format |
