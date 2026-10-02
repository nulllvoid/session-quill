# ADR 0003 — Version-tested settings hooks and explicit identity

Date: 2026-10-02 · Status: accepted for v0.2 design; compatibility prototype pending

## Context

Hook payloads and plugin command names need verification against supported Claude Code releases. Directory identity cannot distinguish parallel sessions in the same repository.

## Decision

Use plugin settings hooks routed to `tracker hook`. Versioned fixtures define supported events, native shell tools, approved-plan extraction, plan-file exceptions, subagent identity, failure behavior and command names. Do not claim compatibility with untested older releases. Mods remain optional later work.

Bindings use explicit session/agent identity; directory fallback is forbidden. Missing identity denies covered operations with a diagnostic. A valid binding permits normal host permission processing; it must not produce an unconditional permission override.

## Consequences

- Phase 0 verifies host versions and operating systems before compatibility is advertised.
- Help and denial text use the actual namespaced command, not an assumed alias.
- Preserve existing status-line configuration; use composition or a CLI status fallback.
- Verify against [hooks](https://code.claude.com/docs/en/hooks) and [plugins](https://code.claude.com/docs/en/plugins); references do not replace release fixtures.
