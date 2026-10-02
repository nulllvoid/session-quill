# ADR 0006 — Unlinked work inbox and external key chips

Date: 2026-10-02 · Status: accepted · Builds on [ADR 0005](0005-gate-modes-and-auto-binding.md)

## Context

With the `nudge` gate (ADR 0005) a session can change files or commit before it is linked to a ticket. Automatic binding is forward-only, so that earlier work belongs to no ticket. Until now the reducer dropped a tool result with no ticket, so the work was invisible. Step 2 of the "zero-command ticket tracking" proposal asks for an inbox where the owner decides what that work belongs to, plus key chips that open the tracker and copy the key.

## Decision

- **Keep the work on the session.** A post-tool result with no ticket that wrote files or made a commit is recorded in the session's `unbound_work`: files (deduplicated, capped at 500), commits (capped at 200), first and last time, and a revision that changes only when this work changes.
- **Three requests, all revision-checked and delayed by the 10-second undo window.**
  - `attach-unbound` targets the session and checks `unbound_work.revision`. Its payload names an existing ticket (`ticket_id`) or a tracker key (`key`, optional `title`). For a key the worker reuses the ticket with that key or alias, or creates it with a deterministic id and the link rendered from the tracker template. The files join the ticket's files, commits become timeline entries, and the session's checkpoints that had no ticket move to it. When `bind` is true (the default) and the session is still unlinked, it is linked from then on. A session already linked elsewhere keeps its binding.
  - `dismiss-unbound` marks the batch dismissed. The batch stays on the session for audit until new unlinked work starts a fresh one.
  - `link-external` relinks a ticket to a tracker key: the old key becomes an alias and the link is rendered from the ticket's repository tracker. Keys that already name another ticket are refused.
- **Attaching is retroactive only by explicit choice.** Automatic binding stays forward-only. Attaching moves exactly the work the owner saw; if more arrived in the meantime, the request becomes a conflict.
- **Owner only.** The inbox appears only with edit capability. Exports keep their session allowlist, so `unbound_work` never leaves the machine, and external links are stripped unless links are included.
- **Key chips.** A ticket whose key matches its external key renders the key as a link that opens the tracker in a new tab (`rel="noopener noreferrer"`), with a copy button. Only `https://` links render as anchors. Tickets with no external link offer "Link to external…" to the owner.

## Consequences

- Nothing captured in `nudge` mode is silently lost; it waits in the inbox until attached or dismissed.
- An attach can conflict while a session is still working. The owner resubmits against the new revision.
- Conclusions extracted at Stop are not re-derived on attach; the checkpoints themselves move, so their full text is reachable from the ticket.
- The inbox shows unlinked writes and commits only. Unlinked PR creation is still not captured.

## Alternatives considered

- **Attach automatically on the next binding.** Rejected: it would make automatic binding retroactive and could pull unrelated earlier work into a ticket.
- **Attach individual files.** Deferred: whole-batch attach covers the common case; splitting a batch across tickets is a later refinement.
- **Store unlinked work in a separate collection.** Rejected for now: keeping it on the session keeps replay and attribution in one place.
