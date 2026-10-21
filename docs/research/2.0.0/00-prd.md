# Product Requirements Document (PRD): session-quill 2.0.0

Metadata

 | Details

 | Product

 | session-quill (Local-First SWE Session & Agent Orchestrator)

 | Target Release

 | v2.0.0

 | Status

 | Draft / RFC

 | Core Architecture

 | Single-Writer CLI (0001), Mandatory Local Event Store (0002), Hook-Driven Governance (0003)

 | 

## 1. Executive Summary & Vision

In v1.x, session-quill established a local-first control plane that links issue trackers (Jira, Linear, GitHub), local terminal/Claude Code sessions, shell execution guards (quill-guard), and an always-on local dashboard (0022).

The Vision for 2.0.0: Transition session-quill from a session tracker & command guard into a full-lifecycle Autonomous Engineering Cockpit. Version 2.0.0 solves the four biggest bottlenecks software engineers face when working with coding agents:

- Working Tree Contention: Agents mutating files while the engineer is trying to work or review.

- Context Cold-Starts & Repeat Failures: Agents burning tokens rediscovering architecture or repeating failed approaches.

- Review Fatigue: Reviewing massive, unorganized diffs without clear intent or proof of verification.

- Post-PR Blindness: Manually nursing failing CI checks and lacking empirical data on whether agent-assisted code is safe in production.

## 2. Target Personas & Core Pain Points

Persona

 | Pain Point in v1.x

 | v2.0.0 Outcome

 | Senior / Staff Backend SWE

 | Cannot run a background attempt-fix recipe while coding on another ticket in the same repo; reviewing 600-line AI diffs takes longer than writing it manually.

 | Zero-collision parallel worktrees + Intent-grouped diff walkthroughs with cryptographic-style verification receipts.

 | Tech Lead / Reviewer

 | Hard to tell if an AI-assisted PR actually ran tests, touched critical paths safely, or hallucinated its PR summary.

 | Deterministic PR Evidence Receipts generated directly from the local event journal (journal.js), not LLM prose.

 | On-Call / Platform Engineer

 | Production-adjacent CLI commands require nuanced dry-run validation, and secrets echoed in terminal output risk leaking into logs or trackers.

 | AST-aware dry-run enforcement in shell-grammar.js and Ingress-level secret redaction before events hit disk.

 | 

## 3. Key Pillars & Functional Requirements

### Pillar 1: Isolated Execution & Parallel Ergonomics (Git Worktree Engine)

Objective: Allow SWEs to run multiple interactive or autonomous sessions concurrently without branch switching or dirty working tree conflicts.

- FR-1.1: Automated Worktree Provisioning (src/cli/commands/start.js & worker.js)

- Adding --worktree (or setting worktree.auto = true in config.toml) automatically creates an isolated git worktree at .quill/worktrees/<ticket-id> on a dedicated branch.

- Automatically symlinks or copies untracked environment files (e.g., .env, .claude/) defined in recipes/workspace-setup.md.

- FR-1.2: Deterministic Checkpoint Snapshots (src/core/blobs.js)

- Before every recipe step or high-impact tool call, capture a fast git tree object (git write-tree) in blobs.js.

- Upgrade the Edit / Conflict / Undo UI (edit_conflict_undo_session_tracker) to allow 1-click rollback to any step boundary without corrupting the event journal.

- FR-1.3: Clean Teardown (src/core/cleanup.js)

- When a ticket transitions to Published or Closed (0021-pr-closes-its-tickets.md), automatically prune the worktree and archive the session's blob refs.

### Pillar 2: Context Intelligence & Anchored Memory

Objective: Eliminate cold-start token waste and prevent agents from repeating failed hypotheses.

- FR-2.1: Blast-Radius Context Brief (src/core/brief.js)

- On quill start <ticket>, automatically compute a deterministic Context Card before the first prompt:

- Co-change graph: Top 5 files historically modified alongside the target module (via local git log analysis).

