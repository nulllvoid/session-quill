# Unified Work control centre

Status: proposed design for review; not an implementation or release announcement.
Date: 2026-10-30. Code baseline: `403eda6` on `main`.
Review: independent builder check completed; four consequential ambiguities resolved and the second pass found none remaining. Proposed product defaults still need acceptance before implementation.

## 1. Intent and decisions

Session Quill should help a developer finish outcomes across tickets, repositories and sessions. Its primary screen must answer: **Is the parent task complete? If not, what remains, what is blocked, and what can I do next?** Detailed activity supports that answer instead of competing with it.

This specification covers UI, interaction, backend contracts, continuity, migration, failure handling and acceptance. MUST means required for the relevant delivery phase; SHOULD permits a documented implementation tradeoff. Proposed identifiers describe contracts, not existing APIs. Existing security, provenance and durability requirements remain in force unless explicitly changed here.

### 1.1 Confirmed user requirements

- Merge Board and Relationships into one relational Work view.
- Show parent completion and outstanding subtasks through expandable rows.
- Reduce information overload; improve ticket management, prioritization and filtering.
- Give Run agent visible close/cancel controls.
- Replace the recipe-first experience with Read only, Plan, Auto and Full access modes.
- Generate a workspace-wide daily standup automatically or on demand for the last 24 hours; retain context across long tasks, including a seven-week effort.
- Explore and specify supporting UX/backend changes, not just visual styling.

### 1.2 Proposed defaults, not prior user approvals

These are concrete defaults for review. They do not block writing this spec.

| Decision | Proposed default | Consequence |
| --- | --- | --- |
| Auto delivery | Edit and test in an isolated checkout; stop at the patch | Commit, push and draft PR require explicit per-run delivery choices |
| Composer initial mode | Read only on a general Run agent action; a clearly labelled contextual action may preselect its mode | Never remember Full access as the next run's default |
| Daily generation | One local draft at 18:00 in the configured store timezone, once daily updates are enabled | Configurable time and weekdays; no external posting |
| Summary scope | Whole local workspace; explicit project/repository selection for a scoped update | UI filters do not silently change a scheduled update's scope |
| Default Work view | Open parent outcomes, collapsed, ordered by priority | Completed parents available through Completed/All |
| Completion | Reuse current evidence/children policy and existing reconciliation authorization | This redesign grants no new auto-close authority |

The Auto delivery default and daily schedule are still product choices the owner may change before implementation. All other minor choices explicitly assigned to the builder are listed in §18.

### 1.3 Approaches considered

| Approach | Benefit | Cost / disposition |
| --- | --- | --- |
| Shorten existing Board cards and retain Relationships | Smallest visual patch | Leaves two competing task views and makes users reconstruct parent progress; rejected by the user's unified-view preference |
| Unified expandable Work list | Parent outcome, remaining work and actions share one place; existing ticket model can support it | Requires shared hierarchy derivation and ancestry-aware filtering; selected direction |
| Graph/canvas as primary workspace | Useful for complex dependency exploration | Harder to scan, filter, use by keyboard or on a phone; out of this delivery |

Keep recipes as execution templates behind the composer. Do not delete the recipe engine or replace the event journal, scheduler, frontend framework or storage architecture.

## 2. Current implementation and gaps

Paths are relative to the repository root.

| Area | Existing implementation | Required change |
| --- | --- | --- |
| Board | `ui/views/board.js`, shared `ticketCard` in `ui/components.js`; status columns sorted by activity; full next-action text | Replace primary Board presentation with compact hierarchical rows |
| Relationships | `ui/views/tree.js`; read-only tree, direct child counts, depth-limited navigation; root filtering checks only direct children | Merge into Work; descendant-aware filtering, expansion and editable relationships |
| Ranking | `src/reconcile/picknext.js`; deterministic score with priority, due date, deployment/review age | Reuse for suggested next work; distinguish suggestion ranking from the user's priority |
| Completion | `src/core/closure.js`, ADR 0042; `completion_mode`, `blocks_parent`, resolution, closure conflicts | Reuse authoritative assessment and expose structured rollups and reasons |
| Run entry | `ui/views/run-dialog.js`, `ui/views/agents.js`; recipe cards followed by permissions; Cancel below content | One mode-based composer with persistent dismissal/actions |
| Runtime | `src/handoff/permissions.js`; legacy task modes and separate standard/settings/autonomous/full access tiers | Add an explicit product intent mapping; do not conflate task intent with runtime permission mode |
| Results | `src/handoff/extension.js`; tested/no-change/unverified/unknown fix outcomes | Retain and show as separate from process completion and ticket completion |
| Standup | `recipes/standup.md`; three lines for one ticket | Move the default UX to a workspace Daily update feature |
| Digest | `src/today/feed.js`, `src/today/digest.js`, `src/schedule/jobs.js`; calendar-day activity counts | Reuse schedule/transport primitives; add bounded workspace summaries with evidence and long-term context |
| Memory | `src/memory/*`; trust, provenance, stale/conflict/quarantine handling | Reuse for continuity, never as sole proof of delivery |
| Mutations | `src/server/requests.js`, `src/core/reduce/requests.js`; durable, revision-checked requests and undo | Extend the same path for hierarchy edits, priority, plan revisions and update generation |

The existing seven-day Activity display and twelve-item per-ticket preview are not an adequate history source for a seven-week task. Daily generation MUST use full authorized state/journal references, not scrape rendered cards or capped previews.

## 3. Scope and non-goals

Required scope: unified Work; compact details; priority/status filtering and edits; hierarchy management; four-mode composer; clear run cancellation/results; a unified attention queue; Daily update with long-term continuity; compatibility and test coverage.

Not in this delivery: a new graph database, general dependency-graph editor, sprint estimation engine, autonomous creation of unlimited subtasks, automatic Jira writes, automatic Slack/email posting, a new agent framework, redesigning every deployment/memory screen, or claiming team-wide coverage from one developer's local data.

Daily summaries and plan generation MUST NOT create tickets, mutate statuses, approve follow-ups, trigger implementation or publish externally as a side effect.

## 4. Information architecture and visual system

### 4.1 Navigation

Primary destinations: **Work**, **Runs**, **Daily update**, **Sessions**. Secondary navigation: Activity, Deployments, Memory, Settings/Health. Relationships is absorbed into Work. Pick next becomes the Work **Suggested next** lens, not another competing ticket collection.

