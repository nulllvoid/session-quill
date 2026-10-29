# ADR 0042 — Reconciliation closes the work loop

Date: 2026-10-30 · Status: accepted · Supersedes the ticket-status separation in ADR 0033 and narrows branch matching in ADR 0021.

## Decision

Use one closure assessment for automatic completion and CLI cleanup. It examines complete worker state: every linked PR, deployment, required child, active run, unresolved run effect and material work timestamp. Missing or stale evidence, a closed-unmerged PR, a blocker, or work newer than the merge prevents automatic completion. A merge observation is fresh for 24 hours. Repository deployment policy remains authoritative; missing deployment records never mean delivery succeeded.

Manual completion remains an explicit owner decision. Manual reopen establishes an evidence floor: polling the same evidence cannot override it. Automatic completion records its reason, evidence identity and sequence; repeated sweeps converge without duplicate transitions. Required children propagate readiness to explicitly configured grouping parents until no further parent can close. Legacy child relationships remain unknown until reviewed. A reopened required child or reverted delivery raises a conflict on its completed parent rather than reopening it silently.

A worker-created PR may now supply ticket evidence when its stored origin ticket, repository, branch and PR URL match a provider observation. Run metrics retain their own observation. Branch-only matching cannot establish attribution where more than one ticket captured the branch, including completed tickets. Reused branches and older merges are handled conservatively; ambiguous work stays in owner review.

## Polling and task growth

Reconciliation journals one retry record per target and selects oldest eligible attempts first, with bounded batches (200 ticket PRs, 50 run PRs, 50 branches). Failures back off; unresolved targets older than 30 days move to a daily minimum interval instead of disappearing. Explicit Refresh bypasses interval eligibility, within the same batch caps. Coverage records checks, failures, deferred and still-eligible targets, and oldest unchecked evidence. Polls do not masquerade as work activity.

New follow-ups are proposals, including results from the legacy analyse-followups mode. Acceptance requires a valid Goal / Context / Done when description and an explicit required/independent relationship. Source run, suggestion and exact evidence-aware finding fingerprint are retained. Exact repeats reuse existing children or are suppressed after acceptance/dismissal; similar titles alone do not merge tasks. At most 20 outstanding follow-up proposals per root are surfaced; overflow remains in the run summary for review. Historical journaled child mutations still replay. Private parents produce private children.

Reconciliation itself creates no tickets. Completed, duplicate, superseded and abandoned resolutions retain history; the latter three do not count as delivered required work. Closing a task does not delete its workspace or publish a tracker update.

## Owner experience and privacy

Runs → Needs you contains one closure review per existing ticket. Ticket detail provides completion mode, parent relationship and resolution controls. Every explicit resolution requires a 1–500 character reason; duplicate/superseded also names another ticket. Review items expose available last-success/next-check times and provider errors. “Reviewed — keep open” acknowledges a fingerprint of material evidence; unchanged polls stay quiet, while changed obligations or errors return to review.

The owner snapshot contains coverage and cumulative task outcomes: created, open, completed, otherwise resolved, oldest open task, closure conflicts, suppressed follow-ups and measured merge-to-local-closure delay. Delay is reported only when merge and status-history timestamps are available; it is not a deployment latency or an agent productivity score.

Closure reasons, resolution references, acknowledgements and follow-up provenance are excluded from export, mirror, publisher and vault projections. Local-only tasks retain their existing visibility rules. No live store was altered during implementation or validation.

## Compatibility and limitations

Reducer version 3 invalidates earlier state checkpoints and replays the journal. Legacy children default to unknown relationship and legacy parents default to evidence completion. Unsafe historical automatic transitions can consequently rebuild as open review candidates. Historical explicit manual resolutions remain authoritative.

This milestone implements local closure and provider observations, not authoritative Jira completion, remote write-back automation, workspace cleanup, Jev, semantic task deduplication or the later workspace redesign. Work without sufficient captured evidence remains an owner decision. Provider integrations are validated with fixtures; no real Jira/GitHub tickets are closed by the tests.
