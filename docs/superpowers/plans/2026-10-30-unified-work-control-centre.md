# Unified Work Control Centre Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver the approved unified Work, mode-based agent execution and daily continuity specification with working UI and durable backend contracts.

**Architecture:** Keep the event journal/single worker, domain request transport, existing agent runtime and vanilla-JS dashboard. Build shared deterministic Work rollups and revision-safe mutations, additive intent/plan contracts, and owner-only Daily update artifacts. Independent domains may proceed in parallel with shared-file integration owned by the root agent.

**Tech Stack:** Existing Node >=22 ESM, native test runner, vanilla JS/CSS, existing browser harness; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-unified-work-control-centre-design.md`

## Global Constraints

- Preserve existing journal, IDs, CLI recipes, schedules, export privacy and runtime guards.
- Auto ends at a tested patch unless delivery is explicitly granted; Full access is never a remembered/default fallback.
- No ticket/permission/status mutations from summaries or new intent-based result application.
- One source of truth for required-child completion; filters/paging cannot change full counts.
- Daily updates are local drafts; scheduled synthesis is opt-in and bounded; structured fallback requires no model.
- Do not modify the owner's live configuration or register another user's repositories during tests.
- User granted full control and requested completion ASAP/by morning: proceed through implementation, checks and delivery without another design/plan confirmation.

## Review Focus

1. Deep/cyclic/missing/private parent relationships: bounded traversal and honest visible counts (Tasks 1, 2, 7).
2. Concurrent edits and queued plan execution: no lost updates, stale authorizations or hidden permission upgrades (Tasks 3, 4).
3. Calendar/cursor boundaries, late events and restarts: no skipped evening work or duplicate progress (Tasks 5, 6).
4. Untrusted generated text and partial evidence: no invented delivery or private export leakage (Tasks 5, 6, 7).
5. Polling during input and constrained screens: stable focus/drafts, reachable Cancel/Stop and real acknowledgment states (Tasks 2, 7).

## Ownership and shared interfaces

- Root: `src/core/closure.js`, `src/core/work.js`, `src/core/state.js`, `src/core/reducer.js`, checkpoints/events, `src/server/requests.js`, `src/server/http.js`, `src/worker/projections.js`, worker integration, root docs and full-suite integration.
- Work/UI domain: `ui/**`, `tests/ui/**`; consumes `ticket.work_rollup` and domain request contracts below. Do not edit backend shared files.
- Agent domain: `src/handoff/**`, relevant `src/agents/**`, `recipes/plan.md`, agent/handoff tests; exposes helpers for root request integration. Do not edit UI/server/state/reducer shared files.
- Daily domain: `src/updates/**`, `src/core/reduce/updates.js`, `src/schedule/**`, daily/schedule tests; exposes request/reducer/read helpers for root wiring. Do not edit UI/server/state/reducer/checkpoint shared files.
- All workers use the same branch; do not stage/commit another worker's files. Send interface decisions early. Root makes integration commits after validation.

### Task 1: Authoritative Work rollups and nested completion

**Files:** create `src/core/work.js`, `tests/core/work.test.js`; modify `src/core/closure.js`, projections and closure tests.
**Interfaces:** `buildWorkRollups(state, { nowIso }) -> Map<ticketId, rollup>`; per-ticket `work_rollup` fields from spec §9.1, consumed by UI/updates. Reuse closure context; required completed excludes done conflicts.
- [x] Add regressions for 4/6 required, optional/unclassified, non-delivery, reopened grandchild, cycles/orphans, filtered/shared counts.
- [x] Run `node --test tests/core/work.test.js tests/core/closure*.test.js`; observe new failures.
- [x] Implement indexed bottom-up derivation and common closure conflict logic without changing manual statuses; publish only owner rollups.
- [x] Run those tests plus projection/export tests; require zero failures.
- [x] Record changes and evidence in progress ledger; commit tested domain changes.

### Task 2: Unified Work and navigation

**Files:** create `ui/views/work.js`, `ui/lib/work.js`, `tests/ui/work.test.js`; modify app, header, components, styles, detail/bulk and UI browser tests.
**Interfaces:** render Work using existing snapshot + rollups; filters preserve ancestry and stable IDs. Old board/tree/picknext routes alias Work with appropriate lens/root.
- [x] Test all-depth filters, contextual ancestors, fixed full counts, independent/completed disclosures, paging, sort, duplicate-free rows and route restoration.
- [x] Run `node --test tests/ui/work.test.js` and observe failures before implementation.
- [x] Implement compact expandable rows and detail continuity; remembered expansion/filter/lens/selection, explicit bulk IDs and priority/status controls.
- [x] Add keyboard/phone/short-screen/polling regressions in browser harness and run focused UI tests.
- [x] Verify W01–W11 with backend integration; record evidence and commit.

### Task 3: Revision-safe ticket management

**Files:** modify requests, reducer request/ticket helpers, events and data contract; create `tests/server/work-requests.test.js`.
**Interfaces:** `set-priority`, `create-subtask`, `set-parent` through `/v1/requests`, exact payloads per spec §9.2; root owns application and validation.
- [x] Test invalid priorities/descriptions, cycle/self/missing parents, stale child/old/new parent revisions, deterministic IDs, delayed undo, per-item bulk conflicts and local-only edits.
- [x] Run focused tests red, implement through existing mutation/apply helpers, preserve parent indexes and existing request limits.
- [x] Run server/core/CLI regression groups; zero failures; record and commit.

### Task 4: Intent-based agents and reviewed plan execution

**Files:** modify handoff permissions/results/context/extension and agent schema/helpers; add plan recipe/helper and tests. Root wires helper into server requests, reducers/content access. UI domain implements composer and plan review controls.
**Interfaces:** additive `intent` (`read-only`, `plan`, `auto`, `full`), `instructions` <=4000, source plan ref/revision + reviewed context/base. Intent resolution is server-authoritative. Plans use immutable blobs and semantic-context manifest; owner revision request <=20000 chars.
- [x] Add red tests for intent/permission incompatibility, source-free analysis, builtin shadowing, suggestions-only results, unchanged legacy behavior, plan revisions/context fingerprints/pinned base and dispatch changes.
- [x] Implement minimum helpers/runtime integration; no guard weakening or new approval bypass.
- [x] UI uses four options, persistent header ×/footer Cancel, explicit delivery, environment preflight, separate Stop and plan re-review.
- [x] Run all handoff tests and relevant server tests plus UI composer/browser tests; cover A01–A10.
- [x] Record and commit validated work.

### Task 5: Durable Daily update backend

**Files:** create `src/updates/{evidence,generate,extension}.js`, `src/core/reduce/updates.js`, `tests/updates/*.test.js`; root wires state/maps, events/reducer/checkpoint, worker extension and authenticated reads/requests.
**Interfaces:** state `updates` Map and `updateCursors` Map; reducer helper for journal update events; owner list/detail methods; `generate-update`, `edit-update` request handlers. Freeze scope/bounds/sequence/input blob before rendering. Return plan-compatible metadata and content refs, no full content in normal snapshot.
- [x] Add red tests for seven-week context, parent grouping at cutoff, evidence dedupe/trust, missing blobs/partial/stale sources, Today/Yesterday/DST/rolling windows, late/evening events, monotonic cursors and owner edits/regeneration.
- [x] Implement deterministic structured output first with provenance; optional bounded existing-runtime synthesis with validated evidence IDs/claims and fallback.
- [x] Implement durable creation/state transitions, idempotency, interrupt/cancel/retry recovery and cursor transaction; no side-effecting ticket outputs.
- [x] Run `node --test tests/updates/*.test.js` plus relevant replay/content/privacy tests; cover D01–D04/D06–D12.
- [x] Record evidence and commit.

### Task 6: Daily scheduling and owner configuration

**Files:** daily extension, schedule config/jobs/extension, owner config request integration; tests/updates and tests/schedule.
**Interfaces:** `daily-update` schedule job, `set-update-schedule` owner request with config fingerprint; inherited store timezone, named slot identity and explicit enabled/synthesis settings.
- [x] Test one catch-up after several missed days, DST repeated times, already-complete slot/restart, frozen retry input and no watermark on partial/failure.
- [x] Implement narrow atomic configuration preserving unrelated entries, schedule reload and explicit enabled/disabled defaults; no live configuration writes during implementation.
- [x] Run focused scheduler/config/update tests; cover D05/D09/D12 and config conflict/cost limits.
- [x] Record and commit.

### Task 7: Daily UI, attention, privacy and migration

**Files:** add `ui/views/updates.js`; update app/API/static-client/nav, attention reuse, detail, exports, help/docs, tests.
**Interfaces:** `/v1/updates`, `/v1/updates/:id`, existing authorized content; owner-only updates; work attention derives existing source identities. Sanitized preview rendered from eligible evidence before generation, never private prose redaction.
- [x] Test local vs shareable output, private descendant counts, static offline operation, generation progress/failure/edit/regeneration, configured-time opt-in and exact window/scope labels.
- [x] Implement UI controls, source citations, continuity disclosures, Copy for sharing/Download preview and schedule controls; expose existing actionable failures once.
- [x] Add title-quality regression without rewriting explicit owner titles; retain legacy recipes/routes/CLI behavior.
- [x] Run relevant export/server/UI/CLI tests, keyboard/browser checks and all acceptance mappings.
- [x] Record and commit.

### Task 8: Whole-product verification and delivery

**Files:** acceptance/data/UI docs, changelog, new benchmark fixture/script as necessary, regression fixes only.
- [x] Self-review every spec section and all 35 acceptance scenarios against implemented paths/tests. Close every substantive gap; do not call partial implementation complete.
- [x] Run `npm test` (redirect full output to task log) and existing browser harness with runtime NODE_PATH; require pass, document real skips.
- [x] Capture desktop/short desktop/tablet/phone screens and run design/contrast checks; fix visible flaws and test interactive paths.
- [x] Benchmark 2000 tickets/20000 events, 1000-child root and 50-level chain; report actual p95/hardware, fix regressions.
- [x] Obtain independent whole-branch review; fix important findings with regression tests, then rerun affected/full suites.
- [ ] Commit, push, integrate verified changes into main under user's full-control delivery authorization; verify remote result/CI. Do not publish a version tag merely to imply implementation completion.
- [ ] Disable the temporary continuation automation only when delivered; report outcome, evidence and remaining limits honestly.

## Progress and rulings

Execution ledger: `.superpowers/sdd/2026-10-30-unified-work-control-centre/progress.md`. Keep this plan's checkboxes and ledger current at integration boundaries. Baseline is `afa3254` (spec), application baseline `403eda6`.

Ruling: independent domain agents may execute Tasks 2/4/5 concurrently while root owns shared integration, then converge for Tasks 6–8. This follows the parallel dispatch skill and the user's full-control authorization; no repeated plan-approval pause is required.

Local verification completed: see `docs/CONTROL-CENTRE-VERIFICATION.md`. The final remote delivery and heartbeat shutdown are tracked in the execution ledger after this plan is committed.
