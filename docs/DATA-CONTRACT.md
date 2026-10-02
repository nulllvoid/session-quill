# Session Quill — Canonical Data Contract

Status: revised draft v0.2 · 2026-10-02
Authority: field names and state rules in this document apply to [TRD](TRD.md) and [UI](UI-DESIGN.md). Markdown is a projection, not a separate schema. Version 1 is the first implementation schema; document v0.2 is not a data-format version.

## Common conventions

- IDs are UUIDs except external provider/session IDs and content hashes. A key is a display alias, never a database identity.
- Ticket, session, checkpoint, handoff and request records carry schema_version, store_id, id, revision (positive integer), created_at and updated_at. Events and snapshot metadata use their explicit envelopes below. Updates increment revision; timestamps alone never resolve conflicts.
- Times are UTC RFC 3339 with Z. A due date is YYYY-MM-DD, interpreted in meta.timezone. Null means unknown/not applicable, not zero or empty evidence.
- Arrays default to empty. A nullable scalar is explicitly marked below. Unknown enum values or newer schema versions are rejected with a diagnostic; migrations are explicit.
- User content is plain text/Markdown rendered without raw HTML or executable URLs. Validate lengths, paths and external URLs before storage or display.
- One parent per ticket; cycles, self-parenting and cross-store links are invalid. Parent is authoritative; children is a derived index. Orphans from import remain visible with a validation issue until repaired.

## Enumerations

| Field | Values |
| --- | --- |
| Ticket status | todo, active, blocked, review, deploy-pending, done |
| Category | feature, bugfix, vuln, infra, research, analysis |
| Priority | P0, P1, P2, P3 |
| Session state | live, idle, ended, extinct |
| Request state | pending, applying, applied, conflict, failed, cancelled |
| Handoff state | queued, running, done, failed, cancelled, timed-out |
| Handoff mode | analyse, analyse-followups, attempt-fix |
| PR state | unknown, draft, open, merged, closed |
| Deployment state | pending, deployed, waived |
| External validation | pending, valid, invalid |
| Approval provenance | explicit, heuristic, migration |

Staleness is a boolean derived from activity. It is not a ticket status. Counts per status must not count stale tickets twice.

## Ticket

Required scalar fields: key, title, project_id, project_name, status, category, priority, next_action, last_activity.
Read-only authored projections: summary and user_notes (strings, empty by default). They come from preserved user sections, not journal replay; an authored-content change republishes the detail projection without pretending a generated-field edit occurred.
Nullable fields: parent_id, due, blocker, repo_id, jira, external.
Arrays: aliases, children_ids, session_ids, tags, files_touched, plans, conclusions, timeline, prs, deployments, handoff_ids, validation_issues.
Derived fields: stale, files_touched_count, plans_count, children_done_count.
Control fields: status_source (manual, evidence, migration), status_evidence_id (nullable), manual_status_evidence_floor (sequence, default 0).

- blocker is required and nonempty when status is blocked. next_action may be empty.
- repo_id resolves through the local repository registry; the UI receives a display repo name, never an implicit filesystem permission.
- jira: key, url (nullable), validation, validated_at (nullable), error (nullable).
- external: system (jira, linear, github, custom), key, url (nullable, https only), validation, validated_at (nullable), error (nullable). Set when a ticket is created from or relinked to a tracker key (ADR 0005); jira-system records also fill `jira` for compatibility.
- files_touched: repo_id, relative_path, first_seen, last_seen. Counts are deduplicated by repo and path; unknown changes are represented by timeline coverage, not guessed paths.
- plans: id, session_id, checkpoint_id (nullable), content_ref, preview, approved_at, provenance. Full approved plan text is available through the local detail projection.
- conclusions: id, session_id, checkpoint_id, content_ref, preview, recorded_at, approved_at (nullable), provenance (nullable).
- timeline: id, at, kind, text, event_id, content_ref (nullable), coverage (complete, partial, unknown). kind: bind, write, tool, commit, pr, plan, conclusion, handoff, status, deployment, capture-error.
- prs: id, provider, url, state, opened_at (nullable), merged_at (nullable), base_branch (nullable), head_branch (nullable), observed_at (nullable), error (nullable), evidence_id (nullable).
- deployments: id, pr_id, environment, state, merged_at, deployed_at (nullable), evidence (nullable), evidence_kind (nullable: merge, tag, argocd, release, manual, agent), waiver_reason (nullable), source_event_id. Unique obligation identity is pr_id + environment.
- environments (snapshot only, ADR 0009): one entry per configured environment and any environment that only appears on an obligation: environment, state (pending, done, n-a, none), pending, obligations, merged_at, deployed_at, evidence, evidence_kind, waiver_reason.
- tags mirror status/category plus explicit tags. A stale tag may be derived independently and must not replace a status tag.

