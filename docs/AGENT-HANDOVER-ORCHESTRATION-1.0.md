# Agent handover: Quill UI and orchestration-first 1.0

## 2.0.0

Added 21 October 2026 at the end of the 2.0.0 plan (`docs/superpowers/plans/2026-10-21-quill-2.0.0.md`, version 2.0.0). This section describes what is implemented on the integration branch. Everything under "Deferred" and "Known gaps" is not implemented. The sections after this one are the 1.1 and 1.0 handovers, kept as written.

### Where to read

- **Scope.**
  - The PRD is `docs/research/2.0.0/00-prd.md`. The gap analysis `docs/research/2.0.0/01-gap-analysis.md` corrects its premises and says how each requirement was adopted; where they differ, the gap analysis wins.
  - The MCP credentials issue review is `docs/research/2.0.0/02-issue-mcp-credentials.md`. Its fixes 2 and 4 became Task 14.
- **Decisions.** ADRs [0029](decisions/0029-ingress-redaction.md) to [0041](decisions/0041-run-environment-disclosure.md), one per task, including their amendments (0031 has three).
- **Data.** `docs/DATA-CONTRACT.md`, section "2.0.0 index": every event kind, request kind, field (with its export status), config key, error code and UI surface.
- **UI.** Design system 1.2, §5–§7.
- **Setup.** README, "What's new in 2.0" and the sections it links.

### What shipped, and where the code is

| Task | Feature | Code |
| --- | --- | --- |
| 1 | Ingress secret redaction (ADR 0029) | `src/lib/redact.js`; `writeIngress` in `src/core/ingress.js`; worker re-check in `src/worker/worker.js`; the hook adapter and `src/hooks/payload.js`; `quill tracker push` |
| 2 | State checkpoint (ADR 0030) | `src/core/checkpoint.js`; `Journal.open({ resume })` in `src/core/journal.js`; `Worker.loadState`; `REDUCER_VERSION` in `src/core/reducer.js` |
| 3 | Dry-run preflight and approval leases (ADR 0031) | `src/gate/dry-run.js`, `src/gate/run-guard.js`, `bin/quill-guard.js` (`argv_sha`), `src/handoff/grant.js`, `src/server/requests.js` (`ttl_minutes`), `recipes/critical-change.md`, `criticalItem` in `ui/components.js` |
| 4 | Anchored memory and the failure ledger (ADR 0032) | `src/memory/anchors.js`, `src/memory/failure.js`, `src/memory/file.js`, `src/memory/deliver.js`, `src/core/reduce/memory.js` (`staled`), `src/core/reduce/requests.js` (`dismissals`), `src/core/brief.js`, `ui/views/memory.js`, `ui/views/detail.js` (Run notes) |
| 5 | Evidence receipts and recipe stats (ADR 0033) | `src/handoff/receipt.js`, `src/cli/commands/receipt.js`, `src/handoff/test-gate.js`, `src/core/usage.js` (`recipeStats`), `src/cli/commands/doctor.js`, `src/reconcile/providers/github.js`, `src/reconcile/run.js` |
| 6 | Hook latency (ADR 0034) | `scripts/bench-hooks.mjs`, `scripts/statusline.js` and `src/cli/statusline.js` (lean status line), the lazy worker import in `src/runtime/readiness.js` |
| 7 | Run snapshots and restore (ADR 0035) | `src/handoff/snapshots.js`, `src/core/reduce/snapshots.js`, `restore-snapshot` in `src/server/requests.js`, Snapshots in `ui/views/run-detail.js` |
| 8 | Ticket worktrees (ADR 0036) | `src/handoff/worktree.js` (`createBranchWorktree`, `copyIgnoredFiles`, `removeCleanWorktree`), `src/handoff/ticket-worktrees.js` (sweep), `src/core/worktrees.js`, `src/cli/commands/worktree.js`, `src/cli/commands/ticket.js`, `commands/ticket.md` |
| 9 | Planned files and drift (ADR 0037) | `src/core/planned-paths.js`, `src/hooks/adapter.js`, `src/hooks/nudge.js`, the session reducer, `src/hooks/binding-snapshot.js`, `src/cli/statusline.js`, `bin/quill-guard.js` (`drift: true`), the drift chip in `ui/views/run-detail.js` |
| 10 | Context card (ADR 0038) | `src/memory/blast-radius.js`, `src/worker/projections.js`, `readContextCard` in `src/hooks/binding-snapshot.js`, `src/core/brief.js`, `src/handoff/context.js` |
| 11 | Attention groups and the CI watch (ADR 0039) | `attentionOf`/`attentionGroups` in `ui/lib/runs.js`, `ui/views/runs.js`, `ciItem` in `ui/components.js`, `src/handoff/ci-watch.js`, `src/core/reduce/ci.js`, `fetchChecks` in `src/reconcile/providers/github.js`, `src/lib/git-ref.js` |
| 12 | Diff review and the critic (ADR 0040) | `src/handoff/critic.js`, `recipes/critic-review.md`, `fixExtras` in `src/handoff/extension.js` (`patch_ref`), `src/agents/recipes.js` (`run_diff`), `ui/lib/diff.js`, Changes and Review notes in `ui/views/run-detail.js` |
| 14 | Run environment disclosure (ADR 0041) | `src/handoff/run-env.js`, `buildChildEnv` in `src/handoff/cred-env.js` (`removed`), `src/handoff/autonomous.js`, `src/handoff/runner.js` (prompt), `src/memory/file.js` and `src/memory/anchors.js` (run-env anchor), Run dialog in `ui/components.js`, Environment in `ui/views/run-detail.js` |
| 13 | Release documentation and version 2.0.0 | This section, DATA-CONTRACT "2.0.0 index", design system 1.2, README, CHANGELOG `[2.0.0]`, `package.json` and `.claude-plugin/plugin.json` |

