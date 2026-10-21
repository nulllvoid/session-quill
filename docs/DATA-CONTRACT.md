# Session Quill — Canonical Data Contract

Status: revised draft v0.2 · 2026-10-02 · final pass for 1.1.0 (autonomous runs, ADRs 0026–0028) 2026-10-19
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
| Handoff mode | analyse, analyse-followups, attempt-fix, files |
| Handoff access | standard, settings, autonomous, full (ADR 0017, ADR 0026) |
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
- tags: `quill/status/*`, `quill/cat/*` and `quill/stale` are derived and cannot be set. `quill/no-code` (ADR 0024) is the one reserved tag the owner sets and clears: `ticket-update` field `no_code` sets or clears it, and a `tags` list may add it but never drops it by omission; the repository resolver skips such tickets.
- repo_resolution (ADR 0024, absent until the resolver has looked): state (linked, needs-clone, none), repo_id (nullable), remote (nullable), existing_path (nullable, local-only: a clone of the remote already on disk), rule (repo_map, issue, scan), via (the repo_map key or issue link that matched), checked_at, error and error_kind (nullable: the last failed read of the issue's hints, not-found, forbidden or error), failures (consecutive failed reads), retry_after (nullable: after a not-found or forbidden read, the time before which the ticket is not resolved again; 1 day, doubling to at most 7). remote is in normal form, with no userinfo beyond an ssh login. Recorded by `tracker-sync`, beside the ticket and without a revision bump.
- run_notes (local-only, FEAT-12): the last 20 Run notes, one per finished run that attempted something, appended by the worker through `handoff-tx` (payload `run_notes`), never by a ticket update: { run_id, at, attempts[] (the reconciled attempts: route, tool, target, outcome, reason, evidence, verified, added; free text redacted, capped at 300 bytes and replaced by "[withheld: instruction-like text — see run <id>]" when the instruction filter flags it), lessons[] ({ entry_id, text, trust }: the task-scope memory entries the run filed or confirmed, never quarantined ones), withheld (count, when any), origin ("page" for a page-proposed run: such a note is never delivered to another run) }. Dropped from exports, mirrors, publishers and vault notes.
- local_only (boolean, ADR 0028): true only on a critical change's child ticket, which the critical-proposal reducer creates with tag `critical` and status todo. A local-only ticket never leaves the machine: static exports, the mirror, publishers and tracker push leave it out entirely (a push fails early with `local-only`), it has no vault note, and other vault notes never name it. critical_spec (local-only, same tickets): { from_handoff_id, index, title, action, action_pin, scope, target, scopes, why, evidence, verify, rollback, risk } (see `critical-proposal` below). Ticket sanitisation drops critical_spec and run_notes from every ticket.
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

Fields: id, store_id, actor_id, kind, target_id (nullable), expected_revision (nullable), payload, created_at, not_before, state, applied_revision (nullable), error (nullable), result (nullable), retry_of (nullable), producer (ADR 0028: the producer of the event that journaled it; `worker` for requests submitted through the worker (the dashboard API, schedules, publishers), else the ingress producer such as `cli`. An ingress request claiming producer `worker` is quarantined, never journaled).
kind: set-next-action, set-status, record-deployment, handoff, handoff-cancel, refresh, attach-unbound, dismiss-unbound, link-external, run-job, accept-suggestion, dismiss-suggestion, publish, repo-clone, approve-run, dismiss-run, memory-approve, memory-edit, memory-forget, memory-pin, memory-note, resume-run.

- Memory requests (ADR 0027, spec §6.4). memory-approve, memory-edit, memory-forget and memory-pin target a memory entry by id (`memory-entry-unknown` otherwise) and require expected_revision, the entry's revision (`expected-revision-required`); a different revision when the request applies is a `conflict` (`revision-conflict`, current_revision, result.current { revision, trust, pinned, state }, never the text) and changes nothing. Payloads: memory-approve {} (the entry must be quarantined: `memory-not-quarantined`), memory-edit { text } (1–2,000 characters after trimming; the entry keeps its id and becomes owner trust), memory-forget {} (retires the entry; `memory-entry-retired` when it already is), memory-pin { pinned: true | false } (a quarantined entry cannot be pinned, at submit or when the request applies: `memory-quarantined`; approve it first). memory-note has no target and payload { scope (machine or repo), repo_id (repo scope: a configured repository, else `repo-unknown`), text, section (optional, `[a-z][a-z0-9-]{0,39}`), key (optional, at most 100 characters) } and adds an owner entry; result { entry_id }. memory-forget has the 10 s undo window; the others have no delay. Actors: memory-approve and memory-edit only the owner on the dashboard, that is a request the dashboard server journaled (producer `worker`, actor `owner`; ruling R59, the same check as approve-run of a run-origin proposal and resume-run of a scoped run): an ingress request fails whatever actor it claims (none, `owner` or `cli`), and so does any other actor: they fail with `memory-approve-dashboard-only` / `memory-edit-dashboard-only`; memory-forget, memory-pin and memory-note accept `owner` and `cli`, and fail with `memory-owner-only` for anyone else. The CLI sends no memory change inside an agent run (`cli-in-run`). An applied memory request is journaled as one `memory-tx` event (source identity `memory-tx:request:<request id>`) before its request transaction; an `applying` request whose memory-tx exists finishes as applied. In the owner snapshot a memory request keeps kind, target and state; its payload keeps only `pinned`.

- run-job (ADR 0007) has no target and payload { schedule }; it names a configured schedule, has no undo delay and is applied by the scheduler like refresh. A refresh or run-job left applying by a crash fails with code `interrupted` (retryable) on the next start.

- handoff (ADR 0008) payload: recipe (name; optional, defaults to mode), mode, note, permissions, access, branch, batch_id (optional, ADR 0023: 1 to 64 characters from `A-Z a-z 0-9 . _ : -`; runs queued together from the dashboard share one; anything else fails with `batch-invalid`). With a recipe, permissions must be within its frontmatter; the applied request records recipe { name, source, hash }, and dispatch fails with `recipe-changed` if the file no longer has that hash.
  - access (ADR 0026): standard, settings, autonomous or full; a request without one is standard (schedules, page proposals, older requests). The dashboard and `quill agent run` / `quill handoff` send autonomous unless the owner picks another level. A files run accepts only standard (`access-invalid`).
  - scopes (optional, ADR 0026): write scopes for this run, each `name` or `name:target` (`[a-z][a-z0-9._-]{0,63}`, target `[A-Za-z0-9._/@-]{1,128}`), at most 20, duplicates dropped; a malformed list fails with `scope-invalid`, and any scope with an access other than autonomous fails with `scope-needs-autonomous`. The dashboard, the CLI and the worker (when the request applies) then check each against the scope catalog (built-ins plus the user config's `[scopes]`): `unknown-scope` (not in the catalog, or a `git.*` name: git is a per-run permission), `invalid-scope-target` (a target on a scope that takes none, none on one that needs it, or one that is not a plain token of the scope's kind), `scope-credentials-missing` (a scope whose commands need credentials of their own, with none configured for it or its target), `scope-conflict` (two targets of one scope with different credentials). The message starts with `<code>:<scope>`. Validation never reads the scope fingerprint key; dispatch does (`scope-key-unavailable` when `<quillHome>/scope-fingerprint.key` exists but is not a key Quill wrote, or cannot be created).
  - action pins never come from a payload (an `action_pins` field there is ignored). A recipe whose frontmatter `requires` holds `action_pin` (the built-in `critical-change`) fails with `recipe-needs-approval` unless the run comes from an approved critical change, and one that requires `scopes` fails with `recipe-needs-scopes` without any (ADR 0028).
  - max_turns (optional, integer 1–1000) and max_budget_usd (optional, number above 0 and at most 1000): the run's own turn and spend caps, which win over the recipe and `[handoff]` config; anything else fails with `budget-invalid`.
- accept-suggestion and dismiss-suggestion target a ticket and take payload { handoff_id, suggestion_id }; accept requires expected_revision, dismiss does not. Both have the 10 s undo window. A suggestion resolves once.

- repo-clone (ADR 0024) targets a ticket without a repository and not marked `quill/no-code`; payload { url } is the remote the owner confirmed (https, ssh:// or git@host:path; a host outside `[tracker] clone_hosts` fails with `clone-host-refused` unless the ticket's resolution names a clone of it already on disk). expected_revision is optional and there is no undo delay. The worker's onboarding extension runs one at a time: it clones into `auto_clone_dir` (or links or registers an existing clone of that remote), registers the folder in config.toml and links the ticket with `ticket-update`; result { action (clone, register, link), repo_id, remote }. One left applying by a crash fails with `interrupted` (retryable).

- approve-run and dismiss-run (ADR 0025) target a ticket and take payload { proposal_id }, an open run proposal of that ticket (`proposal-unknown`, `proposal-resolved`, `proposal-expired` otherwise); expected_revision is optional. Only actors `owner` and `cli` may send them; any other actor fails with `approval-refused` when the request applies. approve-run fails with `recipe-shadowed` when the ticket's repository has its own recipe of that name, or `recipe-changed` when the offered recipe's hash changed. It has no undo delay and applies as a handoff of the proposal's recipe, permissions and access with `suggest: true`, an empty note and `proposal` { id, publisher, editor, recipe }; it fails with `handoff-reserved` (naming the ticket and the active run) while the ticket has a queued or running run, leaving the proposal open. result { handoff_id, proposal_id }. dismiss-run has the 10 s undo window. A run-origin proposal (a critical change, ADR 0028) is approved only on the dashboard: actor `owner` on a request with producer `worker`; the CLI, an ingress request claiming the owner, a schedule or a page fail with `critical-approve-dashboard-only` (dismissal still accepts `owner` and `cli`). Its approval re-validates each of the proposal's scopes against the current scope catalog: one that no longer resolves, or resolves to a fingerprint other than the one the proposal recorded (the scope's matchers, label, target table or credential references changed), fails with `scope-changed` and leaves the proposal open. The recipe is the built-in `critical-change` (pinned by name and source; a repository or personal recipe of that name never shadows it); when its hash differs from the one the proposal recorded the approval still applies and result.note is `recipe updated since proposed`. It then applies as a handoff with access `autonomous`, the proposal's permissions (all false), scopes [`name:target`], an empty note, `suggest: true`, action_pins [{ scope, pin }] (one per scope, pin = the action pin's guard string), scope_fingerprints and origin_proposal_id (below), and proposal { id, origin `run`, from_handoff_id, recipe }; `handoff-reserved` and the 7-day lapse apply as for other proposals.

- publish (ADR 0010) has no target and payload { publisher (a name, or null for all), confirm }. It has no undo delay and is applied by the scheduler; confirm records consent to the publisher's current destination.

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
- resume-run (spec §5.4) targets a ticket and takes payload { handoff_id }, a run of that ticket (`handoff-unknown` otherwise) that failed with `interrupted` (`run-not-resumable` otherwise) and recorded a session id that is a UUID (`no-session` otherwise), with no later run on the ticket (`run-superseded`); expected_revision is optional and there is no undo delay. Only actors `owner` and `cli` may send it (`resume-refused` for any other); the CLI (`quill agent resume <run-id>`) refuses inside a run (`cli-in-run`). A run with scopes or action_pins (any scoped run, an approved critical change included) gets production write access again, so it is resumed only as a run-origin proposal is approved: actor `owner` on a request with producer `worker` (the dashboard); the CLI, or an ingress request claiming the owner, fails with `resume-dashboard-only` (ruling R56). Unscoped runs accept `owner` and `cli`. It applies as a NEW handoff with retry_of = the interrupted run, resume_session_id = its session id and no batch_id, copying the original's mode, note, permissions, access, branch, recipe, scopes, max_turns, max_budget_usd and proposal; nothing is widened. A scoped run is resumed only with the scope_fingerprints recorded when its grant was frozen, each checked again against the current catalog (`scope-changed` on any difference, and again at dispatch); an approved critical change also keeps its action_pins and origin_proposal_id, and is refused (`resume-refused`) unless every scope has its pin and fingerprint. The recipe and reservation checks of handoff apply (`recipe-changed`, `handoff-reserved`). result { handoff_id, resumed }.
- Transient failures can be explicitly retried using a new ID/retry_of; uncertain remote results need reconciliation first.
- Permission denial occurs before a request enters the queue. Only the local owner may submit mutations in v1.

## Schedule

Schedule record (ADR 0007), folded from `schedule-run` events: name, job, last_started_at, last_finished_at, last_outcome (ok, failed, interrupted; nullable), last_error, last_summary, running_run_id (nullable), runs[] (newest first, at most 20: run_id, trigger (schedule, catch-up, manual, refresh), started_at, finished_at, outcome, summary, error).

`schedule-run` event payload: schedule, job, run_id, phase (started, finished), trigger (started), outcome, summary and error (finished).

The snapshot carries `schedules[]` built from config and these records: name, job, cron or every, enabled, running, next_due, the last_* fields and the newest 10 runs. Exports never include it.

## Today

The snapshot's `today` (ADR 0009): timezone, generated_for (the store-local date), days[] newest first, each with date, sessions (count started that day) and tickets[] (ticket_id, key, title, status, counts by timeline kind, items[] newest first and at most 12: at, kind, text, plus last_at). Kinds: commit, pr, deployment, status, write, plan, conclusion, handoff, bind; tool entries are excluded. Seven days. Exports never include it.

Digest schedule fields: to (vault-daily and/or file), path (required for file), day (today or yesterday). The digest leaves local-only tickets out entirely (no key, title, item, pending deployment or count that names them), and does not count a session bound only to local-only tickets (ruling R60). The digest section is delimited by `<!-- quill:digest:start -->` and `<!-- quill:digest:end -->`; a section edited since the last write fails the run with digest-conflict.

## Tracker sync

`external.remote` (ADR 0011, nullable): title, status, assignee, fix_versions[], fetched_at — what the tracker said at the last `tracker-sync`. `external.validation` becomes valid or not-found. Neither changes the ticket's own fields or revision.

`tracker-sync` payload: system, synced_at, results[] (ticket_id, key, validation (valid, not-found, or null on an error), remote (nullable), error (nullable)), resolutions[] (optional, ADR 0024: ticket_id, state, repo_id, remote, existing_path, rule, via; or ticket_id, failed: true, error, error_kind for a hint read that failed, which keeps the previous outcome and updates checked_at, failures and retry_after). A resolution sets `repo_resolution` and adds a `tracker` timeline entry only when the state, repository or remote changed; a `linked` resolution is followed by a `ticket-update` (source `resolver`) setting repo_id.

Imported tickets (ADR 0024) are ordinary `ticket-create` events with source identity `tracker-import:<KEY>` and id `externalTicketId(store_id, key)`, so an issue is imported once. GitHub issue keys are `<PREFIX>-<number>`, the prefix being the tracker's first `prefixes` entry or the repository name in capitals.

Tickets may carry `effort` { active_ms, turns, tokens { input, output, cache_read, cache_write } }. Active time adds, for each prompt, tool or stop event of a session bound to the ticket, the gap since that session's previous event, capped at 5 minutes. A `stop` event adds a turn and, when its payload carries `usage` (the same four token counts, summed by the Stop hook from the transcript lines appended since its last read; no text is kept), those tokens. Tickets without `effort` have none recorded.

Tickets may carry `branches` [{ name, first_seen, last_seen }] (at most 20), from the `branch` field of attributed `post-tool` payloads that wrote files or committed. A `reconcile` payload's `pr_updates` entry with `link: true` adds a PR (provider, url, head_branch) to a ticket that does not have it yet, then applies its state like any poll. Merge updates may carry `deploy_on: "merge"`, which records the merge as deployed (`evidence_kind: "merge"`) in every environment of that PR and moves the ticket to done when nothing else is outstanding (ADR 0021).

`tracker-push` payload (ADR 0018): ticket_id, system, key, from (nullable), to (nullable; null when only a comment was sent), comment (boolean), ok, error (nullable). It adds a `tracker` timeline entry and, when ok with a status, sets `external.remote.status`; it never changes the ticket's own fields or revision.

`ticket-update` payload may carry `expected_revision` (integer); when present and different from the ticket's revision, the update is rejected with `revision-conflict`. Events without it apply as before.

`artifact-comment` payload: publisher, ticket_id, key, thread_id, comment_id, author (an opaque viewer id), text, at. It adds a `comment` timeline entry (one line, marked as from a page viewer); its source identity is `artifact-comment:<publisher>:<comment_id>`, so a comment is recorded once.

Two-way artifact rows also carry `_quill.revision` (the ticket revision at publish) and `_edits.<field>` { by, at } for page edits. A page edit to status or next becomes a set-status or set-next-action request with actor `artifact:<publisher>`, expected_revision = `_quill.revision` and an id derived from the edit (publisher, ticket, field, value, revision, `_edits.<field>.at`). An executor read step reports `complete: true` once it has listed every document.

With `run_agent = true` (ADR 0025) rows also carry `run` (empty, or a recipe name an editor picked with Run agent). A pick comes back as an edit of `run` and becomes a `run-proposal` event instead of a request; the following publish writes `run` back to empty.

`run-proposal` payload (ADR 0025): id (the edit's request id), ticket_id, publisher, editor (as the page reported it; one line, at most 120 characters, nullable), edited_at, recipe { name, source, hash }, mode, permissions (commit, push_branch and open_draft_pr always false), access (always standard), read_only, expected_revision. The recipe is the one the page offers (built-in or personal layer); a pick whose ticket resolves another recipe of that name is refused. Source identity `run-proposal:<id>`. A run-proposal never carries a run origin: one with origin other than page, from_handoff_id, action_pin or scopes is rejected with `proposal-origin-invalid` (run-origin proposals come only from a critical-proposal event, ADR 0028). It is rejected with `run-already-proposed` while the same ticket has an open proposal of the same recipe. Run proposal record: the payload fields plus proposed_at, lapsed_at (nullable: when the ticket was first done after the pick), state (proposed, approved, dismissed), resolved_at, resolved_by (the approving or dismissing actor), request_id and handoff_id (nullable). It adds a `proposal` timeline entry, without the editor, and never bumps the ticket revision. An open proposal reads as `expired` once it is older than 7 days, has `lapsed_at`, or its ticket is done or gone. A row whose only page edit is `run` gets its `_quill.revision` stamp moved to the current revision like an unedited row. Resolved and expired proposals are dropped 30 days on.

`critical-proposal` event (spec §7, ADR 0028; ruling R44): emitted only by the worker (producer `worker`), once per entry of a done run's critical_changes[] that passes every emission check below; an ingress file of this kind is quarantined whatever producer it claims, and the reducer refuses any other producer (`critical-proposal-source`). The worker validates once, at emission, and journals the result: the action pin, the scope with its fingerprint from the scope catalog, and the child's title, description and critical_spec. Payload: id (`deterministicId("<from_handoff_id>:critical:<index>")`, else `critical-id-mismatch`), from_handoff_id, index (0–99), pin (the action pin, below; kind bash or mcp, non-empty normalized and guard, at most 16,000 characters as JSON, else `critical-pin-invalid`), scopes [{ name, target (nullable), fingerprint (64 hex) }] (1–5, never a git pseudo-scope, else `critical-scope-invalid`), child { key, title (1–200 characters), description (1–4,000), critical_spec (an object, at most 32,000 characters as JSON) } (else `critical-child-invalid`). Source identity `critical-proposal:<id>`. On replay the reducer checks only that structure and those caps, the id, the producer and that the run exists and is `done` (`critical-run-unknown`, `critical-run-not-done`); it never re-pins the action or reads the result blob, so an accepted event stays accepted whatever later releases change in the pin code or the guard's parser. A refused event changes nothing, adds { at, event_id, producer, id, from_handoff_id, index, code } to the reducer's critical problems (newest 100) and is recorded as a `critical-proposal-rejected` health error { event_id, code }. An accepted one creates a child ticket of the run's ticket (key, title and description from the event) with status todo, tag `critical`, `local_only: true` and critical_spec { from_handoff_id, index, title, action (exactly as the agent wrote it), action_pin, scope, target, scopes, why, evidence, verify, rollback, risk } (display fields one line, hidden characters removed, capped), and a run proposal { id (the event's), ticket_id (the child), origin `run`, from_handoff_id, recipe { name `critical-change`, source `builtin`, hash (the payload's optional recipe_hash, 64 hex: the built-in recipe's hash when the worker emitted the event, else null; a malformed one is `critical-proposal-invalid`) }, access `autonomous`, scopes, action_pin, publisher and editor null, permissions all false, plus the record fields above }. The child's description says what the change is for and points to the proposal; it never repeats the action, why, evidence, verify or rollback (R46). A second event for the same id is a duplicate. The proposal keeps the 7-day lapse of other proposals. At worker start, done runs of the last 7 days whose planned proposals were never journaled (a stop between the run's handoff-tx and the emission) are emitted then, once.

Action pin (ruling R40): { kind (bash or mcp), normalized, guard, … }. A shell pin is one plain command (no environment prefix, wrapper, chain, redirect or expansion; run by its bare name) with binary, verb, resource, context, namespace, flags[] and values[] (`name=value`) when the built-in scope tool lists know the tool and every option, else binary, exact: true and values[] (the words in order). normalized is order-insensitive for listed options (`--opt v` and `--opt=v` alike; repeated options keep their order; free-form values exact); guard is the command exactly as written, which the approved run's guard enforces exactly (ruling R43: the guard compares the pin to the call, never normalized; see ADR 0028). An MCP pin is `<tool name> <JSON object input>`: tool_name, ids (the identifying arguments: issue key, app, channel and the like; values capped at 200 characters), normalized and guard (`<tool name> <canonical JSON of the whole input>`). In an approved run the guard allows a pinned write only when it matches a pin and a granted scope also covers that call by the same allow-list (R48), so a pin never widens a scope. An action holding a control, format (Cf: zero-width, bidi marks, embeddings, overrides, isolates, soft hyphen, BOM) or line/paragraph separator character, in its text, a decoded word or a JSON key or value, is never pinned; nothing is ever stripped from an action. The forms of the brief's examples are frozen by a golden test. Run proposals, action pins, scopes and critical_spec never appear in exports, the mirror, publisher payloads, tracker pushes or vault notes. Local-only tickets have no vault note at all, and other notes never name them (a parent's follow-ups and children_ids, a session's tickets and bindings, and a run's note show "a local-only ticket" or leave them out). A session note for a session bound to a local-only ticket also leaves out its prompt title, final message (last_checkpoint_preview, last_checkpoint_id) and unlinked work, and the local-only ids in its front matter (ruling R60). A run whose ticket is local-only (every approved critical-change run) has no vault note either (ruling R49), decided in one place for the worker and `quill sync replay`; a note an earlier version wrote for one is removed at worker start and on `quill sync --notes`.

## Publisher

Publisher record (ADR 0010), folded from `publish-run` events: name, url (artifact, nullable), confirmed[] (consent fingerprints: a hash of the destination and of what is sent — fields, projects, links, two-way, and Run agent when it is on), last_published_at, last_outcome (ok, failed, needs-confirmation, needs-session), last_error, last_summary, runs[] (newest first, at most 20: run_id, at, trigger (manual, schedule, after-reconcile, session), outcome, summary, error).

`publish-run` payload: publisher, run_id, outcome, summary, error, url, destination (the consent fingerprint), confirmed (true when this run carried the owner's confirmation), trigger.

The snapshot's `publishers[]`: name, kind, label (Live, Copy, Note), executor, title, fields, projects, include_links, after_reconcile, destination_label (a file name or the artifact URL; never a local path), url (the configured one when set), last_url, consent_id, consent_ids[], confirmed, running, the last_* fields and the newest 5 runs. Exports never include it.

Artifact db layout: `tickets/<key>` (the publisher's fields plus `_quill` { in_scope, published_at }) and `meta/page` (title, fields, published_at, publisher, generator).

## Handoff

Fields: id, ticket_id, request_id, mode, note (max 280 characters), permissions, base_ticket_revision, repo_id (nullable), base_commit (nullable), branch (nullable), state, requested_at, started_at (nullable), finished_at (nullable), deadline_at (nullable), error (nullable), result_ref (nullable), result_summary (nullable), children_ids[], worktree_path (local-only, nullable), changed_files[], test_results[], commit_sha (nullable), pr_url (nullable), uncertain_effects[], retry_of (nullable), proposal_id (nullable, ADR 0025: the run proposal it was approved from), proposal (nullable, ADR 0025: { id, publisher, editor, recipe }; shown to the agent only as labelled page data), recipe (nullable: name, source builtin|personal|repo, hash), legacy (boolean; true for the built-in handoff modes), outputs[], deadline_ms (nullable: the wall clock the run gets, from the same budget dispatch uses: the recipe's `timeout_min` when it sets one, else `[handoff] timeout_min_autonomous` (default 30) for autonomous and `timeout_min` (default 20) otherwise, at most 60 minutes), suggestions[], timings (nullable, ADR 0022: queue_wait_ms, worktree_ms only when a checkout was created, agent_ms (agent turns, without the test gate's runs), test_ms (ADR 0023: total time of the test gate's runs, only when one ran); only measured fields are present), batch_id (nullable, ADR 0023), test_gate (nullable, ADR 0023; see below).

Autonomous runs (ADR 0026) add, on any run where they apply:
- access: as requested (standard when absent); a queued run keeps it.
- scopes[] (only when requested; autonomous only): the write scopes asked for, as requested. Dispatch resolves them again through the scope catalog of the current config; one that no longer resolves fails the run with the catalog's code (above), and a granted scope that needs credentials but got none when the run started (an `env:NAME` reference that is not set) fails it with `scope-credentials-missing`. The run's grant file holds each scope's name, target, patterns and fingerprint, never its credentials.
- prod_effects[] (local-only, full access only): what the observe-mode guard saw the run write to production or an external system, recorded whatever state the run ends in: { scope, target (nullable: null when the call was not one plain command naming one target, by the built-in allow-lists), tool (the tool name), t (when), ambiguous (true when target is null for that reason) }, at most 200; git and Quill's own commands are not included. Calls are never refused in full access. Absent when the run was not observed (Claude Code older than 2.1.295, or the run never started).
- max_turns, max_budget_usd (only when requested): the run's own caps.
- action_pins[], scope_fingerprints, origin_proposal_id (local-only, only on a run approved from a critical change, ADR 0028): action_pins [{ scope (`name` or `name:target`, one of scopes[]), pin (the exact action: a shell command as written, or `<tool name> <canonical JSON input>`) }]; scope_fingerprints { `name:target`: fingerprint } as checked at approval; origin_proposal_id. Dispatch resolves the scopes again and fails the run with `scope-changed`, before anything starts, when a fingerprint differs; otherwise the frozen grant file holds the scopes and the pins (`actionPins`), and later config edits never change a dispatched run's grant. In that run the guard allows a write in a granted scope only when it matches a pin exactly (ruling R43: a shell pin the same words as the command, quoting and spacing aside; an MCP pin the same tool and the same whole input as canonical JSON), and a granted scope also covers it (R48). This is deliberately stricter than spec §7.5's normalised equality (ADR 0028). The run's `done` never sets its ticket done. Never exported, mirrored or written to a vault note.
- session_id (nullable): from the first init event, for resume.
- resume_session_id (nullable, local-only): on a run created by resume-run, the session it continues; its first turn starts with `--resume <id>` and a short prompt saying the earlier run was interrupted and nothing may be assumed done or repeated blindly. Before spawning (ruling R54) the worker copies, never moves, the session transcript `<config root>/projects/<old cwd>/<id>.jsonl` to the project folder of the new run's cwd (and of its real path when that differs), where the config root is the child's `CLAUDE_CONFIG_DIR`, else its home (`USERPROFILE` on Windows, `HOME` elsewhere) + `.claude`, and a folder name is the absolute cwd with every character outside [A-Za-z0-9] as `-`. A source folder Claude Code shortened is found as the one folder holding that transcript. Links are never followed: a project folder or transcript that lstat reports as a symbolic link (Windows junctions included) is refused, and containment is checked on real paths (each project folder must really be a direct child of the real projects folder, the transcript a direct child of its folder, and a new destination folder is created only there and checked again after creation). It never writes outside the real projects folder and never replaces a different transcript (an existing destination, even a dangling link, is never written through). The run then fails before anything is spawned with `resume-session-missing` (message `session not found - retry as a new run`), `resume-session-unreachable` (the new folder name would be longer than 200 characters, which Claude Code shortens unpredictably) or `resume-session-conflict`; a linked or escaping source reads as missing, a linked or escaping destination folder as `resume-session-unreachable`. scope_fingerprints is also recorded at dispatch on every autonomous run with scopes, as its grant was frozen.
- An interrupted run (error `interrupted`: the worker restarted or stopped while it was running) keeps session_id and its partial ledger; every write its ledger shows the guard allowed (scoped writes, MCP writes, pushes; never a refused call or a local commit) is recorded in possible_writes (local-only) as `<call> on <target> may have run` (at most 50; ruling R55). Run detail shows them with uncertain_effects on the owner's dashboard; static exports, the mirror and vault notes carry only a count, as one more uncertain_effects line `N production write(s) may have run`, never the targets, tool or scope names. A failed resume says the session may not have been found.
- inventory (local-only, ruling R6): what the run's Claude Code reported in its first init event, capped: tools[] (names), mcpServers[] { name, status, source }, plugins[] (names; no paths), skills[] (names), version (x.y.z or null), at (when it was recorded).
- cred_report (local-only, autonomous): the credential report of the run's child environment at dispatch: kubernetes, aws, gcp, azure, databases, argo, git, netrc, registries each `readonly`, `stub`, `scope` or `owner`; residual[] (owner credentials no redirect closes, one sentence each); scope_errors[] (ignored scope settings, naming variables, never values); provider (`shared` when Claude Code signs in through Bedrock or Vertex).
- inventory and cred_report stay on the run record in the worker's state: the owner snapshot leaves both out of every handoff (so a snapshot does not grow with each run) and carries only the latest of each in `meta.autonomy`; exports, mirrors and publishers carry neither.
- num_turns, cost_usd (nullable), cost_estimated (true when no API key was in the agent's environment).
- Result blob (local-only, `result_ref`; spec §5.3): the parsed reply of the run, taken only from the stream's final `result` event (never from a tool result), with these optional fields beside the recipe's outputs: stage_reached (investigated, planned, changed, tested, committed, pushed, pr_opened, ci_checked, deployed, verified), plan[] (at most 20 steps), attempts[] { route, tool, target, outcome (worked, failed, refused, unavailable, skipped), reason, evidence } (at most 40; reconciled with the ledger: `verified: "claimed-no-call"` for an attempt with no matching ledger call, `added: true` for a ledger refusal the agent left out), verification[] { claim, method (test, build, lint, query, manual-read), command, result (passed, failed, not-run), detail } (at most 30), critical_changes[] { title, scope, target, action, why, evidence, verify, rollback, risk (low, medium, high) } (at most 3; a cut entry carries truncated: [field names]), learnings[] { scope (repo, task, machine), section, key, kind (fact, procedure, pitfall, tool, pointer), text, evidence[], derived_from (repo-file, own-command, tool-output, external-text) } (at most 15). Only the owner dashboard fetches it (`/v1/content/<hash>`); exports have no result_ref.
- stage_reached (the agent's claim), recorded_stage (from facts the worker observed: tested, committed, pushed, pr_opened; investigated is the floor when nothing was observed, and run detail never shows it as recorded, R51), attempt_count, learning_count, critical_count; the attempt, learning and critical-change items live in the result blob, never on the record.
- critical_notes[] (local-only, done runs): why a critical_changes entry did not become a critical-proposal: { index, reason } with reason: the entry was cut to fit the result limits (the parser marks a cut entry with truncated: [field names]); its scope, target or action holds a control, format or bidi character; `no matching scope configured` (the scope is not in the catalog); the action is not one plain command, or a tool call written as `<tool name> <JSON input>`; the scope catalog's own refusal (for example a scope that needs credentials none are configured for); or the run guard would not cover the action under that scope (ruling R48: `scope <name>[:<target>] would not cover this action: <why>`). That last check is the guard's own: its reading of the call (the target it reads, the designated identifying field of an MCP call) and the scope's command allow-list (the target option exactly once; namespace, region, database and similar options at most once in any spelling; listed options only; one Argo CD app). An MCP call under a scope with a target must also name no other value in its identifying fields. Only these expected refusals become notes; an unexpected error is logged by the worker and leaves no note. Absent when every entry became a proposal.
- memory_filing (local-only): what filing did with the run's learnings and the worker-observed facts: received, filed, confirmed, superseded, conflicts, duplicates, quarantined, dropped, by_trust { verified, sourced, observed, quarantined }, worker { filed, confirmed, superseded, conflicts, dropped (worker facts the instruction filter left out) }, problems[] { code (learnings-capped, learning-invalid, learning-no-repo, learning-no-ticket, learning-key-reserved: an agent key starting test:, denied:, tool: or connector: was moved under agent:), count }. Set by a `handoff-tx` without a state change, just after the terminal state; a run that reached a terminal state without it (a stop or crash in between) is filed again at the next worker start when it finished within the last 24 hours.
- Error codes at dispatch: `runtime-too-old` (Claude Code below 2.1.295, or a version that cannot be read, for autonomous; also when the init event reports an older runtime), the scope catalog's codes, `runtime-missing`.

Exports, mirrors and publishers keep access, the counts, recorded_stage and scope_count (how many write scopes the run had, a number only; R53), and never carry scope names, targets or fingerprints, scopes, prod_effects, inventory, cred_report, the ledger or the stage claim's items (allow list in `sanitizeHandoff`). An error whose code is about write scopes (`scope-*`, `unknown-scope`, `invalid-scope-target`) keeps its code there and in vault notes, but its message is replaced by "a write scope this run needed was not available as granted; the owner's dashboard has the details" (final review M1).

The CLI inside a run (ADR 0026): with `QUILL_HANDOFF_ID` set, every `quill` command except status, doctor, ticket show|list|children, agent list|show|suggestions, handoff list, repo list and memory list|show (ADR 0027; without quarantined learnings) exits with code 2 and `quill: refused inside an agent run (cli-in-run)` before it reads or writes anything; with `--json` it also prints { error: { code: "cli-in-run", message } }. That stops the normal spelling in every access level. In autonomous runs the guard also refuses env-cleared forms and Quill's entry points invoked by path (`quill-privileged`); in settings and full runs the owner's own Claude Code rules decide those. The guard's own read list does not include `memory list|show`: an autonomous run is refused them (`quill-privileged`) and reads its memory from the inline section and `context/` instead.

test_gate, on runs with edit_source that finished their agent turns: status (passed, failed, timeout, skipped), and for a run that ran tests: command, exit_code (nullable on timeout), ms (the last run), tail (the last 4096 characters of combined output), attempts (1, or 2 after the repair turn), repaired (true when the second run passed); for skipped: reason (no changes, or no test_command). A failed or timed-out gate makes the run `failed` with error code `tests-failed` or `tests-timeout`: no commit, push, PR, suggestion or ticket change; the patch stays. Exports keep only status, exit_code, ms, attempts and repaired.

permissions: read_source, edit_source, commit, push_branch, open_draft_pr (all booleans).
suggestion: id, type (next-action, blocker, followup, deploy-evidence, comment-draft), state (proposed, accepted, dismissed), created_at, resolved_at (nullable), request_id (nullable), plus text, or title/category/priority/next_action, or items[] (environment, state deployed|pending|n-a, evidence, deployed_at). Recipes other than the built-in modes never change the ticket until a suggestion is accepted.
Terminal states: done, failed, cancelled, timed-out. A non-done run may still have partial results. A request becoming applied means the handoff was created, not that execution completed.
One queued/running run per ticket and one running attempt-fix per repository. At most `[handoff] max_concurrent_readonly` (default 2) runs without edit_source and `max_concurrent_fix` (default 1) runs with it execute at once (ADR 0023). A batch starts no further member once its recorded spend (the cost_usd its finished members recorded, estimates included) reaches `[handoff] max_batch_budget_usd` (default 30; a value that is not a positive number keeps the default); members already running continue and the rest stay queued until cancelled. A member whose process ended but whose cost is not recorded yet holds the next one back. The snapshot's meta.handoff_limits carries batch_budget_usd, and a held member's row and its batch header say "Batch budget reached". Reservation and execution state are enforced by the worker, not by a disabled button alone.
Queued runs do not consume the execution timeout. Missing runtime/credentials/source fails at dispatch with a reason; no indefinite hidden wait. A queued cancellation releases its reservation.
Result links resolve to local handoff notes for the owner; exported links must be omitted or embedded, never point into a private filesystem.

## Autonomous runs index (1.1.0)

What 1.1.0 added to this contract, in one place; the sections above and below define each item.

- Request kinds: memory-approve, memory-edit, memory-forget, memory-pin, memory-note (ADR 0027) and resume-run (spec §5.4). Handoff payloads gained access `autonomous` (the dashboard and CLI default), scopes, max_turns and max_budget_usd; approve-run gained the run-origin rules of ADR 0028. Request records gained producer.
- Events: `memory-tx` (ops filed, confirmed, superseded, retired, approved, owner-note, pinned, unpinned, edited) and `critical-proposal` (worker only). `handoff-tx` carries `run_notes` (a ticket's Run note) and the run's memory_filing. `run-proposal` refuses run-origin fields (`proposal-origin-invalid`).
- Health error kinds: `critical-proposal-rejected` { event_id, code }, `memory-projection` { error } and `ingress-forged` { event_kind, event_id, producer, error } (ruling R59: a worker-only kind, one of request-tx, handoff-tx, memory-tx, reconcile, notify, schedule-run, tracker-sync and critical-proposal, arrived through ingress; it is quarantined, never journaled, whatever producer it claims).
- Ticket fields: local_only, critical_spec, run_notes, tag `critical`. Handoff fields: access, scopes, scope_fingerprints, action_pins, origin_proposal_id, prod_effects, max_turns, max_budget_usd, session_id, resume_session_id, possible_writes, inventory, cred_report, num_turns, cost_usd, cost_estimated, stage_reached, recorded_stage, attempt_count, learning_count, critical_count, critical_notes, memory_filing. Snapshot: meta.autonomy, meta.handoff_limits.batch_budget_usd, recipes[].caps / timeout_set / requires.
- Export fields: access, attempt_count, learning_count, critical_count, recorded_stage and scope_count (a number; R53), plus one uncertain_effects line `N production write(s) may have run` for an interrupted run (R55). Nothing else of this list reaches a static export, the mirror, a publisher payload, a tracker push body or a vault note.
- Runs → Needs you item types (owner dashboard; a static export has no Needs you): an open page proposal; a critical change (an open run-origin proposal); a finished run with suggestions to decide; a failed or timed-out run of the last 7 days on an open ticket that no later run superseded; a quarantined learning (one per entry); a memory conflict (one per group). The Needs you tab count and the global attention count are the unfiltered list, memory items included.
- Error codes, by where they arise:
  - request submission and apply: `scope-invalid`, `scope-needs-autonomous`, `unknown-scope`, `invalid-scope-target`, `scope-credentials-missing`, `scope-conflict`, `budget-invalid`, `recipe-needs-approval`, `recipe-needs-scopes`, `pin-invalid`, `pin-needs-autonomous`, `pin-without-scope`, `critical-approve-dashboard-only`, `scope-changed`, `proposal-invalid` (a critical change with no pin or scope), `resume-refused`, `resume-dashboard-only`, `run-not-resumable`, `no-session`, `run-superseded`, `target-required`, `expected-revision-required`, `revision-conflict`, `memory-entry-unknown`, `memory-entry-retired`, `memory-not-quarantined`, `memory-quarantined`, `memory-approve-dashboard-only`, `memory-edit-dashboard-only`, `memory-owner-only`, `repo-unknown`;
  - dispatch and the run itself: `runtime-too-old`, `scope-changed`, `scope-credentials-missing`, `scope-key-unavailable`, `grant-failed` (the run's grant, settings or credential stubs could not be written), `no-result` (the agent exited without a final result event), `resume-session-missing`, `resume-session-unreachable`, `resume-session-conflict`;
  - the CLI: `cli-in-run` (exit code 2), `handoff-ambiguous`, `memory-id-too-short`, `memory-entry-ambiguous`; `quill tracker push` of a local-only ticket: `local-only`;
  - the reducer (recorded as problems, never applied): `critical-proposal-source`, `critical-id-mismatch`, `critical-pin-invalid`, `critical-scope-invalid`, `critical-child-invalid`, `critical-proposal-invalid`, `critical-run-unknown`, `critical-run-not-done`, `proposal-origin-invalid`, `memory-entry-invalid`, `memory-entry-exists`, `memory-op-unknown`, `memory-supersede-invalid`.
- Guard refusals the agent sees (ADR 0026), never stored as request errors: `QUILL_CRITICAL_CHANGE scope=<scope> target=<target>: …` for a write outside the granted scopes (or, in an approved critical run, any write other than the pinned action), and `QUILL_DENIED <reason>: …` with reason `grant-tampered`, `untrusted-mcp-server`, `unparseable`, `quill-privileged`, `nested-claude-code` (any call that would start Claude Code, or that turns its permission checks off; R57), `outside-readable`, `outside-writable`, `wildcard-too-broad`, `wildcard-unchecked`, `protected-path`, `no-edit-permission` (also git that changes only the checkout's files), `no-commit-permission` (commits and every git command that writes the shared repository's refs, objects, index or configuration; R58), `no-push-permission`, `no-pr-permission`, `protected-branch`, `no-readonly-credentials`, `unknown-prod` or `guard-error` (the guard failed; the call is refused). The run's ledger records each decision; reconciliation turns a refusal the agent did not report into an `added` attempt.
- Deliberate deviations from the spec, recorded in the ADRs: the run guard refuses `quill memory list|show` in autonomous runs (R38; the CLI itself allows them elsewhere); an approved critical run's guard requires the exact pinned command or MCP input, not the spec's normalised equality (R43); critical proposals are validated once at emission and replay checks only structure (R44); a truncated action or one with control, format or bidi characters is never pinned (R45); a pin's own target must pass the guard's scope coverage (R48); local-only tickets and their runs never reach the vault (R46, R49); the recorded stage never shows the worker's floor (R51); full-access production writes are owner-only (R52); exports carry scope_count only (R53); interrupted runs' possible writes are owner-only beyond a count (R55); resume of a scoped run is dashboard-only (R56).

## Memory

Source of truth: `memory-tx` journal events (ops filed, confirmed, superseded, retired, approved, owner-note, pinned, unpinned, edited), reduced into state.memory; never part of a snapshot, export, mirror or publisher payload. Entry: id, scope (machine, repo, task), repo_id (repo) or ticket_id (task), section, kind, key (nullable), text, evidence[], derived_from (repo-file, own-command, tool-output, external-text, or worker for worker-observed facts keyed test:<command>, denied:<guard code>:<tool>, tool:claude-code and connector:<name>, built from the test gate, the guard's own ledger lines and the init inventory only), trust (owner, verified, sourced, observed, quarantined), quarantine_reason (quarantined entries only: `from a page-proposed run`, `instruction-like text (<pattern>)`, `derived from <x>`, `unverified-cite`), run_id, created_at, last_confirmed_at, confirmations, state (active, stale, retired), pinned, superseded_by (nullable), revision. The worker files a finished run's learnings by provenance (src/memory/file.js, spec §6.2) and writes Markdown projections under `quillHome()/memory/` (_machine.md, repos/<repo>.md, repos/<repo>.owner.md, repos/<repo>.docs.md, _quarantine.md), never under store_path.

Owner review (ADR 0027): `GET /v1/memory` (owner session only, like every `/v1/` route) returns { generated_at, entries[], conflicts[] }. entries are the machine and repo entries still in force (not retired, superseded or aged out) plus quarantined learnings of any scope, each { id, scope, repo_id, ticket_id, section, kind, key, text, trust, pinned, staleness (active or stale), confirmations, last_confirmed_at, created_at, run_id, derived_from, evidence[], revision, conflict_key (nullable), quarantine_reason (quarantined only) }. conflicts are groups of live, non-quarantined entries with the same scope and key and different text: { id (`conflict:<scope>:<repo_id>:<key>`), scope, repo_id, key, entry_ids[] (higher-ranked first), at }. Runs → Needs you adds two item types from it: a quarantined learning (one per entry) and a memory conflict (one per group); both count in the Needs you tab and the global attention count, and a static export has neither. `quill memory list|show` read the same listing from the journal; inside an agent run they leave quarantined entries out.

## Dashboard projection

The versioned snapshot contains generation_id, generated_at, capabilities and collections:
tickets, sessions, checkpoints, handoffs, requests, picknext, meta. Detail endpoints may page large timeline/content fields but must use the same generation and return unavailable rather than mix generations.

picknext entries: rank, ticket_id, raw_score, score (0–100), reasons[].
run_proposals[] (ADR 0025): each run proposal record with state as of generated_at (proposed, approved, dismissed, expired) and ticket_key. Exports and mirrors leave it out.
recipes[]: each recipe the dashboard can run, with caps { standard, settings, autonomous, full } (the wall-clock minutes a run of it gets at each access level, as dispatch computes them), timeout_set (whether the recipe sets its own timeout_min) and requires[] (action_pin, scopes; ADR 0028). The Run dialog never lists a recipe that requires action_pin.
meta: store_id, store_name, tracker_version, schema_version, owner_machine_id, timezone, sync_interval_hours, last_sync (nullable), next_sync_due (nullable), last_capture_at (nullable), oldest_pending_event_at (nullable), worker_seen_at, worker_autostart (boolean, ADR 0022: a login entry from `quill worker install` is registered), capture_health, projection_health, provider_health[], counts_by_status, stale_ticket_count, unresolved_event_count, active_sync_request_id (nullable), handoff_limits (nullable, ADR 0023: { readonly, fix, batch_budget_usd }, the run caps and the batch spend budget in effect), onboarding (nullable, ADR 0024: { clone_hosts[], auto_clone_dir, import_assigned }; null in exports and mirrors), autonomy (nullable, ADR 0026: { inventory (the latest run inventory with run_id and at, or null), credentials ({ report, run_id, at } of the latest autonomous run, or null), readonly_configured[] (credential systems `[prod.readonly]` configures; names only), trusted_mcp_servers[], min_runtime, scopes[] (the write-scope catalog for the Run dialog: { name, label, permits, switches (which variables it switches to, by name), takes_target, target_label, targets[] (target names with their own credentials), credentials (`required`, `optional` or `none`), ready }; never a credential value) }; null in exports and mirrors).
Ticket summaries add repo_state (ADR 0024, nullable): no-code, cloning (a repo-clone request for the ticket is pending or applying), needs-clone, or null.
capabilities: read, edit_tickets, handoff, refresh, cancel_requests, export (booleans). Static exports set all mutation capabilities false and remove request credentials and endpoints.

Provider health includes provider, last_success_at (nullable), last_attempt_at (nullable) and error. A local sync does not reset provider evidence ages.

Repository registry: id, project_id, display_name, canonical_path (local-only), default_branch, deployment_environments[], provider_config_ref (local-only), test_command (nullable, ADR 0023; in the owner snapshot, never in an export), test_timeout_ms (config only). Configuration secrets and canonical paths are never serialized to a shared snapshot.

Freshness: never-synced when last_sync is null; fresh < 2 h; ageing >= 2 h and <= 6 h; stale > 6 h. Show absolute age even outside working hours. Worker connection and capture health are independent indicators. Offline snapshots show exported_at and their fixed last_sync; they do not pretend to reconnect.

## 2.0.0 additions

Work in progress for 2.0.0 (plan `docs/superpowers/plans/2026-10-21-quill-2.0.0.md`). Each task fills only its own subsection; Task 13 folds them into a 2.0.0 index.

### Task 1 Ingress redaction

_Not yet filled._

### Task 2 State checkpoint

ADR 0030. `quillHome()/state/state.checkpoint.json` is local generated state: the reduced state at a journal position, so worker start hydrates it and replays only the journal after it. Only the worker writes it (on stop when anything was journaled since the last one, and on an idle tick once `[worker] checkpoint_every` events, default 500, were journaled since the last one); `quill memory list|show` may read it and never write it; a rebuild replays the whole journal. It is never exported, published, mirrored, copied to a run or written to the vault, and nothing in it reaches the dashboard snapshot except through the state it rebuilds.

Fields: format (1), reducer_version (`REDUCER_VERSION` in `src/core/reducer.js`), package_version, code_fingerprint (sha256 of the reducer's source and the modules it imports), meta_fingerprint (sha256 of the meta the reducer reads: store_id, machine_id, machine_name, approval_phrases_enabled, projects, repos), sequence, byte_offset (just past the line of `last_event_id`), last_event_id, state (every state field except meta; Maps, Sets, `undefined`, non-finite numbers and shared or repeated objects as tagged values `$m`, `$s`, `$u`, `$n`, `$o`, `$r`).

A checkpoint is used only when format, reducer_version, package_version, code_fingerprint and meta_fingerprint all match and the journal line ending at byte_offset is the event with last_event_id and sequence; otherwise the whole journal replays and the worker records a `state-checkpoint` health error "state checkpoint ignored: <reason>". `meta` is always built from current configuration after hydration. Hydrating at any position and replaying the rest equals a full replay with the same configuration. The worker's `stateLoad` records how start built state: source (`checkpoint` or `journal`), events_replayed, checkpoint_ignored, ms.

### Task 3 Dry-run preflight and leases

_Not yet filled._

### Task 4 Anchored memory and failure ledger

_Not yet filled._

### Task 5 Evidence receipt and recipe stats

_Not yet filled._

### Task 6 Hook latency

_Not yet filled._

### Task 7 Run snapshots

_Not yet filled._

### Task 8 Ticket worktrees

_Not yet filled._

### Task 9 Planned files and drift

_Not yet filled._

### Task 10 Context card

_Not yet filled._

### Task 11 Attention groups and CI watch

_Not yet filled._

### Task 12 Diff review and critic

_Not yet filled._
