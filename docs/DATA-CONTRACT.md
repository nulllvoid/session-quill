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
kind: set-next-action, set-status, record-deployment, handoff, handoff-cancel, refresh, attach-unbound, dismiss-unbound, link-external, run-job, accept-suggestion, dismiss-suggestion, publish, repo-clone, approve-run, dismiss-run.

- run-job (ADR 0007) has no target and payload { schedule }; it names a configured schedule, has no undo delay and is applied by the scheduler like refresh. A refresh or run-job left applying by a crash fails with code `interrupted` (retryable) on the next start.

- handoff (ADR 0008) payload: recipe (name; optional, defaults to mode), mode, note, permissions, access, branch, batch_id (optional, ADR 0023: 1 to 64 characters from `A-Z a-z 0-9 . _ : -`; runs queued together from the dashboard share one; anything else fails with `batch-invalid`). With a recipe, permissions must be within its frontmatter; the applied request records recipe { name, source, hash }, and dispatch fails with `recipe-changed` if the file no longer has that hash.
  - access (ADR 0026): standard, settings, autonomous or full; a request without one is standard (schedules, page proposals, older requests). The dashboard and `quill agent run` / `quill handoff` send autonomous unless the owner picks another level. A files run accepts only standard (`access-invalid`).
  - scopes (optional, ADR 0026): write scopes for this run, each `name` or `name:target` (`[a-z][a-z0-9._-]{0,63}`, target `[A-Za-z0-9._/@-]{1,128}`), at most 20, duplicates dropped; a malformed list fails with `scope-invalid`, and any scope with an access other than autonomous fails with `scope-needs-autonomous`. The dashboard, the CLI and the worker (when the request applies) then check each against the scope catalog (built-ins plus the user config's `[scopes]`): `unknown-scope` (not in the catalog, or a `git.*` name: git is a per-run permission), `invalid-scope-target` (a target on a scope that takes none, none on one that needs it, or one that is not a plain token of the scope's kind), `scope-credentials-missing` (a scope whose commands need credentials of their own, with none configured for it or its target), `scope-conflict` (two targets of one scope with different credentials). The message starts with `<code>:<scope>`. Validation never reads the scope fingerprint key; dispatch does (`scope-key-unavailable` when `<quillHome>/scope-fingerprint.key` exists but is not a key Quill wrote, or cannot be created).
  - max_turns (optional, integer 1–1000) and max_budget_usd (optional, number above 0 and at most 1000): the run's own turn and spend caps, which win over the recipe and `[handoff]` config; anything else fails with `budget-invalid`.
- accept-suggestion and dismiss-suggestion target a ticket and take payload { handoff_id, suggestion_id }; accept requires expected_revision, dismiss does not. Both have the 10 s undo window. A suggestion resolves once.