New event kinds are limited to `worktree` (ingress), and `snapshot-tx`, `ci-observation` and `ci-proposal` (worker only, quarantined through ingress). Everything else is a field or an op on an existing kind. `REDUCER_VERSION` is 2.

### Deliberate deviations from the PRD

These are recorded in the gap analysis and the ADRs. Keep them unless the owner decides otherwise.

- **No daemon socket IPC** (ADR 0034). ADR 0022 rejected a separate daemon. Per-caller environment would become a forgeable protocol field. Retried sends would duplicate events. A busy worker would delay hooks. Node cannot set a Windows named-pipe ACL. And a fresh `node` per hook already costs more than the PRD's 5 ms. The KPI is restated: in-process hook p99 under 15 ms, and whole-process p95 within 15 ms of a bare Node start.
- **Leases on the dashboard, not `quill approve --ttl`** (ADR 0031). Critical approval is a dashboard action (ADR 0028 §4, R59), and the grant is frozen by its hash. Nothing can extend a lease.
- **Dry runs are enforced for kubectl and psql pins only** (ADR 0031, amendment 1). A pin without a twin decides as in 1.1, so 1.1-approvable changes stay approvable.
- **"Snapshots", not "checkpoints"** (ADR 0035). "Checkpoint" already names a captured turn, and the state checkpoint (ADR 0030) is a third thing. Snapshot trees are git refs, not `blobs.js` content.
- **Ticket worktrees from `quill ticket work|bind --worktree`**, not `quill start <ticket>` (ADR 0036). They live under the Quill home, not inside the repository. Env files are copied, never linked. The worktree's source identity includes a `mount_id`.
- **Planned files only flag** (ADR 0037). They never pause or refuse anything, and runs need a guard to measure drift.
- **A digest, not a "cryptographic" receipt** (ADR 0033). It is appended to the fix run's draft PR, not by `quill publish`. Recipe stats are counts, not an autonomy score, and a matching PR title alone never counts as a revert.
- **The CI watch is an extension tick, not a schedule job** (ADR 0039). A schedule job would journal 576 events a day. It covers GitHub only, and approval, dismissal and resume of a CI fix are stricter than for critical changes: dashboard only, all three.
- **The critic is opt-in and never blocks** (ADR 0040). It runs only after a passing test gate, and the diff groups by a fixed path table, not by intent.
- **The state checkpoint is written on idle ticks and on stop** (ADR 0030), not every 500th event inside ingestion. ADR 0030 found the old A19 "replay on start" figure measures the whole worker start, dominated by the first projection generation, which this release leaves alone.
- **The context card is a projection, never journaled** (ADR 0038), and it never uses a run's `changed_files` for overlap.

### Review-fix waves

After the feature merges, three review waves landed on the integration branch:
- **A, security** (dd7f863).
  - The lease is checked only for writes a scope or pin covers (ADR 0031, amendment 2).
  - The Needs you dry-run note uses the guard's own `pinnedTwin` (amendment 3).
  - Tool names and planned paths are identifier keys for redaction.
  - Planned-path extraction and glob matching are linear, with at most 4 wildcards.
- **B, worker and git** (6694115).
  - A snapshot restore never unlinks an unsaved file or link on the way to a restored path.
  - A revert PR counts only for the PR it names.
  - A ticket worktree whose copied ignored files changed is kept.
  - The worktree sweep no longer holds up worker start.
  - The anchor check is keyed on its candidates.
  - A dismissal never evicts a real Run note.
