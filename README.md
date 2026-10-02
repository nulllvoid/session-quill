# Session Tracker — requirements and design

Session Tracker is a proposed public Claude Code plugin for ticket-bound sessions, recoverable local notes and a personal dashboard with agent handoff.

**Status: revised draft v0.2, 2026-10-02. Implementation has not started.** The v0.2 revision resolves the requirements review; runtime and integration claims still require the acceptance work below.

## Documents

| Document | Purpose |
| --- | --- |
| [PRD](docs/PRD.md) | Product guarantees, scope, requirements, defaults and release gates |
| [TRD](docs/TRD.md) | Gate behavior, durable writer, attribution, reconciliation, UI transport, handoff and migration |
| [Data contract](docs/DATA-CONTRACT.md) | Canonical fields, enums, identities, requests and state transitions |
| [UI design](docs/UI-DESIGN.md) | Views, capabilities, interaction outcomes, responsive layout and visual system |
| [Acceptance scenarios](docs/ACCEPTANCE.md) | Testable phase gates and traceability back to review findings |
| [Architecture decisions](docs/decisions/) | Worker serialization, local-first dashboard and tested hook compatibility |

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

Earlier live Claude documents and PNGs under [docs/diagrams](docs/diagrams/) are historical v0.1 references and have not been synchronized. Current architecture and screen maps are inline Mermaid in the revised documents; do not build from the old images.

Historical editing copies: [technical design](https://claude.ai/code/artifact/e7c5396d-215e-40fd-8e8a-37cb7f1ee220), [UI design](https://claude.ai/code/artifact/5aac569c-9868-4eb4-92eb-b79cf1bf295c).

## Next implementation gate

Begin phase 0 with actual Claude Code hook fixtures and an authenticated local UI-to-store request round trip. Record exact supported runtime versions and operating systems. Passing a document consistency check is not evidence that the software or integrations work.

Final public repository ownership/license and real deployment paths/credentials remain release or initialization inputs. This repository revision does not install a plugin, migrate PMLA, publish a dashboard or share private data.
