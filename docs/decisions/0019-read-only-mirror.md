# ADR 0019 — A read-only mirror for other machines

Date: 2026-10-11 · Status: accepted · Builds on [ADR 0001](0001-single-writer-cli.md) and [ADR 0002](0002-local-store-mandatory.md)

## Context

One machine owns and writes a store (PRD, v1 boundaries), and active multi-machine stores are deferred. People with a laptop and a desktop still want to see their board on the machine that does not own it. The journal and projections live in the owner's `~/.claude/quill`; only the notes and `store.json` live in the store folder, so syncing the store folder alone shows notes but no board.

## Decision

- **The owner publishes a mirror; nobody merges.** With `[mirror] enabled = true` in `config.toml`, the owner's worker writes `dashboard.html` (the standalone read-only dashboard), `snapshot.json` and `mirror.json` into `<store>/.quill-mirror` (or `[mirror] path`). It rewrites them when a new generation exists, at most once per `interval_seconds` (default 60, at least 30), and once when the worker stops. `mirror.json` is written last, so a reader that sees it knows the files it describes are complete.
- **Same privacy rules as a shared export.** The mirror goes through the export sanitizer: no checkpoint text, no request or handoff internals, no credentials or local paths, links only with `include_links = true`, and `projects` limits which projects leave the machine. The folder may be synced through a service the owner shares with others, so the default is the shared-snapshot default.
- **Transport is the owner's choice.** Quill does not sync anything. OneDrive, Dropbox, Syncthing or a private git repository carry the folder.
- **Reading on another machine.** `quill mirror status` reports when and by which machine the mirror was written, how many tickets it holds and whether it is stale (older than 15 minutes). `quill mirror open` opens the dashboard read-only. Both work without an initialized store (`--dir` names the folder). `quill mirror write` refreshes the mirror on demand and is refused on a machine that does not own the store. `quill doctor` on a non-owner machine points to `quill mirror open`.

## Consequences

- A second machine sees a board that is as fresh as the owner's worker and the sync tool make it, labelled with its export time like any snapshot.
- Nothing on the second machine can change tickets; ownership transfer remains a separate, explicit act.
- The mirror costs one sanitize and two file writes per interval while tickets change.

## Alternatives considered

- **Serve the dashboard over the network.** Rejected for now: the dashboard is loopback-only by design, and exposing it needs authentication across machines (PRD FR-16).
- **Sync the journal and let each machine replay.** Rejected: that is the deferred multi-writer store, with merge and ownership questions this decision avoids.
