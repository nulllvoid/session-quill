# ADR 0043: Unified Work, execution intent and Daily continuity

Date: 2026-10-30. Status: accepted. Design: [approved specification](../superpowers/specs/2026-10-30-unified-work-control-centre-design.md).

## Decision

Work is the default dashboard: one expandable hierarchy replaces Board and Relationships, with Open, Suggested next, Needs attention, Completed and All lenses. Required-child completion is derived on the worker from the complete authorized tree. A done child with a reopened required descendant is a completion conflict, not delivered work; independent edges do not propagate that conflict. Manual workflow status is preserved. Counts are task counts, not effort estimates. Static exports omit owner rollups and explain that completion was not assessed.

Priority, create-subtask and reparent operations use the existing durable request transport and ten-second undo window. Reparent checks the child and both parents before any mutation, then updates all affected revisions. New children inherit the parent's privacy; no bulk action implicitly selects descendants.

The standard composer offers Read only, Plan, Auto and Full access. Intents resolve to pinned built-in templates on the server; legacy recipes and CLI callers remain available. Auto grants source edits/tests by default; publishing is explicit. Full access retains the runtime's actual bypass semantics and must be deliberately chosen again. Intent results suggest changes rather than editing tickets or creating follow-up tickets. A successful agent process is not proof of a tested fix.

Plan runs store immutable text plus semantic task context and the source commit. Owner edits create a new plan revision. Execution pins the reviewed revision, current semantic context and current source commit; submission and dispatch reject changes that require another review. Incidental run metadata does not invalidate review. Local Git read failures remain errors rather than silently changing the baseline.

Daily update is an owner-only local artifact, separate from the legacy per-ticket `standup` recipe and existing `digest` writer. The worker freezes the request cutoff, scope, journal sequence and deterministic evidence bundle before rendering. An optional bounded, tool-free model may select evidence; structured facts remain available if it fails. Generated updates are never treated as source facts or instructions.

Only scheduled and Since-last updates contribute to a cursor, keyed by normalized scope and timezone. Cursor advancement and successful complete output are one journal transaction. Failed/partial/cancelled generation does not advance it. Late evidence and evening carryover are explicit. Historical windows and regeneration never move continuity forward. Owner edits and older revisions remain available.

Daily scheduling is opt-in, defaults to 18:00 in the store timezone, and reuses the existing scheduler's one-slot catch-up. The configuration request checks the exact file fingerprint under the setup lock, preserving unrelated settings. It does not enable model synthesis or external publishing implicitly.

## Compatibility and recovery

Reducer version 5 invalidates older checkpoints and rebuilds from the journal. Ticket IDs, old relationship classification, run history and original events are retained. Older binaries cannot interpret `update-tx` and new request mutations: use this implementation or newer to retain their projections. Back up the Quill home before downgrade; do not delete new events to make an old binary appear compatible. A UI rollback can keep the updated worker/data reader. Journal replay and checkpoint hydration are tested.

No new dependency, external service or database is introduced. Existing scope guards, owner authentication, loopback-only service and export allowlists remain authoritative. Owner update prose and plan text are absent from ordinary snapshots and static exports. Sharing renders a separate view of eligible source facts rather than exporting the private owner prose.