Badges count actionable items only: runs needing attention, unresolved decisions, or active runs with a clear label. Do not display unrelated lifetime totals on every navigation item. Use one persistent health indicator that separates worker connection, local capture health and external-provider freshness in its detail.

### 4.2 Layout and density

- Reuse current semantic tokens, typography, light/dark themes and line icons. No new UI framework or styling dependency.
- Desktop: labelled sidebar, one filter toolbar, full-width Work rows; selected ticket details in a right drawer. Main content remains operable while the desktop drawer is docked.
- Parent rows: approximately 52–64 px for two lines; child rows 40–48 px. Use 14 px readable body text; never shrink text to fit long notes.
- Title: at most two lines. Secondary next-action/blocker preview: at most one line in a collapsed row. Full text remains in details and accessible without hover.
- Columns: expansion/selection, task identity, priority, workflow state, completion summary, attention/run signal. Hide secondary columns into the second line at narrower widths.
- Color marks state or a necessary action. Use neutral surfaces and quiet row separators; no decorative gradients, repeated saturated badges or blanket bold text.
- No new KPI-card row above the work list. A compact count sentence is enough.
- At 1366×768, at least six collapsed parent rows should be visible below navigation/filters with no dialog open. This is a layout acceptance target, not a production telemetry claim.

### 4.3 Responsive and accessibility requirements

Validate 1440, 1366×768, 1024, 768 and 390 px, both themes, keyboard-only and reduced motion. At phone width, show one pane at a time, preserve list position on Back, and use at least 44 px touch targets. Desktop interactive targets must remain at least 32 px. No page-level horizontal scrolling.

Prefer nested semantic lists with disclosure buttons (`aria-expanded`, `aria-controls`) over a partial ARIA tree implementation. Only use tree/treegrid roles if the full corresponding keyboard model is implemented. Expansion, selection and opening details are separate controls; no nested buttons. Focus returns to the originating row after dismissal, or its nearest surviving ancestor if the row disappeared. Announce user-visible results, not every polling refresh. Text contrast and focus indicators must be measured against actual surfaces.

## 5. Unified Work behavior

### 5.1 Hierarchy and scope

The existing `parent_id` defines a single-parent hierarchy. A root may span repositories; a repository filter must not destroy that relationship. Do not infer a parent from matching titles, branch names or shared tags. A ticket without children is a valid root outcome.

Each parent row shows title/key, its explicit priority and workflow status, required-child progress, one leading blocker/next action, and an active-run or attention indicator. Expand reveals direct children, recursively expandable. Show a breadcrumb when focusing a deep subtree; do not cap the data at depth three or silently drop deeper children.

Within each expanded parent:

1. Required children that are open or need review.
2. Completed required children behind “Completed (N)”.
3. Independent follow-ups behind “Related follow-ups (N)”.
4. Unknown legacy relationships behind an actionable “Classify N relationships” item.

Children are rendered once in their canonical position. Cross-references elsewhere are links, not additional work records. Standalone or unresolved-parent tickets remain discoverable in an explicit group. Invalid imported cycles must not hang rendering: mark the invalid edge, stop following it, and offer inspection. Do not mutate source data while building a view.

All parents start collapsed except a restored selection/expansion state or a deep link's ancestor chain. Polling preserves expansion, focus, scroll and unsent edits. Updates do not constantly move a focused row; apply reordering after the interaction completes and preserve its position where possible.

### 5.2 Completion semantics

Workflow status, run result and closure readiness are separate concepts. Derived labels such as **Ready to close**, **Needs review** and **Waiting on deployment** are not new editable workflow statuses.

For a parent, define direct-child buckets:

- Required: `blocks_parent === true`.
- Independent: `blocks_parent === false`.
- Unclassified: `blocks_parent == null`.
- Required completed: required child with `status === done`, resolution absent (legacy) or `resolution.kind === completed`, and no recorded or propagated completion conflict.
- Required resolved without delivery: required child done as duplicate, superseded, not-needed or abandoned; display separately and require review.
- Required remaining: required total minus required completed; includes open, conflict and non-delivery resolution buckets without double counting.

A done child with a completion conflict is excluded from completed and included in remaining; its workflow status still stays done until an authorized status change. Display “Done · Needs review” on that child. For arithmetic, remaining buckets are disjoint: non-delivery resolution first, then other completion conflicts, then open children. A recorded revert, reopened required descendant, required descendant resolved without delivery, or unclassified required-path relationship produces a completion conflict on a done ancestor. Missing historical evidence alone does not retrospectively turn every legacy done child into a conflict; label its provenance as recorded completion, not newly verified delivery.

Show “4 of 6 required subtasks completed”, never “67% of the work delivered”. A task count is not an estimate of effort. A parent with no required children says “No required subtasks”, not “100% complete”. Nested child parents each have their own rollup; the parent denominator counts direct required children, not every descendant. Total pending descendant counts, if shown, must be labelled separately.

Use `assessClosure` as the authority for closing. A parent in `children` mode may become closable after all required work satisfies the existing policy; a parent in `evidence` mode still requires its own completion evidence. Outstanding deployments, active runs, unresolved effects, unknown relationships, stale evidence or newer manual decisions must remain visible blockers.

When a done parent has reopened required work, a reverted delivery, or another closure contradiction, surface **Needs review** even in the default Open view. Do not silently rewrite manual status. A required nested child that is done but has a closure conflict must propagate a review blocker up its required ancestor chain. Independent descendants do not block ancestors. Compute this bottom-up with cycle protection and test it against the authoritative closure path, not just the UI.

Changing a required relationship may change readiness; it does not authorize closing the parent. Show that consequence before submission. Existing acknowledgement/evidence version checks continue to reject outdated decisions.

### 5.3 Filters, lenses and sorting

Toolbar: search, repository/project scope, Status, Priority, More filters, Sort. Show removable active chips and Clear all. More filters: blocked, stale, needs attention, active run, ready to close, tag/category, and unresolved parent/repository. Multiple selections within one dimension are OR; dimensions combine with AND.

Lenses: **Open** (default), **Suggested next**, **Needs attention**, **Completed**, **All**. These are presets over shared Work data, not copies of tickets. Open includes non-done roots and roots with actionable descendants or closure conflicts, even if the root itself is done.

