# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-02

First implementation of the v0.2 design (PRD, TRD, data contract, UI specification, acceptance scenarios).

### Added

- Ticket gate on Claude Code hooks: supported write tools, unknown shell commands and unregistered tools are denied until the session is bound; dedicated reads and a tested read-only shell subset pass through; per-session gate off/on with audit.
- Durable capture: ingress files persisted before acknowledgement, fsync'd JSONL journal, content-addressed blobs, torn-tail quarantine, duplicate suppression and deterministic replay.
- Single-writer worker with an OS-released ownership lock, 30-second note materialization, binding snapshots for hooks, health heartbeat and incremental projections.
- Markdown/Obsidian notes with hash-guarded generated sections; authored Summary and Notes preserved byte for byte; unrecognized or edited generated content becomes an explicit conflict with `quill note restore` and `quill import`.
- CLI: `init`, `ticket` (create/bind/show/off/on/relink/list/children), `approve`, `dismiss`, `status` (including status-line mode), `doctor`, `worker`, `sync`, `replay`, `import`, `note`, `ui`, `export`, `handoff`, `migrate`, `hook`.
- Deterministic reconciliation every two hours with catch-up on start, session lifecycle (live/idle/ended/extinct), stale derivation, pick-next ranking with explained scores, GitHub PR polling through `gh`, deployment obligations per environment.
- Loopback dashboard API with one-use bootstrap secrets, HttpOnly SameSite cookies, CSRF and Origin/Host checks, generation-consistent detail endpoints, and revision-checked mutation requests with a 10-second undo window, conflicts, cancellation and crash recovery.
- Dashboard UI (Pick next, Board, Tree, Sessions, Deployments, ticket detail, handoff form, export dialog) in the Terminal Slate visual system with light and dark themes meeting measured WCAG AA contrast, keyboard shortcuts and responsive layouts from 390 px up.
- Read-only standalone HTML export with field and project selection, exact preview and privacy sanitization.
- Agent handoffs (analyse, analyse with follow-ups, attempt fix) in isolated Git worktrees with explicit permissions, a 20-minute wall-clock cap, cancellation, interrupted-run recovery and redelivery-safe child tickets.
- Migration framework with dry run, backups, replayable migration events, a PMLA profile and rollback.
- Plugin packaging: manifest, exec-form hooks, namespaced commands, handoff agent, status-line script.
- Acceptance suite mirroring `docs/ACCEPTANCE.md` and a results record with performance measurements (hook p95 1.7 ms at 10,000 tickets / 100,000 events).

### Changed

- Project renamed from Session Tracker to Session Quill (`/session-quill:*`, `bin/quill.js`, `~/.claude/quill`, `.quill.toml`).

### Security

- The gate fails closed for every covered tool on malformed hook input, internal errors or capture failure.
- Reducer exceptions are contained and recorded instead of becoming replay poison pills.
- Export redaction covers any absolute path; handoff agents get test-runner-only shell access and no provider tokens unless push/PR permission is granted.
- Plan-mode file exception limited to the first `Write` of a Markdown file directly inside the plan directory (ADR 0004).

[Unreleased]: https://github.com/nulllvoid/session-quill/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nulllvoid/session-quill/releases/tag/v0.1.0