Deployment obligation creation requires merged evidence and a configured target environment. A repository's deployment_environments win, then `[tracker].environments` (repository, then user), then production; the merged-PR update in the reconcile event records the list used (ADR 0009). Multiple environments may be configured per repo. Closed-unmerged and draft PRs create no deployment obligation. A later PR merge creates a new obligation without erasing existing deployment history.

Example generated frontmatter (nested plan/conclusion bodies are represented by references in full notes):

```yaml
schema_version: 1
store_id: "11111111-1111-4111-8111-111111111111"
id: "22222222-2222-4222-8222-222222222222"
revision: 3
created_at: "2026-10-02T08:00:00Z"
updated_at: "2026-10-02T08:05:00Z"
key: LOCAL-session-capture-a1b2c3d4
title: Preserve session checkpoints
project_id: session-quill
project_name: Session Quill
status: active
category: feature
priority: P2
parent_id: null
due: null
blocker: null
repo_id: session-quill
jira: null
next_action: Verify restart recovery
summary: ""
user_notes: ""
last_activity: "2026-10-02T08:05:00Z"
stale: false
status_source: manual
status_evidence_id: null
manual_status_evidence_floor: 12
aliases: []
children_ids: []
session_ids: []
tags: [quill/status/active, quill/cat/feature]
files_touched: []
plans: []
conclusions: []
timeline: []
prs: []
deployments: []
handoff_ids: []
validation_issues: []
files_touched_count: 0
plans_count: 0
children_done_count: 0
```

## Ticket transitions

| Trigger | Rule |
| --- | --- |
| Create | todo, configured category or research, priority P2 |
| First successful attributed write | todo -> active unless a later explicit manual status decision supersedes the write evidence |
| New open/draft PR evidence | todo/active -> review; preserve blocked and done |
| New merge evidence | todo/active/review -> deploy-pending if obligations remain; preserve blocked and explicit done |
| All known obligations deployed/waived | With at least one known obligation, deploy-pending -> done; preserve blocked/manual overrides |
| Owner status request | Any status -> selected status after revision validation; blocked needs blocker text |
| Owner selects done with pending deployments | Require choice: record deployment evidence, waive with reason, or leave obligations outstanding; outstanding items stay in Deployments |
| Resume work on done | Owner explicitly reopens; hooks do not silently reopen |
| Age threshold | Toggle stale only; never change status |

Every manual status decision records the current evidence sequence as manual_status_evidence_floor. Automatic transitions require genuinely new relevant evidence above that floor and allowed source statuses. Polling an unchanged remote state reuses its evidence identity and cannot undo the manual choice. Derived reconciliation itself does not increment last_activity.

## Session and checkpoints

Session fields: machine_id, machine_name, host_session_id, agent_id (nullable), parent_session_id (nullable), project_ids[], ticket_ids[], current_ticket_id (nullable), current_binding_revision, bindings[], cwd (local-only), started_at, ended_at (nullable), last_event_at, state, successful_write_count, change_coverage, last_checkpoint_id (nullable), last_checkpoint_preview, unpromoted, gate_enabled, capture_health, unbound_work (nullable).

unbound_work (ADR 0006): revision, files[] (repo_id, relative_path, first_seen, last_seen; at most 500), commits[] (sha, message, at; at most 200), first_at, last_at, dismissed_at (nullable). Work a session captured while it had no ticket. The revision changes only when this work changes. Local-only: exports never include it.

bindings entries: revision, ticket_id (nullable), project_id, bound_at, unbound_at (nullable), source_event_id.
checkpoint entries live in a separate local collection: id, session_id, ticket_id (nullable), binding_revision, recorded_at, content_ref, preview, complete, approved_at (nullable), approval_provenance (nullable).

Health fields use ok, degraded or error with a nullable reason and observed_at. Session change_coverage uses complete, partial or unknown. Repository/project display fields are joins from the registry, not independent user-editable copies. Project IDs are stable configured strings unique within the store.

