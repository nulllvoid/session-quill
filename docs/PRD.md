# Session Quill — Product Requirements (PRD)

Status: revised draft v0.2 · 2026-10-02 · Owner: Shivam
Companions: [TRD](TRD.md), [data contract](DATA-CONTRACT.md), [UI specification](UI-DESIGN.md), [acceptance scenarios](ACCEPTANCE.md), [decisions](decisions/).

## Product and users

A public Claude Code plugin that binds development sessions to tickets, preserves captured work in local markdown or Obsidian, and provides a personal dashboard for status, pick-next and agent handoff.

The primary user runs parallel sessions across repositories and needs to recover conclusions, approved plans, changes and next actions. Users without a note application receive the same core behavior. Teammates can read an explicitly exported snapshot, without editing the owner's quill.

The existing PMLA Delivery Tracker is the reference migration, not a dependency of the public product. Company-specific providers and skills belong to an optional profile.

## Guarantees and boundaries

- In strict gate mode, when functioning, supported mutating tool calls require a binding. The default nudge mode never blocks; it binds from ticket keys in the prompt or branch and asks once at the end of a turn about unlinked work ([ADR 0005](decisions/0005-gate-modes-and-auto-binding.md)). Unknown shell commands are denied until bound; only the documented read-only shell subset is exempt. This is a workflow gate, not filesystem isolation: external processes, disabled hooks and unsupported tools are outside its guarantee.
- Persisted events survive worker restarts and rebuild generated notes. A crash before the host emits an event, or storage failure preventing persistence, can leave a capture gap. Gaps must be visible; unobserved work cannot be promised recoverable.
- Full captured checkpoints are retained; the UI may shorten previews. Approval attaches to an exact checkpoint, ticket and session.
- Capture, notes, deterministic reconciliation and the local dashboard require no cloud account. Handoffs require an installed, authenticated Claude Code runtime; selected content may leave the machine through the user's configured model provider.
- One machine owns and writes a store in v1. Copies on other machines are read-only. Active multi-machine merging is deferred.

## Goals and success metrics

| Goal | Measure | v1 acceptance |
| --- | --- | --- |
| Ticket discipline | Supported mutating calls in gate fixtures | All denied when unbound; all permitted read fixtures remain usable |
| Correct attribution | Concurrent sessions, subagents, resume and rebind fixtures | No event assigned to another session's ticket |
| Recovery | Persisted events after forced worker termination | No missing events or duplicate effects after replay |
| Timely capture | Hook duration and note materialization | Hook p95 <= 200 ms; healthy worker materializes within 30 s of first pending event |
| Fast daily use | First-time users identify a next action and reason | Under 10 s in prototype testing |
| Visible freshness | Users identify a stale dashboard | Under 3 s in prototype testing |
| Easy installation | Two outside testers with prerequisites present | First tracked session within 10 min using README only |

## Scope

### Included in v1

1. Settings-hook gate, per-session binding, explicit gate-off escape hatch and binding indicator.
2. Ticket creation, parent links, local-to-Jira relinking, explicit checkpoint approval and optional approval phrases disabled by default.
3. Durable capture of supported tool results, approved plans, complete checkpoints, conclusions and pre-compaction recovery summaries.
4. Mandatory markdown folder or Obsidian store, project tagging, versioned notes, replay and validated migration.
5. Deterministic local reconciliation every two hours, all days, using the user's local time zone; manual Refresh runs promptly while the worker is available.
6. Local dashboard: Pick next, Board, Tree, Sessions, Deployments and detail panel. Owner actions: next action, status, deployment evidence, handoff, refresh and pending-request cancellation.
7. Read-only offline HTML and explicit, previewable snapshot export. A shared snapshot is a copy with an export time, not a live board or revocable link.
8. Handoff modes: analyse, analyse with follow-ups and attempt fix. Fixes use isolated checkouts and explicit read/edit/commit/push/PR permissions.
9. Plugin packaging, initialization, health diagnostics and PMLA migration with dry run, backup and rollback.

### Deferred

- Hosted live dashboards, remote wake-up and read-only hosted links until an authenticated adapter is implemented and verified.
- Shared team editing, active multi-machine stores, Jira/Notion as the authoritative store.
- Notion mirrors, Jira status sync, Linear/GitHub Issues links and optional mods.
- Automatic deployment, automatic merge and autonomous push to a default or protected branch.

Responsive layout never determines authorization. A narrow local owner window remains editable; an exported viewer snapshot is read-only at every width.

## Commands and key journeys

The documents use `/ticket` and `/approve` as shorthand. Installed plugin commands use their verified namespace, such as `/session-quill:ticket` and `/session-quill:approve`, unless an alias is installed. Help and denial messages show the executable command for that installation.

- Start unbound: read and plan using allowed operations; a covered write gives an instruction to bind or create a ticket.
- Create and bind: inherit project/category defaults, allocate a collision-safe key and display the binding.
- Resume or rebind: preserve historical attribution; new calls use the new binding, in-flight calls keep the binding recorded before execution.
- Approve: promote a selected full checkpoint once; record explicit versus heuristic provenance. Recorded approval is not permission to commit, push or deploy.
- Review: inspect freshness and recommendations; edit with visible pending/conflict/error outcomes.
- Handoff: choose mode and permissions, follow execution and inspect results, changed files and children.
- Share: choose projects/fields, preview the exact export, then save a read-only snapshot for the user to distribute.

## Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1 | Gate supported mutating tools and unknown/mutating shell commands when unbound (strict mode); enumerate exclusions and log gate-off use; offer nudge and off modes and bind automatically from configured ticket keys (ADR 0005) | Must |
| FR-2 | Permit dedicated reads/searches, tested read-only shell subset and verified host plan-file writes; plan mode is not a blanket write exemption | Must |
| FR-3 | Persist binding history by session/agent identity; support resume, rebinding and status display without directory fallback | Must |
| FR-4 | Create valid tickets with project/category defaults, unique keys and validated parent links | Must |
| FR-5 | Persist captured events before successful receipt; materialize notes within 30 s when healthy; surface gaps/backlog without blocking non-gate hooks | Must |
| FR-6 | Explicit approval promotes an exact checkpoint; opt-in phrases match the complete next prompt and retain provenance | Must |
| FR-7 | Records follow DATA-CONTRACT; replay preserves user-authored content and does not repeat effects | Must |
| FR-8 | Support markdown/Obsidian; Jira links remain locally bindable with remote validation pending when offline | Must |
| FR-9 | Reconcile links, age all open records, poll configured PR providers, derive staleness and rank deterministically | Must |
| FR-10 | Provide six local views and detail panel, separate capture/sync/provider health and explicit unavailable/never-synced states | Must |
| FR-11 | Mutations use durable revision-checked requests with cancellation, conflict, failure and retry outcomes | Must |
| FR-12 | Handoffs enforce explicit permissions, one run per ticket, isolated fixes, a 20 min execution cap and preserved partial results | Must |
| FR-13 | Install plugin, initialize configuration/worker, validate runtime and expose diagnostics | Must |
| FR-14 | Migrate formats and PMLA via preview, backup, event import, verification and rollback | Must |
| FR-15 | Generate standalone offline/shareable read-only HTML with export time and field preview | Must |
| FR-16 | Add remote adapters only after authentication, permissions and recovery acceptance | Later |

## Non-functional requirements

- Performance: hook p95 <= 200 ms for 1,000 representative calls on each supported OS; record hardware and cold/warm results. Hook persistence timeout is 1 s and produces a health error. No network or model calls on the hook path.
- Reliability: immutable ingress events, serialized writes, atomic replacement, duplicate suppression, restart recovery and revision checks. Gate failures deny covered operations when the hook can respond; host hook crashes/timeouts remain an enforcement limitation.
- Privacy: no telemetry. Capture required metadata and selected assistant content, not complete prompts, environments, credentials or command output by default. Preview exports; escape rendered content; exclude credentials and local absolute paths from shared exports by default.
- Portability: macOS, Linux, Windows native and WSL tested separately. Require an explicitly installed supported Node LTS runtime; do not assume Claude Code supplies Node. Core uses Node built-ins; Claude Code and Git are prerequisites for fixes. Exact supported versions are recorded after phase 0.
- Accessibility: WCAG AA target, full keyboard workflows, visible focus, labelled statuses, reduced motion and measured light/dark contrast.
- Capacity: verify 10,000 tickets, 100,000 events and 200 visible session rows; paginate projections and never scan the whole log per hook.
- Ownership: generated state derives from the journal; user-authored note sections are preserved separately. Manual generated-field changes become explicit conflicts.

## Release plan

| Phase | Delivers | Gate |
| --- | --- | --- |
| 0 Compatibility | Hook fixtures, runtime matrix, local dashboard request prototype | Gate/read/plan/subagent cases and authenticated UI-to-store round trip pass |
| 1 Core | Worker, gate, binding, capture, notes, approval, replay | Concurrent sessions, duplicates, crashes, storage outage and timing cases pass |
| 2 Migration | PMLA profile and migration | Dry run reviewed; all states mapped; links/text preserved; rollback verified |
| 3 Dashboard | Reconciliation, all five views, local requests, static export | Ranking, age transitions, conflicts, undo, offline handling, export privacy and accessibility pass |
| 4 Handoff | Agent integration and isolated fixes | Permissions, concurrency, timeout, cancellation, partial-result and duplicate-child cases pass |
| 5 Public release | README, installer, diagnostics, tested platform matrix | Two outside installs under 10 min; all Must requirements pass [ACCEPTANCE](ACCEPTANCE.md) |
| 6 Extensions | Hosted adapters, mirrors, issue-provider extensions | Each adapter proves authentication, authorization, delivery, recovery and revocation |

No phase has a duration estimate until phase 0 provides evidence. Migration dates and publication are operational decisions, not implicit approval to change the existing PMLA installation.

## Resolved defaults and remaining inputs

Defaults: working name `session-quill`; markdown store; LOCAL keys plus external keys from a configured tracker; gate mode nudge; approval phrases off; active-ticket staleness 5 days; session extinction 48 h; sync every 2 h all days; handoff analyse with follow-ups; source access off; no remote push by default.

Still needed at deployment: actual store/repository paths, provider credentials if used, PMLA inventory/backup, final repository owner and license choice. These are collected during initialization or release preparation; runtime behavior is defined in the [TRD](TRD.md#configuration-and-packaging).