Search matches key, aliases, title, repository name, current next action and blocker. It does not send private text to an external search service. Existing text normalization should be reused.

Filtering algorithm: identify direct matches at any depth, include every ancestor needed to locate them, and mark those ancestors as context. In a filtered tree show matching descendants and their paths; offer “Show all subtasks” on a context parent to reveal nonmatching children explicitly. A matching parent does not automatically make every descendant match. Report “N matching tasks in M outcomes”; context ancestors are not counted as matches. Search-triggered expansion is temporary and restores the user's previous expansion state when cleared.

Completion counts always describe the full authorized hierarchy, never only filtered, paged or loaded rows. In a privacy-filtered export, explicitly state that counts cover shared tasks only; do not reveal the existence/count of omitted private children or assert authoritative closure from that partial view.

Default root sort: explicit priority P0–P3, due date (missing last), oldest substantive activity (missing last), stable ID. For suggested-next, reuse deterministic pick-next scoring, select eligible actionable tasks, group them under their parents, and order groups by their highest-ranked matching task. Show one plain reason, with score details on demand. An urgent child must be visible as a child-priority signal; do not silently overwrite its parent's priority.

Within required open children, use priority/due/activity ordering. A user-selected sort applies consistently and has a stable tie-breaker. Sorting never changes stored priorities. Deferred: drag-to-rank and a new persistent manual ordering model.

Persist scope, filters, lens and sort in safe URL state; expansion/scroll/selection preferences may be browser-local keyed by store and machine. Do not put prompts, secrets, filesystem paths or summary content in URLs. Changing filters must not silently preserve a destructive bulk selection: clear selection with an announcement.

### 5.4 Ticket management

Support inline priority/status changes, edit next action, add required subtask, link an existing child, move/unlink a child, and classify independent/required relationships. Status-to-blocked collects a reason in the same flow. Ticket creation requires the existing Goal/Context/Done-when description contract. An agent-proposed child remains a proposal until accepted.

Parent selection does not select descendants. Bulk priority/status acts on explicitly selected IDs, displays the scope/count, and shows per-item success/conflict/failure. No implied cascade to children; no all-or-nothing promise when individual revisions differ. Preserve the existing delayed-edit cancellation window and revision conflict experience.

Reparenting validates existence, same store, no self/descendant cycle, and relationship classification. A change checks the child revision and both affected parent revisions; a missing previous parent is represented explicitly. Revalidate at application time. Update child indexes and both parent rollups atomically within the worker event transaction. Cross-repository/project parentage in the same store is allowed and clearly labelled. Removing an edge never deletes a ticket or its evidence.

Local priority/status edits do not implicitly update Jira or another tracker. Show remote status and observation age beside local status when they disagree. A separate existing authorized integration action is required for an external write.

### 5.5 Detail drawer and continuity

Default detail answers: goal, completion rule, remaining required work, leading blocker, next action, latest verified result, and where the developer stopped. Offer contextual Resume/View run/Run agent actions. Keep raw timeline, sessions, files, memory and diagnostics under secondary tabs/disclosures.

“Resume” first opens the recorded session/worktree context; it must not silently start another agent or replay an old write. Check that a checkout/session still exists and explain recovery when it does not. Never change a live session binding just because a dashboard or detail opens.

## 6. Agent composer and execution contract

### 6.1 Composer

One dialog: target ticket/breadcrumb, task objective, four mode choices, concise repository/environment and permission summary, optional delivery controls, Advanced, Cancel and primary action. Keep specialized templates searchable under Advanced; preserve custom recipes and file-only workflows there with their current restrictions.

The objective defaults to the ticket's next action; the owner can edit it. Proposed `instructions` field: plain text, at most 4,000 characters, additional to the existing legacy 280-character `note`. Validate at submit and dispatch, escape in UI, redact in diagnostics, and exclude from external exports by default. Legacy requests retain their current note limit and behavior.

Header × and footer Cancel are always visible; only the body scrolls. Escape closes, restores focus and preserves a nonempty draft in memory until navigation/reload. Backdrop click does not discard a draft. Queue/Run is disabled with an adjacent reason when prerequisites fail. On durable acceptance close the composer and show the new run in context; double-clicks/retries reuse the request ID.

Closing the composer is never run cancellation. A queued run offers Cancel run. A running run offers Stop run, enters a visible Stopping state, and remains there until the worker confirms termination. Preserve logs, partial patch and observed effects; do not imply external effects were rolled back. If the worker is unavailable, say the stop was not confirmed.

### 6.2 Mode matrix

| Product mode (`intent`) | Task contract | Runtime mapping | Default side effects |
| --- | --- | --- | --- |
| `read-only` | Investigate and explain; save findings | Built-in analysis + autonomous guard; source read only when a repo is available | Quill may persist its result; no source edits, commits, publishing or connector writes |
| `plan` | Produce a reviewable implementation plan with steps, dependencies, verification and completion criteria | Dedicated built-in plan template on analysis execution, same guarded read boundary | Save a plan artifact only; no tickets or implementation |
| `auto` | Implement the specified task and verify the result | Built-in attempt-fix + autonomous guard; read/edit source in isolated checkout | Patch and configured test execution; delivery off by default |
| `full` | Execute the task using the existing full-access runtime | Attempt-fix + existing full access | Runtime permission checks are bypassed; display that plainly |

`intent` is additive product metadata, not a replacement for the current execution `mode`, `access`, recipe identity or permission fields. Persist all resolved values on a run for audit. The server resolves a standard intent against pinned built-in templates; a repository recipe with the same name cannot shadow a built-in mode. Reject incompatible intent/recipe/access/permission combinations. Legacy requests without intent keep existing behavior; display their actual mode/access rather than guessing that they were Plan or Read only.

All new intent-based runs use the existing suggestions-only result application path (`legacy: false` set by the server), even when the selected built-in template is historically legacy. In particular, Read only and Plan cannot automatically replace a ticket's next action, blocker, description, priority, status or hierarchy. Persisting run records, artifacts and provenance-qualified memory is permitted internal bookkeeping; changing task fields requires separate owner acceptance. Preserve old no-intent run semantics on replay and dispatch. The implementation must audit `src/handoff/results.js`, not just the launcher/tool permissions, to enforce this distinction.