- **C, CI watch and critic** (43fe313).
  - A refused CI observation is journaled once.
  - Any branch name git accepts is observed.
  - CI proposals lapse when the PR ends, and a fix is never based on a missing branch.
  - A CI fix resumes as a CI fix, from the dashboard owner, while CI still fails.
  - An open CI fix proposal is never hidden from Needs you.
  - An autonomous run's critic runs under the guard without scope credentials.
  - A page run-proposal cannot claim a worker-only proposal id.
  - The CI proposal line and a CI fix's provenance stay off exports.
  - The whole fetched CI log is redacted before its tail is cut.
  - On Windows, environment variable names count in any case.

### Deferred

From the plan's Deferred list and the ADRs:
- daemon socket IPC (ADR 0034);
- per-tool-call and interactive-session snapshots, restoring an archived snapshot into a new checkout, pruning archive refs with log retention, and snapshots of ticket worktrees (ADR 0035);
- symlinked env files (ADR 0036);
- dry-run enforcement for terraform, gh and aws, twins for helm, mysql, redis-cli and MCP tools, server dry runs the classifier would have to be widened to read, and a lease countdown on a running run (ADR 0031);
- CLI lease grants, by design (ADR 0031);
- intent (LLM) grouping of the diff and per-hunk revert (ADR 0040);
- Bitbucket CI and logs from CI systems other than GitHub Actions, `ci-watch` as a schedulable job, projecting `ci_checked` as a recorded stage, and the live phase and verify outcome of an approved CI fix on its item (ADR 0039);
- enforced (denying) planned files, a planned-files field in the Run dialog, and drift for standard and settings runs (ADR 0037);
- tree-sitter symbol anchors (ADR 0032);
- in the adapter, lazy-loading event-specific modules, moving `sessionKey` out of the reducer module, and bundling the hook path (ADR 0034);
- the first projection generation, which dominates worker start (ADR 0030);
- from the MCP credentials issue, fix 1 (a `quill doctor` warning about likely-missing worker variables and an opt-in `[worker] env_passthrough` in the LaunchAgent or systemd unit) and fix 3 (a `[prod.readonly.git_env]` slot for provider API reads without push). Both are 1.1.x/2.0.x candidates. Its fix 5, naming the literal-path alternative in guard refusals, is not done either.

### Known gaps

The task reports noted these; none of them is a defect in what shipped:
- **No dashboard UI for ticket worktrees.** `quill worktree list|remove` only. The owner snapshot carries `ticket.worktrees[]`, but no view renders it.
- **The dismissal reason is CLI-only.** `quill agent dismiss … --reason`. The dashboard's Dismiss sends none, though the ticket Runs tab shows recorded reasons.
- **No "Mark reviewed".** A Ready to review item clears when its ticket is done, its PR merges or closes, a later run supersedes it, or 7 days pass.
- **Bitbucket CI** is not watched, and Bitbucket run PRs have no revert check, so recipe stats show them as "not yet known".
- **The receipt is not shown on the dashboard.** It is in the draft PR body and `quill receipt <run>`.
- **The whole-process Pre/PostToolUse latency KPI is not met.** Whole-process p95 sits about 70–115 ms above a bare Node start on the loaded reference machine (about 53 ms on the unloaded 0.6.1 run), against a target of 15 ms. In-process `runHook` meets its p99 target on the least loaded run. Reaching it needs fewer modules on the per-call path (ADR 0034, Alternatives).
- **The run-env fingerprint includes per-run grants.** Push or a draft PR keeps the git system's tokens, and scopes and Bedrock/Vertex sign-in change report words. So a run with different grants stales entries learned under others. This conservative staling is intended (ADR 0041, residual risks).
- **A variable the worker never inherited is not "removed".** For example, `CRE_JENKINS_HOST` under a macOS LaunchAgent. The Environment section cannot list it; that is issue fix 1.
- **The plan's Task 13 browser check was not run with this documentation task.** The plan asks for `npm run test:acceptance` and a headless browser check of run detail, Needs you and the critical item at 390×844 and 1280×720. Neither was run here; run both before tagging.

## Status (runs-first dashboard)

The sections below are the original handover and are kept as written. The `feat/runs-first-dashboard` branch resolved these items:

- P1 full results: run detail offers the full result, or the partial result of an unfinished run.
- P1 Sessions checkpoint link: resolved on this branch.
- P2 batch history after reload: batch summaries are derived from run records.
- The Runs surface: Needs you, Live, Failed and All tabs, rows grouped by batch.
- Run detail evidence: result, changes, delivery, uncertain effects and suggestions in one panel.
- Ticket run discovery: a run strip under the title and a ticket Runs tab.
- Dispatch consolidation: one Run agent dialog for every recipe.
- Attention dot: Runs shows a separate "needs you" dot beside the live count.
- Mobile navigation: grouped Work and Track navigation, with five phone items and More.

Still open: authoritative wait reasons and phases, worker readiness projections, and filter-scope labelling beyond the approvals button.

