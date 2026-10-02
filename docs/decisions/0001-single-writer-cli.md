# ADR 0001 — One CLI is the only writer to the store

Date: 2026-10-02 · Status: accepted (draft)

## Context
Hooks, the interval agent and the handoff agent all need to update notes. Three writers with three code paths would drift and would make the audit trail unreliable.

## Decision
A single `tracker` CLI (Node, no dependencies, shipped in the plugin) is the only process that writes ticket, session and handoff notes. Hooks call `tracker hook`; agents call `tracker child`, `tracker note`, `tracker sync`. The CLI appends every event to `~/.claude/tracker/events.jsonl` before touching any note (append-first), and a `tracker replay` command can rebuild notes from the log.

## Consequences
- One place for schema, debouncing and validation of the closed sets (`status`, `category`).
- The interval agent edits ticket notes only through the CLI, so UI edits and hook writes cannot overwrite each other silently.
- The CLI must stay fast (under 200 ms per hook) and must never block a session except for the gate.