Guard decisions, credential isolation, protected branches, scoped-action approvals, time/turn/spend limits and worker test gates remain enforced wherever they apply today. A prompt instruction alone is not enforcement. Read only and Plan must reject write scopes and all edit/delivery permissions; inspect shell and MCP paths as well as direct file tools. Local runtime bookkeeping is allowed, source/external writes are not. If an environment cannot enforce that contract, refuse that mode with an actionable reason.

Full access retains its actual existing semantics: the isolated checkout is the starting directory, not a promise of confinement. Unticked delivery controls still constrain worker finalization, but cannot promise that an unrestricted agent will not itself commit/push or affect external systems. Show this distinction inline. Selecting Full access is explicit for each new run; no fallback or retry silently upgrades access.

Auto delivery controls: Commit locally; Push branch (requires commit and explicit non-protected destination); Open draft PR (requires push/provider). External write scopes remain advanced explicit grants and retain existing review/lease requirements. “Auto” does not mean automatic deployment, merging, ticket closure, or execution of every descendant.

Read only/Plan without a repo can inspect ticket data and permitted context; say “Ticket context only”. Auto/Full source execution requires a registered usable repository. A parent spanning repositories requires selecting one task/repository; multi-repository orchestration is deferred. The UI must not claim a whole parent was implemented when only one subtask ran.

### 6.3 Plan lifecycle

A Plan run returns a versioned owner-only artifact attached to the run: objective, ordered steps, proposed files/repositories, assumptions, dependencies/blockers, verification and done-when criteria. Store full text in the existing content-addressed blob store, referenced by `plan_ref`, with `plan_revision` starting at 1 on the run. It is not automatically an approved session checkpoint.

Capture a `plan_context` baseline at plan dispatch: ticket revision (diagnostic), source sequence, selected repo/base commit, and a semantic context fingerprint over the goal/description, current next action/blocker/status, completion policy, parent/required-child identities and states, accepted plan and relevant PR/deployment evidence identities. Exclude incidental timestamps, this run's lifecycle bookkeeping and generated summaries. Store the compared context manifest as a blob so changes can be explained. The semantic fingerprint, not any bump to ticket revision, determines whether the plan context needs fresh review.

Owner edits use a revision-checked `revise-run-plan` request: target the source run, supply expected plan revision and replacement text (maximum 20,000 characters); the worker writes a new blob and records its reference/revision. Preserve prior refs in the journal. No separate plan database is required.

“Run this plan” opens an Auto composer with the exact plan ref/revision and an explicit scope summary. Validate that the source belongs to this ticket, is still the referenced revision and is accessible; if changed, return conflict and reopen review. If its semantic context or selected repository base changed, show the old/current context and commit IDs with “Review and run against current context”; the owner may revise the plan or explicitly reconfirm it. This action is the refreshed approval, not an automatic rewrite of the original baseline.

The handoff submission carries the plan ref/revision and the reviewed context fingerprint/base. At acceptance the server checks the usual current ticket revision, verifies those values against current authoritative state, and journals the owner's execution authorization plus immutable reviewed context/plan refs. No extra persistent approval registry is needed. The normal plan run's own completion must not cause an endless re-review loop.

Dispatch uses the immutable reviewed base commit (and fails clearly if unavailable), then revalidates permissions, scopes and semantic ticket context. A later HEAD movement alone does not retarget the run; show that it runs from the reviewed commit. A semantic ticket change while queued causes `plan-context-changed` before execution and offers fresh review. A later edit of the source plan does not substitute new content into an already accepted run. A successful plan alone does not create/start a fix run. Retry never upgrades permissions and must review changed context again.

No automatic conversion of every plan step to a ticket. “Add selected steps as subtasks” can use the same explicit child-creation flow later; it is not required for the initial Plan mode.

### 6.4 Run results

Show lifecycle and outcome separately: Running, Stopping, Failed/Cancelled; then Changes tested, No changes, Changes not test-verified, or Outcome not verified. “Done” must not stand in for “fixed”. Preserve committed-change detection relative to the recorded base; Git inspection errors fail verification.

A finished run's compact result shows what changed, verification command/outcome, remaining blocker, and one next action. Full logs, attempts, guard decisions, patch and environment remain accessible. Aggregate repeated failures into one actionable attention item; never erase the individual run history.

## 7. One attention queue

Work → Needs attention and Runs → Needs you use the same underlying identities, with different scopes. Include unresolved closure conflicts, required blockers, failed/interrupted runs, missing repo/setup, permission denial, unclassified relationships, unlinked work and pending approvals. Do not create a ticket for each attention item.

Each item has source ID, owning ticket/root when known, kind, first/last observed time, current reason, evidence version and one primary action. Derive it from existing records where possible; no second durable queue unless an acknowledgement cannot be represented by the existing domain request. Deduplicate repeated observations by source identity, not text similarity.

Permissions failures explain what was refused and the missing grant/configuration; retry reuses the task draft but runs preflight again. Do not suggest Full access as the universal fix. Provider failures appear once per provider/scope, with affected tasks accessible, instead of a warning banner on every ticket.

Resolution follows the source state: a retry starting does not resolve a failed result; refreshed successful evidence or explicit owner dismissal does. A summary being read does not acknowledge or resolve a blocker. Surface existing stale/conflicting evidence rather than inventing automatic cleanup.

## 8. Daily update and long-term continuity

### 8.1 Product behavior

Daily update is a workspace feature, removed from the default Run agent picker. Keep `standup` recipe/CLI/schedules working for compatibility under Advanced. The new feature produces a local draft, not a message to another person.

Header: scope, window, timezone, generated time, source freshness/coverage, Generate now. Windows: Today, Last 24 hours, Since last successful update; Yesterday is available for a morning schedule. Scope may be whole workspace or explicit project/repository IDs. Show precise start/end timestamps on demand.

Default output: a short workspace overview followed by parent outcomes that changed or still require attention. For each: goal/current milestone; changes in the selected window; required work remaining; active blockers; next action; scope changes/reopens. Keep unchanged background context collapsed. A Copy/Download preview is available; no Send action is introduced in this delivery.

Long tasks retain a concise durable continuity brief linked to the parent: objective/done-when, accepted decisions, latest verified milestone, required work remaining, current blockers and next action, each with source refs and an as-of watermark. Derive from authoritative task state, accepted plans and provenance-qualified memory; reuse existing brief/context helpers where useful. Do not introduce another independently editable task status.