- Historical Memory: Past session-quill tickets/runs that modified the same file paths.

- Active Guards: Relevant rules from prod-classify.js and 0028-critical-changes.md.

- FR-2.2: Symbol- & SHA-Anchored Run Memory (src/core/memory.js)

- Extend 0027-run-memory.md so memory entries include { file_path, git_blob_sha, symbol_name }.

- If a subsequent commit alters the anchored file's SHA beyond a diff threshold, mark the memory as stale so brief.js warns the agent instead of injecting outdated assumptions.

- FR-2.3: Negative Memory / Failure Ledger (src/core/reduce/memory.js)

- Whenever a test gate (0023) fails or a human rejects a diff hunk, record a structured FAILURE_NOTE event ({ hypothesis, files_touched, error_signature }).

- Automatically inject this ledger into handoff.js and retries so subsequent agents know what not to attempt.

### Pillar 3: Next-Gen Governance & Plan-Path Drift Guard

Objective: Harden quill-guard from a command blocker into an intelligent, low-friction safety harness.

- FR-3.1: Plan-Path Drift Detection (src/gate/run-guard.js)

- Enforce 0004-plan-path-first-claim.md at runtime: when an agent declares its target file paths in the plan phase, bind those globs to the session state.

- If the agent attempts to edit or write to a file outside its claimed plan paths, trigger a Scope Drift event—pausing execution or flagging an amber warning in scripts/statusline.js and the UI.

- FR-3.2: AST-Aware Dry-Run Interception (src/gate/shell-grammar.js)

- Upgrade shell-grammar.js and prod-classify.js with semantic profiles for kubectl, terraform, psql, gh, and aws.

- For mutating commands, require a verified dry-run execution (--dry-run=server, terraform plan, EXPLAIN) in the session journal before unlocking the approval prompt (quill approve).

- FR-3.3: Ingress Secret & PII Redaction (src/core/ingress.js)

- Move sanitization logic from src/export/sanitize.js directly into src/core/ingress.js.

- Strip high-entropy strings, Bearer tokens, AWS keys, and .env values before writing to journal.js or syncing via 0018-tracker-write-back.md.

- FR-3.4: Time-Bounded JIT Scope Leases (src/config/scopes.js)

- Allow quill approve --ttl 5m to grant temporary capability leases for specific command patterns during a single run, auto-revoking upon expiry.

### Pillar 4: Intent-Driven Review & Closed-Loop CI

Objective: Cut human code review time by 50% and automate post-PR CI fixes.

- FR-4.1: "Attention-First" Dashboard Triage (docs/ui/board_session_tracker)

- Introduce an Attention Triage Mode alongside the standard ticket board that groups runs by human bottleneck:

- 🔴 Needs Approval / Blocked (Waiting on quill-guard or Scope Drift confirmation)

- 🟠 CI / Test Gate Failed (Ready for attempt-fix dispatch)

- 🟢 Ready for Intent Review (done-when checks passed, awaiting human diff review)

- 🔵 Running Autonomously (Background workers active)

- FR-4.2: Adversarial Critic Recipe (recipes/critic-review.md)

- Before a run transitions to Ready for Review, automatically run a read-only critic pass that checks the diff against CLAUDE.md, DATA-CONTRACT.md, and 0028-critical-changes.md, annotating inline warnings in the local UI.

- FR-4.3: Intent-Grouped Diff Walkthrough

- In the session detail UI, group modified hunks by logical intent (e.g., Schema/State, Core Logic, CLI/Routes, Tests) rather than alphabetical file paths, with per-hunk "Reject & Re-prompt" actions.

- FR-4.4: Self-Healing CI Watcher (scripts/ci-annotate.mjs & worker.js)

- Background worker polls open PR checks (gh / Bitbucket 0007). On failure, ingests the failing log tail into the session inbox (0006) and stages a 1-click attempt-fix proposal (0025-remote-run-proposals.md).

### Pillar 5: Task Impact & Engineering ROI Receipts

