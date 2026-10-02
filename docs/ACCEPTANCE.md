# Session Tracker — Acceptance Scenarios

Status: v0.2 design · 2026-10-02 · All scenarios pending implementation
These are release requirements, not tests already executed. Record host/runtime versions, OS, fixture set and results when implementing each phase. A documentation review does not satisfy runtime acceptance.

## Phase 0 — Host and transport compatibility

| ID | Requirement | Scenario and expected outcome |
| --- | --- | --- |
| A01 | FR-1, FR-2, FR-13 | On each supported host/OS, unbound supported writes, unknown shell scripts, redirects, substitutions and registered mutating tools are denied; dedicated reads and every allowlisted shell form pass through normal host permissions |
| A02 | FR-2 | Unbound plan creation/approval succeeds only for the verified host plan path; source edits in plan mode and symlink/reparse escapes remain denied |
| A03 | FR-3 | Two sessions in the same cwd plus a subagent receive distinct identity mappings; missing identity never falls back to cwd |
| A04 | FR-5, FR-6 | Capture real approved/rejected/cancelled plan payloads and Stop/subagent payloads; rejected/cancelled plans never become approved records |
| A05 | FR-11, FR-13 | A real local UI submits a request, receives durable acknowledgement, sees local note revision change and displays confirmation; unauthenticated, wrong-Origin and wrong-Host requests cannot mutate |
| A06 | FR-13 | Actual installed command names and status-line integration work; existing user hooks/status line are preserved; absent or unsupported Node/host runtime gives an actionable diagnostic |
| A07 | FR-1 | Verify gate exception, malformed input, hook crash and timeout behavior. Document host fail-open limits; a valid binding never bypasses normal host permissions |

## Phase 1 — Persistence, attribution and recovery

| ID | Requirement | Scenario and expected outcome |
| --- | --- | --- |
| A08 | FR-3, FR-5 | Parallel sessions update one ticket and different tickets; no lost notes/events. Rebind while a tool is in flight: its result stays on its original ticket |
| A09 | FR-5, FR-7 | Force termination after ingress flush, journal append, note replacement and before generation commit; restart preserves every acknowledged event and publishes only complete generations |
| A10 | FR-5, FR-7 | Redeliver identical tool events, approvals and mutation requests; counts, timeline entries and revisions have one effect |
| A11 | FR-5 | Submit one event then no further hooks: note materializes within 30 s. Continuous events cannot extend the first-event deadline |
| A12 | FR-5 | Worker down but disk writable: capture persists pending ingress, visible backlog remains, restart drains it. Disk full/read-only: no false receipt; non-gate hook returns without blocking the session and reports a gap |
| A13 | FR-1, FR-3 | Worker/binding unavailable: covered writes denied when hook can respond. Gate off allows the operation with a visible unticketed/gate-off record; gate on restores enforcement |
| A14 | FR-6, FR-7 | A checkpoint longer than 1,500 characters remains fully retrievable/replayable. Duplicate approval is idempotent; missing/incomplete checkpoint cannot be promoted as complete |
| A15 | FR-6 | Heuristic off never auto-approves. When enabled, only the entire next eligible phrase within 10 min matches; quoted, negated, extended, late and different-binding prompts do not |
| A16 | FR-7 | Manual authored text survives update/replay byte-for-byte. Edited generated blocks become conflicts. Explicit import creates events. Journal-only rebuild does not claim recovery of missing authored files |
| A17 | FR-4, FR-8 | Duplicate slugs/child allocations produce distinct keys; relink preserves IDs/history/aliases. Collision, traversal, self-parent and cycle inputs are rejected. Jira network outage leaves validation pending and local binding usable |
| A18 | FR-13 | Second worker on the same store refuses ownership; a read-only copy on another machine cannot become a writer without explicit transfer |
| A19 | FR-5 | Run 1,000 representative cold/warm hook calls per supported OS, with 10,000 tickets and 100,000 events; report p95 <= 200 ms without full-log scanning on hook path |
| A20 | FR-5, FR-7 | Torn journal tail recovers from retained ingress; mid-log corruption stops recovery visibly. Failed tool with partial changes is marked unknown/partial, not counted as a verified successful write |

## Phase 2 — Migration

| ID | Requirement | Scenario and expected outcome |
| --- | --- | --- |
| A21 | FR-14 | Dry run changes no files; lists all mapped and ambiguous records, including stale and skipped-deployment cases. Every source ticket and user-authored section is accounted for |
| A22 | FR-14 | Import creates replayable migration events and preserves original files; verify counts, links, plan/checkpoint content, statuses and deployment obligations |
| A23 | FR-14 | Interrupt migration and resume without duplicate effects. Restore old hooks/settings and source layout from backup; preserve/export any new tracker events for reconciliation |

## Phase 3 — Reconciliation, UI and sharing