For a seven-week task, today's update is a delta against that context. Say “week 3 of a planned 7 weeks” only when an explicit plan/date supports it; otherwise state the observed start date or age. No invented deadline, percentage, owner or ETA. Task counts do not imply remaining effort.

### 8.2 Evidence and trust

Build a deterministic evidence bundle before optional narrative generation. Include relevant status/resolution changes, commits, PR observations, deployments, worker test gates, run outcomes, approved plans, checkpoints, blocker changes, accepted owner notes and applicable memory. A failed or no-change run is activity, not delivered progress.

Deduplicate the same commit/PR/test result referenced by several sessions. Group under its parent but cite the original subtask and source. Do not count a parent's recap plus a child's event as two completions. For historical events, preserve the ancestor path at the cutoff using journal-derived relationship history; later reparenting appears as a scope change, not a silent rewrite of old updates.

Every factual generated claim must reference valid evidence IDs in its input bundle. Validation must reject invented IDs and unsupported completion/verification assertions. Template rendering from structured facts is the fallback; citation syntax alone is not proof that prose is supported. Owner statements and agent-reported results are labelled as such; only worker/provider evidence supports corresponding verified claims.

Memory is context, not a new instruction channel. Exclude quarantined entries; surface stale/conflicting entries as uncertain and prefer current authoritative records. A repo-level latest-test memory entry cannot prove tests passed for another ticket or commit. Previous generated updates cannot become independent evidence of work. Manual edits remain owner-authored annotations unless separately verified.

When provider data is stale, capture has gaps, content is missing or a budget limits evidence loading, show coverage and the omitted sources/counts. Say “No recorded progress” instead of “No work happened”. An unknown blocker state is not “No blockers”.

### 8.3 Window and watermark semantics

- Freeze `window_start`, `window_end`, timezone, scope and journal high-water sequence when a generation request is accepted. Use `[start, end)` for timestamps and the captured sequence as the ingestion boundary. Persist the immutable evidence bundle/ref before asynchronous synthesis; reading later mutable state under an old watermark is prohibited.
- Today starts at local midnight and ends at the captured instant, not the next midnight. Yesterday spans the preceding complete local calendar day. Last 24 hours ends at the captured instant and starts exactly 24 hours earlier. Calendar windows handle DST.
- A continuity cursor is keyed by normalized scope plus timezone and stores `through_at`, `source_sequence`, contributing update ID and its evidence manifest. Only scheduled generations and explicit Since last successful update generations can advance it. Manual Today/Yesterday/Last-24-hours reports, historical reports, edits and regenerations never advance it.
- Since last successful update starts at that cursor's `through_at` and ends at the captured instant. If no cursor exists, use the preceding 24 hours and label the bootstrap. Older history is background context, not falsely reported new work.
- A scheduled Today/Yesterday output keeps its named calendar window as its main section. Add a separately labelled “Unreported work since the previous update” carryover section for relevant work between the cursor and the named window that was not already included. Thus an 18:00 Today run does not lose work from 18:00 to midnight before the following day's run. A catch-up after missed days uses the same rule and shows the covered gap.
- The first scheduled update bootstraps at the earlier of the named window start or 24 hours before its captured end. Do not backfill seven weeks of events into that first daily delta; long-term context remains in the continuity brief.
- A scheduled output advances only through its covered end (captured instant for Today, start of the current day for Yesterday), never a future boundary. Advance time monotonically. An older completed job cannot move the cursor backward. For equal cutoff times a higher included source sequence may advance ingestion coverage; never replace it with a lower sequence.
- Newly ingested historical evidence beyond the prior sequence boundary appears under “Newly recorded earlier work”, with its actual time. Deduplicate by immutable source IDs and the cursor's contributed evidence manifests. An event already ingested but dated after the previous time cutoff must still be considered when that time enters a later window. These rules prevent a sequence-only cursor from skipping evening work.
- Only a successfully persisted complete cursor-contributing draft advances the cursor, in the same journal transaction that marks it ready. Failure, cancellation and partial output do not; retry reuses frozen inputs unless the owner explicitly starts a new generation. Input caps must yield partial coverage rather than falsely advancing across omitted evidence.
- Distinct manual reports can intentionally overlap. A regeneration creates a new artifact revision without erasing owner edits or changing continuity coverage. Summaries, their edits and schedule bookkeeping are not evidence of developer progress and cannot feed a self-summary loop.

### 8.4 Scheduling, cost and availability

Reuse Quill's scheduler, not an OS cron job or a separate assistant automation. New installations enable/configure Daily update during setup; existing installations get a one-time in-product opt-in with time/timezone/scope. Never silently enable a newly chargeable model run on upgrade.

Add a `daily-update` job to the existing schedule normalization/dispatch. Configuration is a narrow owner action for this job: enabled, local time/weekdays, scope, Today/Yesterday window, synthesis enabled and explicit limits. Display the inherited store timezone; changing it is a separate workspace setting, not a side effect of configuring this job. Use an expected configuration fingerprint, preserve unrelated TOML entries, serialize with setup/config writers using the existing lock primitive, write atomically, reload the worker's schedule view, and record an audit result. A conflicting config edit must not be overwritten. Do not introduce an arbitrary-config editor as part of this feature.

Proposed defaults: once per local day at 18:00, Today window, local draft only, bounded deterministic summary available without a model. Optional narrative synthesis uses the existing configured runtime, explicit budget and timeout; suggested cap $0.25/2 minutes per update, configurable and enforced as far as the runtime supports, with any enforcement limitation disclosed. No paid fallback without configuration. Missing auth/model/network produces the structured update with a visible explanation, not an empty page or hidden retry loop.

Use one workspace generation at a time; a duplicate normalized request joins the active job. Freeze scope/input before synthesis and never call one agent per ticket. Retrieve relevant source content on demand with explicit limits. Cache unchanged continuity sections by evidence fingerprint. Do not invoke a model for purely unchanged data.

The local worker must be running to generate on time. After sleep/offline periods, catch up once for the latest missed slot, show the missed interval, and use the watermark to include previously unreported evidence. Do not launch a backlog of daily agents. Enforce one scheduled output per local date/scope/settings version, including DST changes. The local date in that identity is the original scheduled slot date; a catch-up labels both the missed slot and actual generation time. If a later scheduled calendar window overlaps previously reported evidence, mark those facts as earlier context rather than new progress. Show next run and last result; schedule failures remain actionable.