Objective: Provide verifiable proof of verification and post-merge quality for every task.

- FR-5.1: Deterministic PR Evidence Receipt (src/cli/commands/publish.js)

- When quill publish creates or updates a PR, append a cryptographic-style Markdown receipt derived strictly from journal.js events:

- Test Gate Matrix: Exact commands run (0016 / 0023), exit codes, duration, and commit SHA.

- Governance Audit: Count of quill-guard blocks, prod-classifications, and human approvals.

- Blast Radius Score: Calculated from critical-path files touched (0028), config changes, and test-to-code ratio.

- FR-5.2: Post-Deploy Impact & Autonomy Telemetry (src/core/usage.js & deploy/)

- Link recipes/verify-deploy.md and src/deploy/environments.js to track post-merge outcomes:

- Autonomy Score: Ratio of autonomous agent steps vs. human interventions/rollbacks per recipe.

- Recipe Change Failure Rate (CFR): Percentage of runs per recipe (attempt-fix, critical-change) that required a hotfix or revert within 48 hours of merge.

## 4. Technical Architecture & Performance Upgrades

To keep session-quill fast and lightweight as a local daemon:

- Unix Domain Socket IPC (~/.quill/daemon.sock):

- Problem: Spawning a fresh Node.js process on every bin/quill-hook.js invocation adds latency (bench-hooks.mjs).

- Solution: Have the always-on dashboard daemon (0022) listen on a local Unix socket. quill-hook.js becomes a <5ms thin client that streams hook payloads to the warm daemon process, falling back to direct single-writer CLI execution if the daemon is offline.

- Journal Snapshot Compaction (src/core/journal.js & store.js):

- Problem: Replaying thousands of journal events in reducer.js slows down statusline.js over time.

- Solution: Write a materialized state checkpoint (state.snapshot.json) every 500 events in store.js. reducer.js hydrates from the latest snapshot and only replays the delta tail.

## 5. New Event & Data Contract Additions (docs/DATA-CONTRACT.md)

New event types to add to src/core/events.js and src/core/reduce/:

- WORKTREE_MOUNTED / WORKTREE_PRUNED ({ session_id, path, branch, base_sha })

- CHECKPOINT_CREATED / CHECKPOINT_RESTORED ({ session_id, step_index, tree_sha })

- PLAN_PATHS_CLAIMED / SCOPE_DRIFT_DETECTED ({ session_id, claimed_globs, violated_path })

- MEMORY_ANCHORED / MEMORY_STALED / FAILURE_RECORDED ({ ticket_id, file_path, blob_sha, reason })

- RECEIPT_GENERATED ({ ticket_id, pr_url, journal_hash, blast_radius_score })

## 6. Phased Rollout Plan (v2.0.0)

Milestone

 | Scope

 | Key Files Touched

 | M1: Core Speed & Isolation

 | Snapshot compaction, Ingress secret redaction, Automated Git Worktrees, and Checkpoint blobs.

 | journal.js, ingress.js, blobs.js, start.js, cleanup.js

 | M2: Smart Guard & Memory

 | Plan-path drift guard, AST dry-run enforcement, SHA-anchored memory, and Negative failure ledger.

 | run-guard.js, shell-grammar.js, memory.js, brief.js

 | M3: Review & Impact Loop

 | Attention-First UI board, Intent-grouped diff view, PR Evidence Receipt, and CI self-healing watcher.

 | publish.js, ci-annotate.mjs, worker.js, docs/ui/

 | 

## 7. Success Metrics (KPIs for 2.0.0)

- Hook Overhead: P99 execution time of quill-hook.js and statusline.js remains < 15ms (measured via scripts/bench-hooks.mjs).

- Review Velocity: 40%+ reduction in wall-clock time spent in the In Review / Handoff state before quill publish.

- Repeat Failure Reduction: Zero repeated identical test-gate failures across multi-session handoffs on the same ticket.

- Zero Secret Leaks: 100% interception rate of standard credential patterns at ingress.js before journal persistence.