Prepared 11 October 2026 (Asia/Calcutta).

## Autonomous runs 1.1

Added 19 October 2026 at the end of the FEAT-12 plan (branch `feat/autonomous-runs`, version 1.1.0). This section describes what is implemented on that branch. Everything under "Open" is not.

### Where to read

- Behaviour: spec `docs/superpowers/specs/2026-10-12-autonomous-runs-design.md`, and the ADRs that supersede it where they differ: [0026](decisions/0026-autonomous-access-and-guard.md) (access, guard, credentials, boundary statement and residual risks), [0027](decisions/0027-run-memory.md) (memory) and [0028](decisions/0028-critical-changes.md) (critical changes and action pins).
- Data: `docs/DATA-CONTRACT.md`, section "Autonomous runs index (1.1.0)", which lists every new request kind, event, field, error code and Needs you item type.
- UI: design system §5–§7 (access badge, run detail sections, Run agent dialog, critical change item, Memory page and shortcut 8, recorded and claimed stage, estimated cost).
- Setup: README, "Autonomous runs".

### What shipped, and where the code is

- **Access ladder.** `autonomous` is the default for the dashboard, bulk dialog, `quill agent run` and `quill handoff`; schedules, page proposals and file runs stay `standard`. It needs Claude Code 2.1.295 or later (`runtime-too-old`). Code: `src/handoff/permissions.js`, `src/handoff/autonomous.js`, `src/handoff/inventory.js`.
- **Run guard.** A PreToolUse hook (`bin/quill-guard.js`) decides every call against a frozen, hashed `grant.json`. It uses the classifier `src/gate/prod-classify.js` (with `shell-tokens.js`) and the decision logic `src/gate/run-guard.js`. It fails closed, and in full access it only observes, recording `prod_effects`. Run settings: `src/handoff/run-settings.js`, `grant.js`.
- **Credential isolation.** `src/handoff/cred-env.js` redirects every known credential location to `[prod.readonly]` profiles or empty stubs and records `cred_report`. Settings live in `src/config/credentials.js`.
- **Write scopes.** The catalog is `src/config/scopes.js`. Shell coverage uses allow-lists in `src/gate/scope-commands.js` (rulings R24–R26). Request and dispatch checks are in `src/handoff/scopes.js`.
- **Run method, budgets and the result contract.** `src/handoff/runner.js` (METHOD, `budgetFor`, `recipeCaps`), `stream.js` (stream-json, result event only, ledger), `reconcile.js` and `stage.js` (recorded stage). The recipes are in `recipes/`, including the new `critical-change` and `verify-deploy`.
- **Memory.** Files: `src/memory/*` (filing, delivery, projections, instruction filter, worker facts), the `memory-tx` reducer `src/core/reduce/memory.js`, the Memory page `ui/views/memory.js`, and `quill memory` in `src/cli/commands/memory.js`.
- **Critical changes.** Files: `src/handoff/critical-changes.js`, `action-pin.js`, the reducer `src/core/reduce/critical.js`, and approval in `src/server/requests.js`. Child tickets are local-only.
- **Run detail, Runs and Needs you.** Files: `ui/views/run-detail.js`, `ui/views/runs.js`, `ui/lib/runs.js`, `ui/components.js` (critical change and memory items, access fieldset, autonomy notes) and `ui/views/agents.js` (access badge, recipe caps, §7.6 note).
- **Resume and batch budget.** `src/handoff/resume.js` (R54–R56).
- **Privacy.** The allow-lists are in `src/export/sanitize.js` and `src/worker/notes.js`. A sentinel test asserts that nothing new reaches exports, the mirror, publishers, tracker pushes or vault notes.

### Deliberate deviations from the spec

These are recorded in the ADRs and DATA-CONTRACT; keep them unless the owner decides otherwise:
- R38: the guard refuses `quill memory list|show` in autonomous runs.
- R43: an approved critical run must run the exact pinned command or MCP input; normalised equality is used only to validate a proposal.
- R44–R48: critical proposals are validated once, at emission. Truncated or hidden-character actions are never pinned. A pin must pass the guard's own scope coverage.
- R46/R49: local-only tickets and their runs never reach the vault.
- R51–R53: the recorded stage never shows the floor, full-access production writes are owner-only, and exports carry `scope_count` only.
- R55/R56: an interrupted run's possible writes are owner-only beyond a count, and a scoped resume is dashboard-only.

### Verified in Task 20