### 8.5 Privacy and sharing

Full Daily update content and continuity context are owner-only and absent from the default snapshot/export/mirror/publisher payloads. Existing local-only ticket exclusions remain mandatory for any external file/vault output.

“Copy for sharing” and Download open a sanitized preview built from eligible source facts before synthesis/rendering; merely removing citations from private prose is insufficient. Omit private ticket names, local paths, private URLs, memory and hidden-child counts. A private owner copy may be explicitly requested with a clear label. Never automatically upload or post.

Daily update artifacts use existing content-addressed storage and access checks. Untrusted source text is escaped and treated as data. No summary markdown may execute actions, configure schedules or change permissions.

## 9. Proposed data and API contracts

Reuse the event journal, single writer, content-addressed blobs and existing request lifecycle. These additions must be documented in `DATA-CONTRACT.md` during implementation; this design does not claim they already exist.

### 9.1 Derived Work projection

Add owner Work summaries to the current generation projection (or a generation-bound companion endpoint if measured payload size requires it). Per ticket:

| Field | Meaning |
| --- | --- |
| `parent_id`, existing children IDs | Existing hierarchy; no duplicate relationship source of truth |
| `work_rollup.required_total/completed/remaining` | Direct-child counts as defined in §5.2 |
| `work_rollup.resolved_without_delivery/independent/unclassified` | Explicit non-completion buckets |
| `work_rollup.pending_descendants` | Distinct pending required descendants across required paths; labelled separately |
| `work_rollup.closure_state` | `not-ready`, `ready`, `needs-review`, `closed`; derived, not editable |
| `work_rollup.reasons` | Stable code, display reason, source ticket/run/evidence refs; full list in detail |
| `work_rollup.evidence_version` | Current closure assessment version for safe review actions |
| `work_rollup.active_run_count/attention_count` | Distinct source counts; do not sum duplicated parent/child display entries |

All fields belong to a single `generation_id`; no combining counts from one generation with tickets from another. Missing counts in an older export mean unavailable, not zero. Worker complete state is required for closure, irrespective of how many rows the client loaded.

### 9.2 Mutation requests

All new mutations travel through authenticated `POST /v1/requests`, existing CSRF and idempotency checks, validation at submission and application, and journaled outcomes.

| Proposed request | Target / payload | Concurrency and behavior |
| --- | --- | --- |
| `set-priority` | Ticket, priority P0–P3 | Expected ticket revision; existing delayed-edit undo |
| `create-subtask` | Parent, complete ticket description, required/independent choice | Expected parent revision; deterministic new ID from request identity; validation before creation |
| `set-parent` | Child, new parent or null, relationship classification, old/new parent revisions | Validate cycle and all revisions; atomic edge/index update; delayed-edit undo |
| Existing `set-status`, `set-next-action`, `set-completion` | Existing payloads | Preserve semantics, including reasons and completion/deployment choices |
| Existing `handoff` | Add optional `intent`, `instructions`, source plan ref/revision, reviewed context fingerprint/base | Existing expected revision; server resolves/validates effective execution tuple and immutable execution context |
| `revise-run-plan` | Source run, expected plan revision, replacement text | Owner-only, blob write then journal reference; no execution |
| `generate-update` | Window choice or explicit bounds, scope, generation style | Extension-owned asynchronous request; idempotent frozen inputs; no ticket target/revision |
| `edit-update` | Update ID, expected artifact revision, replacement text | Preserve generated original and source refs; text marked owner-edited |
| `set-update-schedule` | Owner schedule settings from §8.4, expected configuration fingerprint | Extension-owned config mutation; atomic update, preserve other schedules, then reload |

Implementation may use existing request names/helpers where equivalent; it must not expose a generic arbitrary-field patch that bypasses domain validation. New kinds must be wired into all request dispatch/allowlist/apply/cancel paths, reducers, capability reporting, error labels, CLI/API docs and tests. Browser-only validation is insufficient.

Add owner-only generation-bound reads: `GET /v1/updates` (paged metadata), `GET /v1/updates/:id` (selected revision and content references). Validate IDs and ownership; return stable missing/expired-generation responses consistent with current APIs. Full content uses the existing authorized content reader with explicit update/plan reference reachability added; never grant access to arbitrary blob hashes. Static clients do not call these endpoints.

### 9.3 Daily update artifact

Proposed durable metadata: `id`, `revision`, `state` (`queued`, `running`, `ready`, `partial`, `failed`, `cancelled`), `scope`, `window_kind`, `window_start/end`, `timezone`, `source_sequence`, `input_fingerprint`, `evidence_refs`, `coverage`, `generated_at`, `content_ref`, `owner_edit_ref`, `supersedes_revision`, and optional runtime/model/cost/error metadata. Event IDs and provider observations remain the evidence source of truth.

Also record trigger/slot identity, immutable `input_ref`, named-window and carryover bounds, and whether the output contributes to the continuity cursor. Journal creation and state transitions as update-domain events through the same worker; include update metadata and cursor state in reducer replay/checkpoints. Creation is idempotent on request ID or scheduled slot identity. At restart, adopt a completed artifact already journaled; interrupted nonterminal synthesis becomes interrupted/failed with a retry action and no cursor advance. Scheduled retries reuse the slot and frozen input with an attempt record, not another output identity. The deterministic fallback can complete the same attempt if narrative generation fails. User cancellation cancels the active child process where applicable and is recorded before another attempt may start.

Store continuity briefs as rebuildable projections keyed by root/evidence fingerprint, not as new authoritative ticket fields. Persist owner annotations through existing owner-note mechanisms. Adding a journal-derived field or changing reduction semantics requires a reducer-version bump and replay/hydration coverage. Indexes must rebuild from journal/blob references after cache loss; missing blobs report partial coverage.

## 10. Backend integrity and performance

