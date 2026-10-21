# Session Quill — requirements and design

Session Quill is a proposed public Claude Code plugin for ticket-bound sessions, recoverable local notes and a personal dashboard with agent handoff.

**Status: revised draft v0.2, 2026-10-02. A v1 implementation now exists in this repository (see the top-level [README](../README.md) and [ACCEPTANCE-RESULTS](ACCEPTANCE-RESULTS.md)); runtime claims against real Claude Code hosts still require the acceptance work below.**

## Documents

| Document | Purpose |
| --- | --- |
| [PRD](PRD.md) | Product guarantees, scope, requirements, defaults and release gates |
| [TRD](TRD.md) | Gate behavior, durable writer, attribution, reconciliation, UI transport, handoff and migration |
| [Data contract](DATA-CONTRACT.md) | Canonical fields, enums, identities, requests and state transitions |
| [UI design](UI-DESIGN.md) | Views, capabilities, interaction outcomes, responsive layout and visual system |
| [Claude design system](design-system/CLAUDE-DESIGN-SYSTEM.md) | Current Quill Fieldnotes identity, reusable assets, components and agent implementation contract |
| [Visual reference](design-system/index.html) | Interactive light/dark token, icon and component catalog; run `node scripts/preview-design-system.mjs` |
| [Acceptance scenarios](ACCEPTANCE.md) | Testable phase gates and traceability back to review findings |
| [Architecture decisions](decisions/) | Worker serialization, local-first dashboard, tested hook compatibility, plan-path first claim, gate modes and zero-command binding, unlinked work inbox, schedules and Bitbucket, agent recipes, environments and Today, publishers, tracker sync and two-way artifacts. 2.0.0 (ADRs 0029–0041): [ingress redaction](decisions/0029-ingress-redaction.md), [state checkpoint](decisions/0030-state-checkpoint.md), [dry-run preflight and leases](decisions/0031-dry-run-preflight-and-leases.md), [anchored memory and the failure ledger](decisions/0032-anchored-memory-and-failure-ledger.md), [evidence receipts and recipe stats](decisions/0033-evidence-receipts-and-recipe-stats.md), [hook latency and daemon IPC](decisions/0034-hook-latency-and-daemon-ipc.md), [run snapshots](decisions/0035-run-snapshots.md), [ticket worktrees](decisions/0036-ticket-worktrees.md), [planned files and drift](decisions/0037-planned-files-drift.md), [context card](decisions/0038-context-card.md), [attention groups and the CI watch](decisions/0039-attention-groups-and-ci-watch.md), [diff review and the critic](decisions/0040-diff-review-and-critic.md), [run environment disclosure](decisions/0041-run-environment-disclosure.md) |
| [2.0.0 research](research/2.0.0/) | The [2.0.0 PRD](research/2.0.0/00-prd.md) (owner draft), the [gap analysis](research/2.0.0/01-gap-analysis.md) that maps it onto the code and says how each requirement was adopted, and the [MCP credentials issue review](research/2.0.0/02-issue-mcp-credentials.md); the plan is [docs/superpowers/plans/2026-10-21-quill-2.0.0.md](superpowers/plans/2026-10-21-quill-2.0.0.md) |
| [Agent handover](AGENT-HANDOVER-ORCHESTRATION-1.0.md) | What shipped in 1.0, 1.1 and 2.0.0, deliberate deviations, what is deferred and known gaps |
| [Architecture guide](ARCHITECTURE.md) | Contributor-facing map of the code and the invariants it keeps |
| [Acceptance results](ACCEPTANCE-RESULTS.md) | What has been verified, on which platforms, and what is still pending |

## v0.2 decisions

- Gate coverage is explicit; it does not promise filesystem-wide enforcement.
- One local worker serializes writes. Events persist before acknowledgement; healthy note materialization is bounded at 30 seconds.
- Bindings use explicit session/agent identities and preserve event history through rebinding.
- Staleness is a flag; full checkpoints remain available behind shortened previews.
- The local dashboard is the v1 baseline. Read-only HTML exports support sharing; hosted live sharing is deferred until its adapter is verified.
- Edits have revision checks, a real undo window and explicit conflict/failure outcomes.
- Handoffs use isolated source checkouts and separate read/edit/commit/push/PR permissions.
- Single-owner-machine operation, approval phrases off and all-day two-hour reconciliation are the defaults.

## Source of truth

The committed markdown is authoritative for v0.2. The data contract governs field/state definitions; PRD governs scope; TRD governs mechanics; UI governs presentation. Conflicts must be resolved in these files before implementation.

Earlier live Claude documents and PNGs under [diagrams](diagrams/) are historical v0.1 references and have not been synchronized. Current architecture and screen maps are inline Mermaid in the revised documents; do not build from the old images.

Historical editing copies: [technical design](https://claude.ai/code/artifact/e7c5396d-215e-40fd-8e8a-37cb7f1ee220), [UI design](https://claude.ai/code/artifact/5aac569c-9868-4eb4-92eb-b79cf1bf295c).

## Next implementation gate

Begin phase 0 with actual Claude Code hook fixtures and an authenticated local UI-to-store request round trip. Record exact supported runtime versions and operating systems. Passing a document consistency check is not evidence that the software or integrations work.

Final public repository ownership/license and real deployment paths/credentials remain release or initialization inputs. This repository revision does not install a plugin, migrate PMLA, publish a dashboard or share private data.
