# ADR 0010 — Publishers

Date: 2026-10-03 · Status: accepted · Builds on [ADR 0007](0007-schedules-and-bitbucket.md) and [ADR 0009](0009-environments-and-today.md)

## Context

Sharing was a read-only HTML export saved by hand. The "zero-command ticket tracking" proposal asks for one shared, always-current page per project, replacing a hand-maintained tracker artifact, through publisher adapters configured as `[[publish]]`: `artifact` (a claude.ai artifact with shared state, created on the first publish, then updated row by row with version checks that preserve fields others edited), `html` (the static export written to a path) and `markdown` (a project roll-up note), with Confluence and Notion as later adapters. Content goes through the export sanitizer, limited to configured fields and projects. Publishes run after reconciliation, on a schedule, or on demand. Publishing is outbound, so the first publish to any new destination needs explicit confirmation, and the UI labels `html` as a copy and `artifact` as live.

## Decision

- **`[[publish]]` in user config only.** Each entry has a `name`, a `kind` (`markdown`, `html`, `artifact`; `confluence` and `notion` are accepted and skipped with a warning), `fields` (the proposal's short names `key`, `title`, `status`, `next`, `pr`, `deployments`, `updated`, plus `category`, `priority`, `blocker`, `due`, `stale`, `external`), optional `projects`, `include_links`, `title`, and `on = ["reconcile"]` to publish after every successful reconciliation. `html` needs a `path` ending in `.html`; `markdown` defaults to `<store>/rollups/<name>.md`; relative paths resolve against the store. `artifact` takes an optional `url` to take over an existing artifact instead of creating one.
- **One content path.** Rows come from the export sanitizer with the publisher's fields and projects: local paths are redacted and links are left out unless `include_links = true`. The markdown roll-up is a table per status written into its own marked section (the ADR 0009 writer), so the rest of the note is the owner's. The html publisher writes the standalone export.
- **Confirmation is per destination.** A destination is the kind plus its path or artifact URL. Until the owner confirms it, a publish records `needs-confirmation` and sends nothing; a `publish` request with `confirm` (the dashboard's Confirm button, `quill publish <name> --confirm`) records the consent in a journaled `publish-run` event. Changing the path or URL makes it a new destination that asks again.
- **The artifact page holds no data.** The page Quill publishes declares the `db` capability (anyone who can open it reads, editors write) and renders `tickets/<key>` and `meta/page` documents live, as text only. The first publish creates the page and one document per ticket. Later publishes read every row and its version, then write only the fields whose remote value still equals what Quill last wrote; a field someone edited on the page keeps their value and is reported. Every update is pinned to the version just read, so a concurrent edit makes the batch fail instead of being overwritten. Rows that leave scope are marked `in_scope: false`, never deleted, and rows Quill did not create are never touched. The page is republished only when its template changes.
- **Quill plans; something with the Artifact tools executes.** The worker cannot reach claude.ai. A publish is a sequence of plans (publish the page, read rows, pinned batches) that an executor runs and reports back on. With `executor = "session"` (the default) a Claude Code session runs them: `/session-quill:publish <name>` calls `quill publish <name> --plan`, carries out the steps with the Artifact and ArtifactData tools, and feeds the result back with `--result` until the CLI reports the publish. With `executor = "cli"` the worker runs a headless `claude -p` limited to those tools. Scheduled and after-reconcile runs of a session publisher record `needs-session` with the command to run.
- **Status everywhere.** The snapshot lists publishers with their label (Live, Copy, Note), destination (a file name or the artifact URL, never a local path), confirmation, last result and recent runs. The header has a Publish dialog; `quill publish list` shows the same.

## Consequences

- Headless `claude -p` in Claude Code 2.1.288 has no Artifact or ArtifactData tools, so `executor = "cli"` fails with that reason today; it is kept for runtimes that expose them and is what the automated tests drive with a simulated artifact. The session executor was verified against a real private claude.ai artifact: page republish, reads with versions, a pinned 12-write batch, and a stale pin refused atomically.
- An artifact publish costs a Claude Code session's time and model usage, so it is on demand or after a reminder, not every two hours.
- Two-way sync (comments to ticket notes, page edits to requests) is the next step; the db layout leaves room for it.

## Alternatives considered

- **Call claude.ai from the worker.** Rejected: there is no supported API for it, and the worker must never hold claude.ai credentials.
- **Republish the whole page with embedded rows each time (the `artifact` capability).** Rejected: it overwrites edits made on the page and cannot pin per-row versions.
- **Let the executor decide the writes.** Rejected: an agent that merges rows is unpredictable; Quill computes every write and the executor only carries them out.