- repo-clone (ADR 0024) targets a ticket without a repository and not marked `quill/no-code`; payload { url } is the remote the owner confirmed (https, ssh:// or git@host:path; a host outside `[tracker] clone_hosts` fails with `clone-host-refused` unless the ticket's resolution names a clone of it already on disk). expected_revision is optional and there is no undo delay. The worker's onboarding extension runs one at a time: it clones into `auto_clone_dir` (or links or registers an existing clone of that remote), registers the folder in config.toml and links the ticket with `ticket-update`; result { action (clone, register, link), repo_id, remote }. One left applying by a crash fails with `interrupted` (retryable).

- approve-run and dismiss-run (ADR 0025) target a ticket and take payload { proposal_id }, an open run proposal of that ticket (`proposal-unknown`, `proposal-resolved`, `proposal-expired` otherwise); expected_revision is optional. Only actors `owner` and `cli` may send them; any other actor fails with `approval-refused` when the request applies. approve-run fails with `recipe-shadowed` when the ticket's repository has its own recipe of that name, or `recipe-changed` when the offered recipe's hash changed. It has no undo delay and applies as a handoff of the proposal's recipe, permissions and access with `suggest: true`, an empty note and `proposal` { id, publisher, editor, recipe }; it fails with `handoff-reserved` (naming the ticket and the active run) while the ticket has a queued or running run, leaving the proposal open. result { handoff_id, proposal_id }. dismiss-run has the 10 s undo window.

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
- Transient failures can be explicitly retried using a new ID/retry_of; uncertain remote results need reconciliation first.
- Permission denial occurs before a request enters the queue. Only the local owner may submit mutations in v1.

## Schedule

Schedule record (ADR 0007), folded from `schedule-run` events: name, job, last_started_at, last_finished_at, last_outcome (ok, failed, interrupted; nullable), last_error, last_summary, running_run_id (nullable), runs[] (newest first, at most 20: run_id, trigger (schedule, catch-up, manual, refresh), started_at, finished_at, outcome, summary, error).

`schedule-run` event payload: schedule, job, run_id, phase (started, finished), trigger (started), outcome, summary and error (finished).

The snapshot carries `schedules[]` built from config and these records: name, job, cron or every, enabled, running, next_due, the last_* fields and the newest 10 runs. Exports never include it.

## Today

The snapshot's `today` (ADR 0009): timezone, generated_for (the store-local date), days[] newest first, each with date, sessions (count started that day) and tickets[] (ticket_id, key, title, status, counts by timeline kind, items[] newest first and at most 12: at, kind, text, plus last_at). Kinds: commit, pr, deployment, status, write, plan, conclusion, handoff, bind; tool entries are excluded. Seven days. Exports never include it.

Digest schedule fields: to (vault-daily and/or file), path (required for file), day (today or yesterday). The digest section is delimited by `<!-- quill:digest:start -->` and `<!-- quill:digest:end -->`; a section edited since the last write fails the run with digest-conflict.

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

`run-proposal` payload (ADR 0025): id (the edit's request id), ticket_id, publisher, editor (as the page reported it; one line, at most 120 characters, nullable), edited_at, recipe { name, source, hash }, mode, permissions (commit, push_branch and open_draft_pr always false), access (always standard), read_only, expected_revision. The recipe is the one the page offers (built-in or personal layer); a pick whose ticket resolves another recipe of that name is refused. Source identity `run-proposal:<id>`. It is rejected with `run-already-proposed` while the same ticket has an open proposal of the same recipe. Run proposal record: the payload fields plus proposed_at, lapsed_at (nullable: when the ticket was first done after the pick), state (proposed, approved, dismissed), resolved_at, resolved_by (the approving or dismissing actor), request_id and handoff_id (nullable). It adds a `proposal` timeline entry, without the editor, and never bumps the ticket revision. An open proposal reads as `expired` once it is older than 7 days, has `lapsed_at`, or its ticket is done or gone. A row whose only page edit is `run` gets its `_quill.revision` stamp moved to the current revision like an unedited row. Resolved and expired proposals are dropped 30 days on.

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
- session_id (nullable): from the first init event, for resume.
- inventory (local-only, ruling R6): what the run's Claude Code reported in its first init event, capped: tools[] (names), mcpServers[] { name, status, source }, plugins[] (names; no paths), skills[] (names), version (x.y.z or null), at (when it was recorded).
- cred_report (local-only, autonomous): the credential report of the run's child environment at dispatch: kubernetes, aws, gcp, azure, databases, argo, git, netrc, registries each `readonly`, `stub`, `scope` or `owner`; residual[] (owner credentials no redirect closes, one sentence each); scope_errors[] (ignored scope settings, naming variables, never values); provider (`shared` when Claude Code signs in through Bedrock or Vertex).
- num_turns, cost_usd (nullable), cost_estimated (true when no API key was in the agent's environment).
- stage_reached (the agent's claim), recorded_stage (from facts the worker observed: investigated, tested, committed, pushed, pr_opened), attempt_count, learning_count, critical_count; the attempt, learning and critical-change items live in the result blob, never on the record.
- memory_filing (local-only): what filing did with the run's learnings and the worker-observed facts: received, filed, confirmed, superseded, conflicts, duplicates, quarantined, dropped, by_trust { verified, sourced, observed, quarantined }, worker { filed, confirmed, superseded, conflicts }, problems[] { code (learnings-capped, learning-invalid, learning-no-repo, learning-no-ticket, learning-key-reserved: an agent key starting test:, denied:, tool: or connector: was moved under agent:), count }. Set by a `handoff-tx` without a state change.
- Error codes at dispatch: `runtime-too-old` (Claude Code below 2.1.295, or a version that cannot be read, for autonomous; also when the init event reports an older runtime), the scope catalog's codes, `runtime-missing`.

Exports, mirrors and publishers keep access, the counts and recorded_stage, and never carry scopes, prod_effects, inventory, cred_report, the ledger or the stage claim's items (allow list in `sanitizeHandoff`).

The CLI inside a run (ADR 0026): with `QUILL_HANDOFF_ID` set, every `quill` command except status, doctor, ticket show|list|children, agent list|show|suggestions, handoff list and repo list exits with code 2 and `quill: refused inside an agent run (cli-in-run)` before it reads or writes anything; with `--json` it also prints { error: { code: "cli-in-run", message } }. That stops the normal spelling in every access level. In autonomous runs the guard also refuses env-cleared forms and Quill's entry points invoked by path (`quill-privileged`); in settings and full runs the owner's own Claude Code rules decide those.

test_gate, on runs with edit_source that finished their agent turns: status (passed, failed, timeout, skipped), and for a run that ran tests: command, exit_code (nullable on timeout), ms (the last run), tail (the last 4096 characters of combined output), attempts (1, or 2 after the repair turn), repaired (true when the second run passed); for skipped: reason (no changes, or no test_command). A failed or timed-out gate makes the run `failed` with error code `tests-failed` or `tests-timeout`: no commit, push, PR, suggestion or ticket change; the patch stays. Exports keep only status, exit_code, ms, attempts and repaired.

permissions: read_source, edit_source, commit, push_branch, open_draft_pr (all booleans).
suggestion: id, type (next-action, blocker, followup, deploy-evidence, comment-draft), state (proposed, accepted, dismissed), created_at, resolved_at (nullable), request_id (nullable), plus text, or title/category/priority/next_action, or items[] (environment, state deployed|pending|n-a, evidence, deployed_at). Recipes other than the built-in modes never change the ticket until a suggestion is accepted.
Terminal states: done, failed, cancelled, timed-out. A non-done run may still have partial results. A request becoming applied means the handoff was created, not that execution completed.
One queued/running run per ticket and one running attempt-fix per repository. At most `[handoff] max_concurrent_readonly` (default 2) runs without edit_source and `max_concurrent_fix` (default 1) runs with it execute at once (ADR 0023). Reservation and execution state are enforced by the worker, not by a disabled button alone.
Queued runs do not consume the execution timeout. Missing runtime/credentials/source fails at dispatch with a reason; no indefinite hidden wait. A queued cancellation releases its reservation.
Result links resolve to local handoff notes for the owner; exported links must be omitted or embedded, never point into a private filesystem.

## Memory

Source of truth: `memory-tx` journal events (ops filed, confirmed, superseded, retired, approved, owner-note, pinned, unpinned, edited), reduced into state.memory; never part of a snapshot, export, mirror or publisher payload. Entry: id, scope (machine, repo, task), repo_id (repo) or ticket_id (task), section, kind, key (nullable), text, evidence[], derived_from (repo-file, own-command, tool-output, external-text, or worker for worker-observed facts keyed test:<command>, denied:<guard code>:<tool>, tool:claude-code and connector:<name>, built from the test gate, the guard's own ledger lines and the init inventory only), trust (owner, verified, sourced, observed, quarantined), quarantine_reason (quarantined entries only: `from a page-proposed run`, `instruction-like text (<pattern>)`, `derived from <x>`, `unverified-cite`), run_id, created_at, last_confirmed_at, confirmations, state (active, stale, retired), pinned, superseded_by (nullable), revision. The worker files a finished run's learnings by provenance (src/memory/file.js, spec §6.2) and writes Markdown projections under `quillHome()/memory/` (_machine.md, repos/<repo>.md, repos/<repo>.owner.md, repos/<repo>.docs.md, _quarantine.md), never under store_path.

## Dashboard projection

The versioned snapshot contains generation_id, generated_at, capabilities and collections:
tickets, sessions, checkpoints, handoffs, requests, picknext, meta. Detail endpoints may page large timeline/content fields but must use the same generation and return unavailable rather than mix generations.

picknext entries: rank, ticket_id, raw_score, score (0–100), reasons[].
run_proposals[] (ADR 0025): each run proposal record with state as of generated_at (proposed, approved, dismissed, expired) and ticket_key. Exports and mirrors leave it out.
meta: store_id, store_name, tracker_version, schema_version, owner_machine_id, timezone, sync_interval_hours, last_sync (nullable), next_sync_due (nullable), last_capture_at (nullable), oldest_pending_event_at (nullable), worker_seen_at, worker_autostart (boolean, ADR 0022: a login entry from `quill worker install` is registered), capture_health, projection_health, provider_health[], counts_by_status, stale_ticket_count, unresolved_event_count, active_sync_request_id (nullable), handoff_limits (nullable, ADR 0023: { readonly, fix }, the run caps in effect), onboarding (nullable, ADR 0024: { clone_hosts[], auto_clone_dir, import_assigned }; null in exports and mirrors), autonomy (nullable, ADR 0026: { inventory (the latest run inventory with run_id and at, or null), credentials ({ report, run_id, at } of the latest autonomous run, or null), readonly_configured[] (credential systems `[prod.readonly]` configures; names only), trusted_mcp_servers[], min_runtime, scopes[] (the write-scope catalog for the Run dialog: { name, label, permits, switches (which variables it switches to, by name), takes_target, target_label, targets[] (target names with their own credentials), credentials (`required`, `optional` or `none`), ready }; never a credential value) }; null in exports and mirrors).
Ticket summaries add repo_state (ADR 0024, nullable): no-code, cloning (a repo-clone request for the ticket is pending or applying), needs-clone, or null.
capabilities: read, edit_tickets, handoff, refresh, cancel_requests, export (booleans). Static exports set all mutation capabilities false and remove request credentials and endpoints.

Provider health includes provider, last_success_at (nullable), last_attempt_at (nullable) and error. A local sync does not reset provider evidence ages.

Repository registry: id, project_id, display_name, canonical_path (local-only), default_branch, deployment_environments[], provider_config_ref (local-only), test_command (nullable, ADR 0023; in the owner snapshot, never in an export), test_timeout_ms (config only). Configuration secrets and canonical paths are never serialized to a shared snapshot.

Freshness: never-synced when last_sync is null; fresh < 2 h; ageing >= 2 h and <= 6 h; stale > 6 h. Show absolute age even outside working hours. Worker connection and capture health are independent indicators. Offline snapshots show exported_at and their fixed last_sync; they do not pretend to reconnect.
