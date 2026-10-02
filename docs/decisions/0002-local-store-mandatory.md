# ADR 0002 — A local store is mandatory; cloud backends are mirrors or links

Date: 2026-10-02 · Status: accepted (draft)

## Context
Users keep notes in Obsidian, Notion, Jira or plain files. The ticket gate must work offline and the audit trail must not depend on a third-party API being up.

## Decision
`tracker init` requires at least one local store: a plain markdown folder (default) or an Obsidian vault (the same folder placed inside a vault). Notion is a mirror pushed by the agent; Jira is a link with optional status sync; Linear and GitHub Issues follow the same adapter interface later. Hooks never write to a remote backend.

## Consequences
- The gate and capture work with no network and no account.
- Users without Obsidian get the same behaviour from a folder.
- Remote backends can lag the local store by one agent interval; the UI shows last-sync so this is visible.