| ID | Requirement | Scenario and expected outcome |
| --- | --- | --- |
| A24 | FR-9 | Advance time without changing note mtimes: session becomes idle/extinct and active ticket becomes stale at boundaries. New work clears stale without losing status; compaction does not end a session |
| A25 | FR-9 | Blocked/done excluded before scoring; overdue due date counts once; ties deterministic; display capped at 100 while raw score determines rank; fewer than five candidates remains fewer |
| A26 | FR-9 | Repeated identical PR poll cannot undo a manual status. Multiple PRs/environments preserve separate obligations; draft/closed-unmerged PRs create none; done-with-pending still appears in Deployments |
| A27 | FR-10 | Fresh < 2 h, ageing 2–6 h, stale > 6 h, never-synced and disconnected all display correctly. Local sync with provider failure retains old evidence age and separate provider error |
| A28 | FR-11 | Two clients submit the same revision: one applies, one conflicts. Same request ID/body returns same result; same ID/different body rejects. Retry does not silently overwrite newer content |
| A29 | FR-11 | Cancel pending edit within its 10 s not-before window; no application occurs. Cancellation after application reports applied and offers a new revision-checked reversal |
| A30 | FR-10, FR-11 | Refresh begins within 5 s on idle online worker regardless of two-hour schedule; duplicate refresh joins active run; offline submission is not acknowledged as queued; failed run permits retry |
| A31 | FR-7, FR-11 | Crash with applying request: transaction recovery determines applied versus safe reevaluation; UI receives the final outcome rather than permanent pending |
| A32 | FR-10, FR-15 | Export exact selected fields/projects, inspect HTML for secrets/local paths/private links and mutation code; export opens without network and shows fixed export/sync times |
| A33 | FR-10 | At 1440/1024/800/390 px, owner retains authorized actions and viewer export has none; 60 cards/200 sessions remain usable; deep tree nodes remain reachable |
| A34 | FR-10 | First-time users identify next action under 10 s and stale state under 3 s; keyboard, input-safe shortcuts, focus return, reduced motion and measured light/dark AA checks pass |

## Phase 4 — Handoff

| ID | Requirement | Scenario and expected outcome |
| --- | --- | --- |
| A35 | FR-12 | Source-off analysis never reads local source. Attempt-fix without read/edit permission rejects. No commit/push/PR without each explicit dependent permission |
| A36 | FR-12 | Fix uses isolated base-commit worktree and leaves live session's dirty checkout unchanged; denied source/worktree setup produces failure, not silent note-only success |
| A37 | FR-12 | Concurrent tabs cannot reserve two runs for one ticket; fixes to one repo serialize; duplicate result delivery does not duplicate children |
| A38 | FR-12 | Execution reaches 20 min including sleep or user cancels: subprocesses stop; patch, logs and partial results remain linked; state timed-out/cancelled is visible |
| A39 | FR-12 | Worker restarts during run: state failed/interrupted, no automatic rerun. Uncertain push/PR effect is reconciled before an explicit retry |
| A40 | FR-12 | Default fix returns local diff/tests. Explicitly authorized push uses non-default/non-protected branch; draft PR is distinct from merged deployment work |
| A41 | FR-11, FR-12 | Parent changes during handoff: proposed next action conflicts against base revision; newer owner fields remain. Missing runtime/credentials fail at dispatch with reason |

## Phase 5 — Release evidence

All Must scenarios must pass, with exceptions explicitly removed from the advertised support matrix rather than concealed. Two outside testers install and track a session under 10 min with prerequisites already present. Verify README diagnostics and uninstall instructions, startup/wake recovery, tested version ranges, complete backup/restore, and public fixtures free of private data. No migration, publication or external sharing is performed by these documentation changes.

## Review resolution traceability

| Review issue | Resolved contract | Acceptance |
| --- | --- | --- |
| Gate overclaims and shell coverage | TRD gate matrix, bounded guarantee, fixture grammar | A01–A03, A07, A13 |
| Concurrent writers | Worker ownership, durable ingress, serialized journal/projections | A08–A10, A18 |
| Five-second vs 30-second capture | Separate durable receipt and bounded materialization | A09, A11–A12, A19 |
| Cwd binding/rebind history | Explicit identity, per-call binding snapshots | A03, A08 |
| Unchanged records never age | Full age scan, idle state, stale flag | A24 |
| Unspecified hosted integration | Local owner API, static sharing, later adapter contract | A05, A30, A32 |
| Edit conflict/undo/retry | Revisioned request state machine | A28–A31 |
| Missing UI data | Canonical schema and generation-consistent detail | A26–A27, A33 |
| Handoff permission/conflict rules | Explicit capabilities, isolated checkout, terminal outcomes | A35–A41 |
| Replay and checkpoint loss | Generated/authored ownership, full blobs, gap reporting | A09, A14, A16, A20 |
| Ranking, timezone, Jira offline, narrow UI | Deterministic filters/ties, all-day sync, pending validation, capability-based layout | A17, A24–A27, A33 |
