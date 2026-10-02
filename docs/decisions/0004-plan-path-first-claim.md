# ADR 0004 — Plan-file exception by first claim

Date: 2026-10-02 · Status: accepted for v0.1 implementation; revisit when the host exposes the plan path

## Context

The TRD's plan-file exemption permits writes only to "the exact canonical host-designated plan path for that session". Claude Code 2.1.x hook input carries `permission_mode` (`plan`) and the tool input, but no field naming the session's plan file. Phase 0 could therefore not identify the plan path from host data alone.

## Decision

The gate establishes the session's plan path by first claim, narrowly: the first `Write` of a `*.md` file located directly inside the verified plan directory (`~/.claude/plans`, no symlink or reparse escape) while `permission_mode` is `plan`. That path is remembered per session; later writes to any other plan file, writes by other tools (`Edit`, `MultiEdit`, `NotebookEdit`), non-Markdown files and all source edits remain denied. The claim is recorded in `state/plan-paths/` and surfaced in the README's limits section.

This is a deliberate, documented widening of the TRD's "exact host-designated path" rather than a silent one. If a host version later exposes the plan path, the claim logic is replaced by the host value.

## Consequences

- An unbound session in plan mode can create exactly one plan file of its choosing, Markdown only, inside the plan directory. It cannot touch source files or any other directory.
- The exception never widens to source writes, and plan mode alone never exempts anything.
- Acceptance A02 is satisfied in-process; its "verified host plan path" wording is met by this narrower first-claim rule until the host provides the path.
