# ADR 0003 — Settings hooks for v1; the mods API as a later option

Date: 2026-10-02 · Status: accepted (draft)

## Context
Claude Code offers settings hooks (SessionStart, PreToolUse, PostToolUse, Stop, PreCompact, SessionEnd, ...) and a newer mods API (`tool.check`, `session.compact`, `ui.render`, ...) that can also draw a status band natively.

## Decision
v1 uses settings hooks registered from the plugin's `hooks/hooks.json`, all routed to `tracker hook`. A mod is a phase 6 option for the status band and tighter gating.

## Consequences
- Works on older Claude Code versions and is the documented, stable surface.
- The status line reads the binding file instead of a native band.
- Two facts to verify in phase 1: whether subagent tool calls carry the parent `session_id` (fallback: cwd-based binding lookup), and the exact PostToolUse behaviour for ExitPlanMode on approval versus rejection.