These checks ran on the branch:
- `node scripts/build-ui-assets.mjs --check`
- `npm test`
- `node --test "tests/ui/*.test.js" "tests/export/*.test.js"`
- `npm run test:acceptance`
- A Playwright (msedge) check with a real viewport, against an isolated dev-seed store. The snapshot was patched in the browser with an autonomous scoped run, a full-access run, an interrupted run, a batch over budget and a critical change. It ran at 390×844, 1024×768, 1280×720 and 1440×900, light and dark. It covered the Run dialog, run detail with every section, Memory, Needs you with a critical change item, Runs with "Batch budget reached", sticky dismissal across polls, an edit draft across polls, and Save while a change applies.

The check found that long scope targets overflowed run detail and the Needs you item; this is fixed in `ui/styles.css`.

### Open, not done

- **Real end-to-end acceptance (spec §11, last bullet).** It needs owner actions first: read-only profiles in `[prod.readonly]`, and the Argo CD and Elastic MCP servers. Then check these:
  - a run uses Jira, the repository, Argo CD and Kibana reads;
  - a second run reuses memory;
  - an unscoped run proposes a critical change;
  - the approved run performs exactly the pinned change and is refused a different write in the same scope;
  - a full run is not blocked.
- **The live recipe-driven production-write refusal check** (deferred from Task 10): an autonomous run told to make a prod write must be refused and record a critical change.
- **CLIs not exercised against redirection.** kubectl, aws, gcloud, az, argocd, glab and psql were not installed on the probe machine. git and gh were verified.
- **`quill doctor` does not yet show read-only profile health or the tool inventory** (spec §4.4, §8). It checks only the Claude Code and git versions for autonomous runs. The guard's onboarding refusal and the Run dialog still say "quill doctor shows what is set"; the Run dialog is where that state is shown today.
- **Turn and spend fields in the Run dialog** (spec §8). They are CLI only (`--max-turns`, `--budget`).
- **Final-review candidates** recorded in the FEAT-12 ledger:
  - Windows `git.exe` resolution inside a checkout.
  - The reducer accepts `memory-tx` and `request-tx` events from any ingress producer.
  - `git replace`, `update-ref` and `notes` in a worktree.
  - Unchecked directory options: `go -C`, `gradle -p`, `just -d`, `cargo --manifest-path`.
  - `npm publish` with a `publishConfig.registry` or project `.npmrc` registry.
  - Memory re-filing at worker start can be slow.
  - `runHistory` for page-proposed runs.
  - Small TOCTOU windows in resume.

## Start here

The user requested a UI/UX audit, approved the recommended update, then asked to push it and re-analyse remaining gaps and user friction against the orchestration-engine scope. The latest request is to prepare this handover document.

The UI update is implemented and pushed. The follow-up audit identified confirmed defects and product gaps; those follow-up changes are **not implemented**, except for the Pick next checkpoint-association fix described below.

The user wrote “orchestration engine v.10.” This handover interprets that as **Orchestration-first 1.0**, because that is the documented scope, package version and branch. No separate v10 specification was found. Do not silently invent a v10 architecture.

Primary conclusion: the dashboard now helps users choose and inspect tickets more quickly, but operating agent runs still requires moving between ticket details, batch strips and Activity. The next work should complete the dispatch → monitor → inspect evidence → decide → recover workflow.

## Repository and delivery state

- Workspace: `C:\Users\shiva\Downloads\session-tracker-docs\session-quill-1.0`
- Branch: `feat/orchestration-1.0`
- Remote: `origin`, `git@github.com:nulllvoid/session-quill.git`
- Pushed commit: `144c056ea87bffa116876c34fc8ce340110875d4`
- Commit subject: `feat(ui): prioritize work and simplify ticket navigation`
- Local HEAD and upstream were verified equal before creating this document.
- The working tree was clean before this document was added.
- No PR was created, no merge performed, no release/tag published, and no installed plugin or real worker restarted during this work.
- This handover is a new local document; it is not part of the pushed commit above.

Inspect `git status` before editing: other agents or the user may have changed the workspace since this handover.

## Scope sources and constraints

Read these before implementing orchestration changes:

1. [Orchestration-first delivery plan](superpowers/plans/2026-10-11-orchestration-1.0.md)
2. [Always-on dashboard and run timings](decisions/0022-always-on-dashboard.md)
3. [Bulk runs and worker test gate](decisions/0023-bulk-runs-and-test-gate.md)
4. [Tracker onboarding](decisions/0024-tracker-onboarding.md)
5. [Remote run proposals](decisions/0025-remote-run-proposals.md)
6. [Data contract](DATA-CONTRACT.md), [UI design](UI-DESIGN.md), [README](../README.md) and [changelog](../CHANGELOG.md)

The plan references an external Claude document and its review. That external document was not accessed in this audit; findings use the repository's delivery plan, ADRs and implementation.

Preserve these boundaries:

