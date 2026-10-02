# ADR 0002 — Local capture and dashboard; explicit snapshot sharing

Date: 2026-10-02 · Status: accepted for v0.2 design; implementation unverified

## Context

An unspecified hosted artifact database and device bridge cannot be prerequisites for an offline public plugin.

## Decision

One owner machine maintains a markdown folder or Obsidian vault. Generated fields project the durable journal; separately authored sections remain user-owned. The owner dashboard runs on loopback through the worker. Explicit HTML exports provide offline use and snapshot sharing without credentials or mutation channels.

Hosted live sharing and mirrors require a separately verified adapter and are deferred. Jira keys can remain locally bindable with validation pending. Handoffs may use the configured model provider and are not described as fully offline.

## Consequences

- No hosted account is necessary for capture, reconciliation, local UI or export.
- A shared file is not live or revocable; preview shows exactly what is included.
- The machine must be awake to process work; sleep is visible as a stale/offline interval.
- Other machines may read copies but cannot write the same logical store in v1.