- Construct a parent index once per generation; derive rollups bottom-up in O(tickets + edges + relevant evidence), not recursively scanning all tickets for every row. Memoize closure context within a generation.
- Maintain one canonical calculation for completion semantics used by Work, attention, summaries and reconciliation. A UI-only “looks done” rule is prohibited.
- Preserve lifecycle protections introduced in `403eda6`: opening UI cannot rebind sessions; done-ticket auto-binding is rejected; committed changes count; Git failures are errors; no-change fixes are not successes.
- Hierarchy edits and imported invalid data must not create cycles, leak private descendants or lose orphan tickets. Bound traversal with visited IDs; report defects without destructive repair.
- Run generation and evidence retrieval off hook-critical paths. No journal replay or model call on a keystroke, filter change or hook invocation.
- Render only expanded/paged rows. Start with 50 roots per page and 50 children per expansion page; counts still cover all authorized records. Do not introduce virtualization until measurement warrants it and keyboard navigation remains correct.
- Benchmark with the existing 2,000-ticket/20,000-event fixture plus a 1,000-child parent and a 50-level chain. Target warm filter/expand feedback under 100 ms p95 and no single main-thread task over 100 ms on the documented test machine. Report hardware/browser and separate rendering from network/generation costs. Investigate regressions over 10% against the same baseline; never present a target as a measured result.
- Generation jobs have bounded concurrency, evidence/token/time budgets and progress/cancellation. No one-agent-per-child fan-out. Results become visible only after durable artifact references are committed.

## 11. Data quality and recovery

Reject known tool-envelope/temporary-path artifacts as automatically inferred ticket titles at ingestion boundaries. Preserve raw provenance privately; use a neutral “Untitled task · KEY” fallback and a review action when no trustworthy title exists. Do not silently rewrite a legitimate user-supplied technical title or old ticket. Existing malformed titles are an owner-reviewed repair.

Missing repo/setup becomes a specific action (Select repository, Repair path, Check setup). Stale registrations are removed only in the relevant owner's store through existing commands; never infer another user's configuration from a screenshot.

No network/worker: retain last good data with timestamp, disable mutations and generation, preserve drafts. Conflicts display current and proposed values. Failed summaries keep prior successful updates visible; failed runs retain evidence. Loading uses the final layout without jumping rows. Zero matches offers Clear filters; a new workspace offers the actual first setup/create action.

## 12. Compatibility and migration

- Preserve ticket IDs, parent links, statuses, priority, journal, memory, run history and existing scopes/permission settings. No bulk historical reclassification or automatic linking.
- Legacy `blocks_parent: null` remains unknown until reviewed; no inferred required relationship. Historical empty changed-file lists remain unknown outcomes.
- Route aliases: `view=board` and `view=tree` open Work; tree `root` opens/focuses that subtree; `view=picknext` opens Suggested next; existing ticket/run deep links and safe filters survive. Update shortcuts/help; retain old numeric shortcuts as aliases where possible.
- Existing recipes, `standup`, schedules and CLI modes keep working. New UI intents are additive. Full access never becomes a saved default through migration.
- Keep the existing `digest` schedule behavior intact. Add the workspace Daily update job separately; no silent replacement of an existing vault writer or its edited sections.
- Static export remains read-only and offline. Unified Work can render shared hierarchy from sanitized data; omit private rollups/closure decisions and display unavailable evidence honestly. Old exports remain viewable.
- Update `UI-DESIGN.md`, `DATA-CONTRACT.md`, affected ADRs/TRD sections, commands/help, fixture manifests and acceptance docs alongside each implemented slice. A later approved spec supersedes only the sections it explicitly changes.
- Prefer staged backward-compatible releases. If a new reducer/data schema prevents binary downgrade, document the minimum compatible version and recovery procedure; reverting a UI route must not discard new journal events or artifacts.

## 13. Acceptance scenarios

| ID | Scenario and required result |
| --- | --- |
| W01 | A parent has 4 completed required, 1 blocked required, 1 todo required and 2 optional children: show 4/6, 2 remaining and optional count separately |
| W02 | All required children are done but deployment is pending: parent is not presented as delivered; show exact outstanding obligation |
| W03 | A required child resolved as duplicate: do not increase delivered count; show review reason |
| W04 | A required grandchild reopens beneath a done child: review conflict reaches required ancestors, conflicted child moves from completed count to remaining, and workflow status is not silently rewritten |
| W05 | Searching for a grandchild reveals its complete ancestor path; unrelated siblings stay hidden until explicitly revealed |
| W06 | Filter or child paging changes visible rows but never full authorized completion counts; private export counts disclose no hidden children |
| W07 | Reparent to a descendant is rejected; stale child/parent revision conflicts leave all links unchanged |
| W08 | A parent spanning repos remains visible as context for a matching child; a run still selects one execution repo |
| W09 | Polling during inline editing preserves draft/focus/scroll; successful updates are acknowledged before displayed as saved |
| W10 | Selecting a parent does not bulk-change its descendants; partial batch conflicts remain actionable |
| W11 | Deep/cyclic/orphan imported data remains navigable without infinite traversal, duplicate rows or render-time mutations |
| A01 | At 1366×768 and 390 px, × and Cancel remain visible through long content; Escape restores focus |
| A02 | Closing a composer does not stop an existing run; Stop waits for worker confirmation and preserves partial results |
| A03 | Read only/Plan attempt direct, shell and connector writes: enforced denial, no hidden fallback to broader access |
| A04 | Auto defaults to patch/test only; commit/push/PR require explicit validated delivery choices |
| A05 | Full access explains actual bypass semantics and is not restored as a default on next run/retry |
| A06 | Editing a plan after a composer opened causes a source-plan conflict; no execution of unseen replacement content |
| A07 | A custom template shadows a built-in name: standard mode still resolves the pinned built-in |
| A08 | No-change, committed clean diff and Git inspection failure retain correct outcome/test-gate labels |
| A09 | Missing repo or incompatible file-only workflow gives a specific remedy without losing the task draft |
| A10 | New Read only/Plan output proposes a blocker/description/next action: it cannot edit task fields automatically; legacy no-intent runs retain documented behavior |
| D01 | Seven weeks of linked work produce one continuing parent narrative and only the selected period's changes, each evidenced |
| D02 | A commit appears in three sessions and a PR: it is not reported as three delivered changes |
| D03 | Today/Yesterday around DST and Last 24 hours have correct distinct boundaries and shown timezone |
| D04 | Since-last update fails: watermark does not advance; retry uses frozen inputs; later late evidence is explicitly labelled |
| D05 | Worker wakes after three missed days: one catch-up output, no three-agent backlog and no unlabelled lost interval |
| D06 | No model credentials or synthesis failure: structured facts remain available and clearly identified |
| D07 | Stale/conflicting/quarantined memory cannot fabricate delivery, override current facts or introduce instructions |
| D08 | Private owner update includes local context; sharing preview regenerates from eligible facts and leaks no private names/counts |
| D09 | Generation is triggered twice/restarted: one durable request identity, recoverable outcome and no duplicate watermark advancement |
| D10 | Owner edits an update, then regenerates: the owner revision remains available and is never silently overwritten |
| D11 | New task/child suggestions in model output do not create tickets or expand work scope |
| D12 | Generate at 18:00, work at 21:00, generate next day, then request a historical report: evening work appears once in carryover and the historical report cannot move the continuity cursor |
| C01 | Existing board/tree links, CLI recipes, schedules and static exports continue to work through migration |
| C02 | New fields/reducer semantics survive journal replay and checkpoint hydration; missing blobs are explicit partial coverage |