Full text is stored by content hash. The 1,500-character preview never replaces full content. unpromoted means at least one complete checkpoint for the session/ticket has not been explicitly approved or dismissed. Dismissal is a CLI operation in v1; the dashboard only displays this indicator.

Session lifecycle uses the TRD age rules. A recent event is an activity signal, not proof a process remains alive. Historical checkpoints retain their original ticket even after rebind.

## Event envelope

Fields: schema_version, event_id, store_id, machine_id, producer, occurred_at, ingested_at (nullable until ingested), sequence (nullable until ingested), session_id (nullable), agent_id (nullable), tool_call_id (nullable), ticket_id (nullable), binding_revision (nullable), kind, payload, source_identity.

source_identity is stable across redelivery: host session/agent + event kind + tool-call ID for tool events; checkpoint identity/content digest for repeat Stop delivery; request ID for commands. Different legitimate user turns must not be collapsed solely because their text is identical. If the host cannot provide a stable identity, the adapter records the limitation and preserves events rather than guessing.

PreToolUse stores attribution before execution. A PostToolUse result refers to that tool-call snapshot. Missing identity creates an unresolved event surfaced for explicit repair. Event payloads retain required metadata and selected checkpoint content references, not unrestricted raw hook payloads.

## Mutation request

Fields: id, store_id, actor_id, kind, target_id (nullable), expected_revision (nullable), payload, created_at, not_before, state, applied_revision (nullable), error (nullable), result (nullable), retry_of (nullable).
kind: set-next-action, set-status, record-deployment, handoff, handoff-cancel, refresh, attach-unbound, dismiss-unbound, link-external, run-job, accept-suggestion, dismiss-suggestion.

- run-job (ADR 0007) has no target and payload { schedule }; it names a configured schedule, has no undo delay and is applied by the scheduler like refresh. A refresh or run-job left applying by a crash fails with code `interrupted` (retryable) on the next start.

- handoff (ADR 0008) payload: recipe (name; optional, defaults to mode), mode, note, permissions, branch. With a recipe, permissions must be within its frontmatter; the applied request records recipe { name, source, hash }, and dispatch fails with `recipe-changed` if the file no longer has that hash.
- accept-suggestion and dismiss-suggestion target a ticket and take payload { handoff_id, suggestion_id }; accept requires expected_revision, dismiss does not. Both have the 10 s undo window. A suggestion resolves once.

- attach-unbound and dismiss-unbound target a session id; expected_revision is the session's unbound_work.revision. attach-unbound takes exactly one of ticket_id or key (a tracker key like PROJ-123, with optional title) plus bind (default true: link the session from then on if it is still unlinked). link-external targets a ticket with its revision and takes key plus optional system and https url; a key owned by another ticket is refused. All three have the 10 s undo window (ADR 0006).
error: code, message, retryable, current_revision (nullable).

- Ticket edits require expected_revision. A mismatch becomes conflict and returns the current value/revision; never last-write-wins.
- set-status payload includes blocker when needed and the explicit pending-deployment choice. Combined status/deployment changes commit as one logical operation or not at all.
- record-deployment names each obligation, environment and evidence or waiver reason.
- Pending edits have not_before = created_at + 10 s. Handoff/refresh have no undo delay.
- Allowed transitions: pending -> applying/cancelled/conflict/failed; applying -> applied/conflict/failed. Terminal records are immutable.
- Reposting an identical ID/body returns the existing request; the same ID with different content is rejected.
- Cancellation succeeds only while pending; return applied/applying/terminal state otherwise. A reversal is a new revision-checked request.
- applied means committed local state and its durable transaction event exist. Projection lag is separately visible and never changes applied back to pending.
- After crash, an applying request is resolved from its transaction event: applied if committed, otherwise safely re-evaluated against expected_revision. Remote effects belong to handoff state and are not blindly repeated.
- Transient failures can be explicitly retried using a new ID/retry_of; uncertain remote results need reconciliation first.
- Permission denial occurs before a request enters the queue. Only the local owner may submit mutations in v1.

## Schedule