- Node >=22, ES modules, plain HTML-string UI renderers, existing CSS tokens; no framework migration, bundler or new runtime dependency required.
- Deterministic worker logic owns repository resolution, scheduling limits, batching and test verification. Agent claims do not substitute for worker evidence.
- One queued/running reservation per ticket; fix serialization and configured concurrency limits must remain enforced by the worker.
- Shared-page edits create proposals, not immediate runs. Owner approval remains required.
- Clone consent and explicit commit/push/PR permissions remain intact.
- Read-only exports must retain capability restrictions and privacy sanitization.
- “Queued”, “running”, “tests passed” and “done” must remain distinct states. A completed run is not automatically a completed ticket or a deployment.
- No prewarmed worktree pool or nested run-group display was approved in the 1.0 plan. Do not expand into autonomous DAG execution or automatic approval under a UI task.
- Use test doubles for OS registration, tracker calls and clone operations; do not exercise the user's real machine configuration through tests.

The historical plan contains “Never push” and an author-specific commit trailer. The human explicitly authorized the push in this conversation, and it was completed. Do not fabricate authorship. Treat future push/release actions according to the actual user request and current repository instructions.

## What shipped in 144c056

### Shell and navigation

- Compact page titles and statistics replace the large introductory headings.
- Navigation can collapse to 72px on desktop; preference persists in local storage.
- “Today” is labelled “Activity”; “Tree” is labelled “Relationships”. Internal route IDs remain `today` and `tree`.
- Connection/workspace diagnostics move into disclosures. Provider failures and offline state remain visible.
- A global pending-proposals button opens Activity and clears filters so proposals are not hidden by an unrelated project selection.
- Detail docking considers available width after the sidebar, rather than only a fixed viewport breakpoint.

### Pick next

- Ranked recommendations precede unlinked work.
- Unlinked work is collapsed under “Needs your attention”; open disclosure state survives polling.
- Added “Where you left off” with a checkpoint preview and a context link.
- During the follow-up audit, fixed a new association bug: the preview now comes from an actual complete checkpoint and its recorded `ticket_id`, rather than pairing a session's old preview with its current ticket. A regression test covers switching tickets after a checkpoint.
- Local ticket keys truncate visually on cards; full keys remain in the copy payload and hover title.

### Ticket details and Sessions

- Status/Handoff controls, next action and latest checkpoint come before long-form content.
- Overview, Activity and Delivery tabs group existing sections; arrow/Home/End keys navigate tabs.
- Expanded ticket view uses the content area; close/Escape restores context.
- Modal ticket details make background controls inert and trap Tab at the panel boundaries.
- Sessions show a longer checkpoint preview, a “View checkpoints” action and the current next action; binding metadata is collapsed.

### Changed files

- `ui/app.js`, `ui/components.js`, `ui/styles.css`
- `ui/views/header.js`, `picknext.js`, `detail.js`, `sessions.js`
- `tests/ui/render.test.js`, `tests/ui/workspace-design.test.js`
- `CHANGELOG.md`
- `docs/images/dashboard-pick-next.jpg`, `dashboard-board-detail.jpg`

## Verification already completed

| Check | Result and limit |
| --- | --- |
| Full `npm test` before the final checkpoint-association fix | 809 tests: 807 passed, 2 skipped, 0 failed |
| UI and export tests after that fix, on the pushed code | 100 passed, 0 failed |
| `git diff --check` | Passed before commit |
| Browser, 1280×720 | Top recommendation and Handoff action visible without scrolling |
| Browser, 390×844 | Document width equals viewport width; filter strip scrolls internally |
| Browser, 1440×900 / dark mode | Visually inspected |
| Keyboard and navigation | Ticket opening, tab arrows, expansion, Escape, and modal focus boundary checked |
| Workflow checks | Approval shortcut clears filters; checkpoint loading renders; Sessions opens Activity; unlinked-work disclosure survives polling |
| Browser runtime | No page errors in the tested flows |

Do not report that the full suite was rerun after the final association fix. Only the UI/export suite was rerun at that point.

Browser checks used the isolated development store from `node scripts/dev-seed.mjs`, not the user's live data. Both temporary development servers were stopped. Do not reuse the old one-use authentication URLs. No credentials are included here.

## Confirmed defects to address first

### P1 — Full run results are fetched but never displayed

**Origin:** Existing defect, exposed by the orchestration audit.

**Evidence:** `ui/views/agents.js` `runItem()` renders “Partial/full result” using `data-action="load-content"`. `ui/app.js` stores the fetched text in `appState.content`. `renderDetail()` receives that cache, but does not pass it to `renderAgentsSection()`, and run rendering never reads it. Timeline “Full text” has the same missing display path in `timelineItem()`.

**Reproduced:** Rendered a fixture ticket containing a run with `result_ref`, supplied a unique text sentinel in `content[result_ref]`, and verified that the result button exists while the text does not appear in the rendered HTML. This was a renderer-level reproduction, not a browser/network failure test.

