# Reconciliation Loop Implementation Plan

> **For agentic workers:** Use test-driven implementation and focused parallel work for independent polling and follow-up domains, followed by an integrated review. Steps use checkboxes for progress.

**Goal:** Reliably reconcile completed work, keep unresolved work revisitable, and prevent follow-ups from growing without completion rules.

**Architecture:** Reuse the journal/reducer and existing ticket/request lifecycle. A shared pure closure assessment gates automatic completion and cleanup. Provider checks are scheduled fairly using journaled observations; a derived owner-only closure queue explains unresolved work.

**Tech Stack:** Node ESM, native test runner, existing Fieldnotes UI; no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-developer-control-centre-design.md`, milestone 0. Workspace redesign and Jev are outside this implementation.

## Global constraints

- Reconciliation itself creates no tickets. Age alone never marks work done.
- Preserve manual decisions, private/local-only data, dirty worktrees, deployment obligations and revision checks.
- Closure is journaled and replayable; external tracker writes remain explicitly confirmed.
- Legacy parents are review candidates; absence of captured edits does not establish grouping-only intent.

## Review focus

- An open PR or unresolved child cannot be hidden by another merged PR.
- Poll caps, errors and old records cannot permanently starve a target.
- New child/run activity between preview and apply invalidates automatic closure.
- Poll refreshes cannot make old evidence override a manual reopen.
- Private closure details and local-only relationships never leak through exports.

### Task 1: Shared closure and lifecycle semantics

Files: new `src/core/closure.js`; transitions, reducer, ticket validation/CLI, cleanup and focused core/CLI tests.

Interface: `assessClosure(ticket, { tickets, handoffs, sessions, nowIso, complete = false })` returns `{ closable, reason, blockers, kind }`. `completion_mode` is `evidence` or explicit `children`; `blocks_parent` is nullable for legacy children. `resolution` records completed/duplicate/superseded/abandoned and a reason through existing ticket updates.

- [x] Add failing cases for open sibling PR, blocked parent, missing deployment evidence, legacy parent, active run, required/independent children and manual reopen.
- [x] Implement assessment and use it in automatic status transitions and cleanup; preserve manual set-status behavior while distinguishing resolutions.
- [x] Reassess completed evidence after related work finishes, including parents, without turning old evidence into a new manual override.
- [x] Verify focused tests and commit.

### Task 2: Fair polling and trustworthy associations

Files: `src/reconcile/run.js`, new polling helper, focused reconcile tests; reducer integration owned by Task 1.

Interface: reconciliation payload contains `checks` (journaled per-target attempts) and `coverage`; exported polling helper applies checks into `state.reconcileChecks`. Run-origin PR links include `handoff_id` provenance separately from run observations, and go through ordinary validated ticket evidence.

- [x] Reproduce 201-target starvation, failed-provider masking, unresolved records older than 30 days and reused branches.
- [x] Schedule oldest eligible targets first, persist bounded retry metadata, and keep old unresolved work in a slower sweep.
- [x] Link worker-created PRs to the exact origin ticket, validating run/repo/URL identity and environment policy; keep ambiguous branch attribution conservative.
- [x] Verify replay/fairness and existing provider fixtures; commit with integration.

### Task 3: Follow-up lifecycle without duplicate tasks

Files: suggestions, handoff output handling, core request reducer, focused agent/handoff tests. Request/UI input wiring integrated by Task 4.

Interface: accepted follow-up explicitly supplies `blocks_parent`; retains source run/suggestion/finding fingerprint and valid description. Exact matching existing children resolve to the existing task. Dismissed/accepted unchanged findings are suppressed on repeat; legacy auto-created result children become proposals for new live results, preserving journal replay.

- [x] Add failing tests for duplicate acceptance, repeated findings, missing Done when, proposal caps and legacy direct child generation.
- [x] Implement source identity/deduplication and explicit dependency metadata without conflating similar titles.
- [x] Verify no reconciliation/error path creates new tasks; commit with integration.

### Task 4: Closure queue and completion controls

Files: owner projections, request validation/application, ticket CLI, Runs attention/detail/actions, sanitization, tests and ADR/data contract.

Interface: owner snapshot `reconciliation` contains derived items and last coverage; each item targets an existing ticket. Existing revision-checked set-status requests carry optional resolution/grouping choices; automatic cleanup requests re-evaluate complete worker state before applying.

- [x] Test closure queue reasons, idempotent repeated sweeps, stale application, resolution semantics and privacy exclusions.
- [x] Render existing-ticket attention items with review/refresh links, explicit parent/follow-up choices and resolution reason controls; preserve static/offline behavior.
- [x] Update reducer version, contracts and ADRs; run full test suite and relevant UI/browser checks.
- [x] Independently review the integrated diff, fix important findings, and commit the verified implementation.

## Execution notes

User approved implementation on 2026-10-30. Reuse the clean checkout on branch `fix/reconciliation-loop`; do not touch the live Quill store. Polling and follow-up work may run in parallel with exclusive file ownership under the dispatching-parallel-agents skill. Integrate shared reducer/request/projection changes centrally. Push only when requested for this implementation.

## Verification record

Isolated regressions and independent review reproduced and corrected unsafe shared-branch attribution, completion after new run edits, older unresolved run effects, unnormalized completion settings, partial mutation after rejection, mismatched resolution reason validation, and hidden provider errors after acknowledgement. Final verification: `npm test` passed 5,064 tests with 8 skips (5,072 total); the 24-test browser suite passed. The standalone final full run also passed the checkpoint performance gate; an earlier concurrent run narrowly missed its timing ratio. Independent re-review found no remaining blockers. Commit-only work and monotonic work timestamps have separate regression coverage. No live store cleanup or remote tracker writes were performed.