Schedule record (ADR 0007), folded from `schedule-run` events: name, job, last_started_at, last_finished_at, last_outcome (ok, failed, interrupted; nullable), last_error, last_summary, running_run_id (nullable), runs[] (newest first, at most 20: run_id, trigger (schedule, catch-up, manual, refresh), started_at, finished_at, outcome, summary, error).

`schedule-run` event payload: schedule, job, run_id, phase (started, finished), trigger (started), outcome, summary and error (finished).

The snapshot carries `schedules[]` built from config and these records: name, job, cron or every, enabled, running, next_due, the last_* fields and the newest 10 runs. Exports never include it.

## Today

The snapshot's `today` (ADR 0009): timezone, generated_for (the store-local date), days[] newest first, each with date, sessions (count started that day) and tickets[] (ticket_id, key, title, status, counts by timeline kind, items[] newest first and at most 12: at, kind, text, plus last_at). Kinds: commit, pr, deployment, status, write, plan, conclusion, handoff, bind; tool entries are excluded. Seven days. Exports never include it.

Digest schedule fields: to (vault-daily and/or file), path (required for file), day (today or yesterday). The digest section is delimited by `<!-- quill:digest:start -->` and `<!-- quill:digest:end -->`; a section edited since the last write fails the run with digest-conflict.

## Handoff

Fields: id, ticket_id, request_id, mode, note (max 280 characters), permissions, base_ticket_revision, repo_id (nullable), base_commit (nullable), branch (nullable), state, requested_at, started_at (nullable), finished_at (nullable), deadline_at (nullable), error (nullable), result_ref (nullable), result_summary (nullable), children_ids[], worktree_path (local-only, nullable), changed_files[], test_results[], commit_sha (nullable), pr_url (nullable), uncertain_effects[], retry_of (nullable), recipe (nullable: name, source builtin|personal|repo, hash), legacy (boolean; true for the built-in handoff modes), outputs[], deadline_ms (nullable: the recipe time cap), suggestions[].

permissions: read_source, edit_source, commit, push_branch, open_draft_pr (all booleans).
suggestion: id, type (next-action, blocker, followup, deploy-evidence, comment-draft), state (proposed, accepted, dismissed), created_at, resolved_at (nullable), request_id (nullable), plus text, or title/category/priority/next_action, or items[] (environment, state deployed|pending|n-a, evidence, deployed_at). Recipes other than the built-in modes never change the ticket until a suggestion is accepted.
Terminal states: done, failed, cancelled, timed-out. A non-done run may still have partial results. A request becoming applied means the handoff was created, not that execution completed.
One queued/running run per ticket and one running attempt-fix per repository. Reservation and execution state are enforced by the worker, not by a disabled button alone.
Queued runs do not consume the execution timeout. Missing runtime/credentials/source fails at dispatch with a reason; no indefinite hidden wait. A queued cancellation releases its reservation.
Result links resolve to local handoff notes for the owner; exported links must be omitted or embedded, never point into a private filesystem.

## Dashboard projection

The versioned snapshot contains generation_id, generated_at, capabilities and collections:
tickets, sessions, checkpoints, handoffs, requests, picknext, meta. Detail endpoints may page large timeline/content fields but must use the same generation and return unavailable rather than mix generations.

picknext entries: rank, ticket_id, raw_score, score (0–100), reasons[].
meta: store_id, store_name, tracker_version, schema_version, owner_machine_id, timezone, sync_interval_hours, last_sync (nullable), next_sync_due (nullable), last_capture_at (nullable), oldest_pending_event_at (nullable), worker_seen_at, capture_health, projection_health, provider_health[], counts_by_status, stale_ticket_count, unresolved_event_count, active_sync_request_id (nullable).
capabilities: read, edit_tickets, handoff, refresh, cancel_requests, export (booleans). Static exports set all mutation capabilities false and remove request credentials and endpoints.

Provider health includes provider, last_success_at (nullable), last_attempt_at (nullable) and error. A local sync does not reset provider evidence ages.

Repository registry: id, project_id, display_name, canonical_path (local-only), default_branch, deployment_environments[], provider_config_ref (local-only). Configuration secrets and canonical paths are never serialized to a shared snapshot.

Freshness: never-synced when last_sync is null; fresh < 2 h; ageing >= 2 h and <= 6 h; stale > 6 h. Show absolute age even outside working hours. Worker connection and capture health are independent indicators. Offline snapshots show exported_at and their fixed last_sync; they do not pretend to reconnect.