**User friction:** A user clicks for evidence and sees no result. This blocks informed review even when the run succeeded.

**Fix:** Thread loaded content through run/timeline renderers or provide a shared content viewer. Add loading, empty/unavailable and visible failure states. Currently `load-content` only reacts to `generation-expired`; other fetch failures are not surfaced.

**Acceptance:** Clicking a run's result or timeline full-text action renders that item's escaped content. Failed loads show Retry. Polling/generation changes do not silently leave the user with an unexplained empty viewer. Test both full content and denied/unavailable content.

### P1 — Sessions checkpoint shortcut can open the wrong ticket

**Origin:** The new shortcut exposes an existing mismatch between session-wide last checkpoint and current ticket binding.

**Evidence:** `ui/views/sessions.js` displays `s.last_checkpoint_preview` but links “View checkpoints” to `current.id`. `src/core/reduce/sessions.js` `bindSession()` updates the current ticket without clearing the last checkpoint. `src/core/reduce/capture.js` records the checkpoint's own ticket and binding revision.

**Reproduction to automate:** Capture a checkpoint on ticket A; bind the same session to ticket B without capturing another checkpoint; open Sessions. The visible checkpoint remains A's, but the shortcut opens B's Activity. The Pick next equivalent was fixed before push; this Sessions path remains open.

**Fix:** Resolve `last_checkpoint_id` against the checkpoint collection and navigate using its recorded ticket. Distinguish the current ticket's next action from the checkpoint's historical ticket context. Handle unbound/missing checkpoints without inventing an association.

**Acceptance:** A→B rebinding still opens A's displayed checkpoint; B can remain separately labelled as the current ticket. Add a regression test and browser check.

### P2 — Completed batch summaries disappear after reload

**Origin:** Existing behavior; a stronger product gap under orchestration-first scope.

**Evidence:** `ui/lib/bulk.js` `activeBatches(snapshot, known)` includes terminal batches only when their IDs are in the page's `known` list. `ui/app.js` initializes `batches: []`; strips render only on Board and Pick next.

**Reproduced:** A done batch returns `['demo']` when `known=['demo']`, and `[]` with the same snapshot and `known=[]` after a simulated reload. The run records are not lost; their aggregate summary is no longer surfaced.

**Fix:** Derive recent/history batches from recorded handoffs, provide a stable detail route, and retain access to failed/skipped/completed members. Persistence of UI dismissal must not be mistaken for persistence of run history.

**Acceptance:** Queue a mixed-outcome batch, reload after completion, and still find the batch and every member outcome. Running, failed and completed views must survive closing/reopening the browser.

## Orchestration scope gaps and design recommendations

These are recommended follow-up work, not implemented features or proof that the worker lacks the corresponding capability.

| Priority | Gap and source evidence | Recommended behavior | Acceptance target |
| --- | --- | --- | --- |
| P1 | No global run workspace. `NAV_ITEMS` has ticket, relationship, session, deployment and activity views; runs live in ticket detail. | Add a Runs surface with Running, Queued, Needs review, Failed and History filters, linked to tickets and batches. | From any page, reach an active/failed run in one navigation step; inspect/cancel/retry without searching individual tickets. |
| P1 | Review evidence is incomplete. The worker records `patch_path`, `worktree_path`, `pr_url` and `uncertain_effects`; the Agents renderer has no dedicated presentation of these fields. | Provide a run detail view for diff/result, worker test evidence, local checkout location, PR link and uncertain side effects. Expose artifacts through authorized endpoints; never turn arbitrary local paths into unrestricted file reads. | A completed fix tells the owner what changed, what was verified and where it exists. Partial push/PR outcomes remain explicitly uncertain. |
| P1 | New tabs make run discovery ambiguous. `detail.js` keeps proposals and Agents in Overview after Description, Status, Approved plans and Follow-ups. Activity contains timeline/checkpoints, not the actual run controls. | Give Runs a labelled ticket section and surface a current-run/approval summary near the title. Keep timeline as history. | A user opening a running ticket can immediately find status, test evidence, cancel/retry and pending suggestions. |
| P2 | Queue reasons are not visible after submission. Bulk preview mentions capacity and “waits for repo”; run items mainly show queued/running and recorded timings. | Project the authoritative wait reason and current phase from worker state: capacity, repository lock, setup, agent, tests, repair. | Every queued run explains its wait; live phases never claim tests passed before worker evidence exists. Do not fabricate ETA. |
| P2 | Dispatch has competing concepts: Handoff, Run recipe, Analyze, Attempt fix, and Queue run. Legacy/built-in and recipe suggestion behavior differs. | Use one task-oriented Run agent entry with explicit recipe, scope, source access, test verification and side effects. Preserve legacy semantics until deliberately migrated. | Before queueing, users can tell whether the run reads/edits, where it runs, whether tests are configured and whether results need acceptance. |
| P2 | Readiness is weak at the point of dispatch. `renderHandoffForm` accepts a `prerequisites` object, but the app does not supply it. Missing repo/test configuration often leads to prose or CLI guidance. | Add a worker-derived readiness summary with actionable repo/clone/auth/test-command blockers. Keep notes-only analysis available where supported. | A fix cannot look ready when required prerequisites are missing; missing test command is explicitly unverified, not silently treated as a pass. |
| P2 | “Where you left off” and attention items still follow all recommended cards. Ticket “Needs attention” stats count blocked/stale tickets, not run failures or pending suggestions. | Separate work selection from operator attention: a compact attention strip with precise counts and direct links; place recovery context near the first recommendation. | Counts name their entity and scope. Failed runs, approvals and unreviewed results can be reached without scrolling through five recommendations. |
| P2 | Filter scope differs across sections. Pick next stats/recommendations are filtered, while attention deployment counts are global; the deployment shortcut retains current filters. | Explicitly label global counts or filter them consistently. A global-count shortcut should open the matching unfiltered destination. | Clicking an “awaiting deployment” count opens the items that count represents, including under a project filter. |
| P3 | Navigation labels changed but documentation still uses Today/Tree in several places. Small-screen six-item navigation truncates long labels. | Align user-facing docs/help with Activity/Relationships; evaluate a shorter mobile navigation or More menu if Runs is added. | Route compatibility remains intact; users can read labels and find every primary workflow at phone width. |

