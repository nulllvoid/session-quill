# ADR 0001 — Serialize generated-state writes through one local worker

Date: 2026-10-02 · Status: accepted for v0.2 design; implementation unverified

## Context

One CLI code path does not serialize concurrent processes. Parallel sessions, sync and handoffs can lose updates without enforced ownership and ordering.

## Decision

Hooks and CLI commands submit immutable, uniquely identified ingress events. One worker per owner/store holds an OS-released exclusive local socket/pipe ownership lock, journals events and serially updates generated notes, binding snapshots, requests and dashboard projections. A second worker refuses to start while the first owns the lock.

Successful receipt requires durable ingress persistence. Replay is duplicate-safe; note replacement is atomic and projection revisions expose interrupted multi-file updates. User-authored sections are preserved; changes to generated sections raise conflicts. See [TRD](../TRD.md#durability-and-concurrency) and [data contract](../DATA-CONTRACT.md).

## Consequences

- A supervised local worker is a core dependency; its timer flushes pending notes within 30 s even without another hook.
- Non-gate hooks persist ingress during worker outages; unavailable storage is reported as a capture gap.
- Covered writes require a healthy gate and binding. Host hook runtime failure remains outside the enforcement guarantee.
- Active multi-machine writing is excluded; vault synchronization does not transfer writer ownership.