## 14. Verification plan

Write focused regressions for hierarchy arithmetic/filtering, nested closure propagation, revision-safe mutations, mode-to-permission resolution, plan revision binding, evidence dedupe/windows/watermarks, privacy and restart recovery. Test invalid/untrusted payloads at worker and API boundaries, not only forms.

Browser checks must cover the real composed pages with long titles/notes, many children/templates, keyboard focus, offline/conflict states, both themes, narrow/short viewports, restore after polling and sticky dialog actions. Capture before/after screenshots against the supplied feedback's density problem. Validate layout targets and contrast; no screenshot-only claim that mutations work.

Reuse the existing CLI/server/reducer/handoff/export test suites, fixtures and browser harness. Add model-independent deterministic Daily update tests; use a fake synthesizer for citation/claim rejection and failure paths. A bounded real runtime smoke test may verify mode enforcement when credentials are available, but cannot substitute for guard tests or become a mandatory paid test on every CI run.

Run the full suite and browser checks before integration. Report exact pass/fail/skip counts and any unavailable cross-platform/runtime checks. Do not call a change verified solely because an agent run exited successfully.

## 15. Delivery sequence and release gates

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 1 — Work foundations | Authoritative rollups, nested conflict propagation, unified Work read view, ancestry-aware filters, compact detail, route aliases | W01–W06/W08/W09/W11, privacy and performance baseline; no loss of existing actions |
| 2 — Manage and execute | Inline/bulk edits, relationship mutations, four-mode composer, plan review/execution, visible Cancel/Stop, truthful run results | W07/W10, A01–A10; permission and revision regressions |
| 3 — Continuity | Structured evidence bundle, owner Daily update, history/window controls, long-term brief, on-demand generation | D01–D04/D06–D12; deterministic fallback and privacy |
| 4 — Automation and polish | Scheduler setup/catch-up, unified attention presentation, title-quality remedies, accessibility/performance polish | D05, C01–C02; end-to-end screenshots and full regression suite |

Daily update can ship in structured form before optional narrative synthesis. Do not delay visible cancel/close fixes behind the full redesign. Do not ship labels for unimplemented permission modes or counts derived only from loaded children. Each phase includes its docs and migration behavior; backend schema changes precede UI dependence on them.

Success is behavioral: users can identify what blocks a parent without opening every child, prioritize/filter without losing relationships, start or stop a run without scrolling for controls, and obtain a sourced daily update that retains long-task context. No new analytics collection is required; assess with scripted tasks and local benchmark fixtures first.

## 16. Illustrative wireframes

These examples are synthetic, not observed user work or measured progress.

```text
Work                           [Search] [Repo] [Status] [Priority] [Sort]
Open  |  Suggested next  |  Needs attention  |  Completed  |  All

▾ Platform migration           P1  Active       4 of 6 required complete
  Waiting for staging access · Next: confirm credentials
  ▾ Staging verification       P1  Blocked      [Investigate]
      Validate access          P1  To do
      Run smoke checks         P2  To do
    Production rollout         P1  To do
  ▸ Completed required (4)
  ▸ Independent follow-ups (2)

▸ Retry reliability            P2  Review       Ready to close [Review]
```

```text
Run agent · TASK-123                                             [×]
What should the agent accomplish?
[ Verify and fix the staging configuration ...                      ]

( ) Read only  ( ) Plan  (•) Auto  ( ) Full access
Isolated checkout · edits + tests · no publishing
Delivery: [ ] Commit locally   [ ] Push branch   [ ] Draft PR
▸ Advanced: template, limits, environment, write scopes

                                                   [Cancel] [Run]
```

```text
Daily update   [Workspace] [Last 24 hours] [Timezone] [Generate now]
Generated ... · Complete local capture · PR evidence updated ...

Platform migration — continuing objective
Changed: staging configuration merged [PR evidence]
Remaining: verify staging; production rollout
Blocked: waiting for credentials [source · first recorded ...]
Next: confirm access
▸ Earlier milestones and decisions

[Copy for sharing…]  [Download preview…]
```

## 17. Traceability

| Feedback / requirement | Sections | Acceptance |
| --- | --- | --- |
| Too much information; poor prioritization/filtering | 4, 5.3–5.5 | W05/W06/W09/W10 |
| Merge Board and Relationships; parent completion/subtasks | 5.1–5.2, 9.1 | W01–W08/W11 |
| No visible cancel/×; too many recipes | 6.1, 12 | A01/A02/A07/C01 |
| Read only / Plan / Auto / Full access | 6.2–6.4 | A03–A10 |
| Daily/on-demand standup; long-task continuity | 8, 9.3 | D01–D12 |
| Reliable reconciliation; no uncontrolled task growth | 5.2, 7, 8.2, 10 | W02–W04/D11 |
| Existing session/run integrity and compatibility | 10–12 | A08/C01/C02 |

## 18. Builder discretion and approval boundary

Builder decisions: exact component/file boundaries; whether measured projection size warrants a companion Work endpoint; small spacing/token adjustments within §4; evidence-index storage format using existing persistence primitives; and internal batching needed to meet latency targets. Document any deviation from the default page sizes or performance targets with measurements.

Not builder discretion: widening mode permissions, silently enabling paid schedules, auto-posting summaries, converting suggestions into tasks, redefining required completion, weakening provenance/privacy, or deleting historical recipes/data. Changes to those require revising the design.

This document completes the requested specification. Product implementation, schema migration, schedule activation and a release are separate work. Before implementing, resolve or accept the proposed defaults in §1.2 and turn the approved design into an implementation plan with file-level tasks and tests.