## Suggested implementation order

1. **Correctness and evidence:** fix full-result/timeline display and Sessions checkpoint association. Cover failure states and escaping. These are small changes and do not require an architecture rewrite.
2. **Durable run visibility:** derive run/batch history from snapshot records; add stable navigation to an individual run and its ticket. Keep request-submission outcomes distinct from execution outcomes.
3. **Orchestration UX:** add the Runs surface and relocate ticket run controls so their purpose is obvious. Consolidate operator attention without reintroducing a tall home-page introduction.
4. **Readiness and queue explanations:** add only the worker projections/endpoints needed for accurate preflight and phases. Document any contract/event changes and update ADRs as appropriate.
5. **Polish and docs:** consistent action names, filter scope, mobile navigation and refreshed screenshots.

Avoid another palette/font redesign. Retain Geist, evergreen accents, semantic status colors and existing motion/reduced-motion support.

## Recommended test scenarios

- Completed/failed run → full result, loading failure and Retry; long output remains readable and escaped.
- Checkpoint on A → rebind to B → Sessions still opens the checkpoint for A.
- Mixed-outcome batch → reload → all members and aggregate outcome remain discoverable.
- Two fixes for one repo → second run explains its wait; cancellation does not falsely claim the active run was stopped when only queued members were cancelled.
- Fix with no test command → explicitly unverified; worker failure → repair → failure remains distinct from success.
- Proposal arrives while an unrelated project filter is active → global approval shortcut reaches it; no run starts without approval.
- Missing repository, needs-clone, no-code and notes-only analysis each have appropriate actions.
- Read-only export → no owner-only mutation controls or newly exposed local paths/logs.
- Keyboard-only use of Runs/ticket tabs, modal boundaries, Escape, and focus restoration; opening a drawer while a health popover is open deserves additional coverage.
- 1280×720, 1440×900, 390×844, light/dark, reduced motion, large ticket/run lists and long keys.

## Commands and local tooling

```powershell
git status --short
git log -3 --oneline
node --test "tests/ui/*.test.js" "tests/export/*.test.js"
npm test
git diff --check
node scripts/dev-seed.mjs
```

The seed helper creates a throwaway store and prints a one-use owner URL. Keep that secret out of commits/docs. Stop the helper when finished; do not restart the real user worker for screenshot tests.

The default `python` command was not available in this session. Bundled Python was available at:

`C:\Users\shiva\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`

Use `-X utf8` or explicit UTF-8 file encoding on Windows. A first editing attempt exposed Windows default-encoding/newline issues; they were normalized before commit. `git diff --check` passed. Load current workspace dependency paths again if the runtime bundle changes.

Browser checks used Playwright from the bundled Node modules, without adding a project dependency. Test scripts/logs were temporary; only the renderer regression tests and documentation screenshots are committed.

## Next-agent kickoff

Read this handover and the 1.0 delivery plan, verify the branch and working tree, then reproduce the two P1 correctness defects before changing code. Start with result rendering and checkpoint ownership. Present the Runs workspace and deeper orchestration additions as the recommended next scope; do not describe them as already implemented. Preserve the worker's approval, verification, concurrency and export boundaries throughout.
