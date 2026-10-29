# Quill developer control centre

Date: 2026-10-30 · Status: proposed design, awaiting owner review

## Intent and product direction

Help an individual developer finish software work with less context reconstruction and fewer disconnected tools. A task should connect its issue, repository, sessions, plan, agent runs, verification and delivery evidence. Quill should make the next useful action clear and preserve what happened when the developer switches tasks.

The user asked to explore SWE productivity, agent efficiency, session and issue tracking, Jira and local setups, then said to proceed after the recommendation of a personal developer control centre. This document adopts that recommendation. Details below are design choices proposed by the builder, not preferences explicitly stated by the user.

The first release makes one task flow coherent: **select a linked issue → prepare its workspace → investigate or implement → inspect verification → review the result → preview a tracker update**. Multiple registered repositories are supported; a task continues to have one primary repository. Team coordination and cross-repository execution follow later.

## Approaches considered

| Approach | Benefit | Cost / decision |
| --- | --- | --- |
| Extend the local Quill dashboard and worker | Reuses session capture, tickets, isolated runs, evidence and permission handling | Recommended direction adopted after “go ahead”; local machine must be available for execution |
| Build a shared team control centre now | Shared queues, assignment and remote execution | Requires identity, shared state, tenancy and remote credentials before improving the daily task flow; deferred |
| Replace the runner with a general agent framework | Many providers and arbitrary workflow graphs | Duplicates working persistence and execution controls; introduces migration risk without establishing user value; deferred |

This is a project delivered in small increments, not a dashboard reskin or an engine rewrite.

## Goals and limits

Goals:

- Bring task context, sessions, execution and evidence together without duplicating their records.
- Make recovery from interrupted work, missing setup, failed tests and unavailable providers understandable.
- Reduce unnecessary model calls, repeated context gathering and unbounded repair attempts.
- Separate observed evidence, agent claims, user decisions and remote tracker status.
- Preserve the local-first model and the existing Fieldnotes design system.

First-release non-goals:

- A hosted service, team accounts, arbitrary workflow canvas, background swarm or new agent runtime.
- Automatic production deployment, merge, approval or tracker publication based on model confidence.
- A universal environment installer or process supervisor; setup automation comes after readiness is useful.
- Importing every assigned issue across many accounts. Begin with existing linked/imported issues and current tracker onboarding.
- Jev integration or benchmarking, deferred by the owner on 2026-10-30. No LangChain or LangSmith dependency.

Anti-goals: invented completion percentages, “verified” based on an agent's assertion, another copy of a ticket database, destructive workspace cleanup, automatic transmission of session transcripts to a classifier, or more notification noise.

## Existing foundation

These are present in the repository, not new promises:

| Capability | Current foundation | Gap addressed here |
| --- | --- | --- |
| Task identity and capture | Tickets, external links, descriptions, sessions, checkpoints, resume briefs | Context is spread across views and CLI workflows |
| Tracker integration | Jira/GitHub/Linear sync and onboarding; opt-in CLI write-back | No dashboard preview/confirm for writes; sync is not a general issue inbox |
| Execution | Recipes, `claude -p`, per-run model option, budgets, queue, cancellation, test gate and bounded repair | Explain the available next step and connect its outcome to the task |
| Workspace isolation | Interactive ticket worktrees and separate worker run worktrees | Dashboard does not manage ticket worktrees or inspect readiness |
| Evidence | Worker test facts, tested/committed trees, receipts, CI observations | Receipts require CLI; “ready to review” cannot be explicitly acknowledged |
| Context efficiency | Bounded context cards, anchored memory, failure history, overlap information | No measured routing recommendation or unified context overview |

Keep the single-writer journal/reducer/projection architecture. UI mutations use authenticated, CSRF-protected, validated requests. Hooks remain fast local capture paths; never place network classification or setup checks in hooks.

## Milestone 1A: task workspace and review

This is the first implementation increment. It is useful without Jev, a new tracker account, or setup automation.

### One task, one workspace

Use the existing ticket as the canonical task. Extend its existing detail/expanded-detail experience instead of introducing a second task entity or a parallel navigation hierarchy. Preserve existing links, tabs, keyboard navigation and the ability to return to the previous list/filter.

The overview assembles the following existing facts:

- Goal, Context, Done when, blocker and next action.
- Primary repository and linked external issue, with local status and remote status separately labelled and remote fetch time visible.
- Latest checkpoint, approved plan, bound sessions and links to full session history.
- Latest relevant run, queue/blocking reason, permission summary, worker verification and PR/CI state.
- Recorded interactive worktree paths and branches, explicitly labelled as recorded state until a live check exists in 1B.

Resume uses the existing bounded brief builder through an owner-only read API: copy a brief and show the relevant session/workspace. It does not fabricate the ability to reconnect to any arbitrary terminal or provider session. Brief content retains existing sanitization and local-only boundaries.

Keep current Runs, Activity and Delivery tabs as detailed views. A developer can use the existing Run agent dialog from this workspace; recipe, permissions, model and budget behavior are unchanged in 1A. Reuse existing approved-plan/checkpoint handling instead of creating a second planning record.

### Next action, derived from facts

The recommendation is deterministic in 1A and does not mutate ticket status. Pick the first applicable action:

1. Resolve an outstanding approval, uncertain effect, or recorded test/CI failure.
2. Inspect/cancel a queued or running run, explaining its queue reason.
3. Resolve a missing primary repository when the chosen recipe requires one.
4. Review the latest eligible completed change.
5. Resume captured work, or choose a recipe when no continuation is recorded.

Other applicable actions remain available. Recommendations link to existing evidence or controls and explain their reason. A done task has navigation/history actions; it is not silently reopened. Repository-less tasks remain usable with the existing recipes and completion rules.

Do not show a mandatory linear progress bar: investigation may precede setup, a fix may require another investigation, and an issue may need no code. If milestones are displayed, use facts such as “PR opened” or “Tests not run”, never a guessed percentage.

### Evidence in the dashboard

Expose the same receipt reconstruction used by `quill receipt` as an owner-only read endpoint, sharing the receipt/replay helper rather than spawning a CLI process. A recorded receipt must be rebuilt through its recorded journal sequence and compared with its recorded digest. Distinguish matching, mismatched, unavailable and unrecorded receipts. Unrecorded receipts are a current summary of journaled facts, not evidence previously attached to a PR.

Show worker tests, tested tree, commit/tree association and latest CI observation separately. An agent's self-check or critic opinion never becomes a worker test result. Passing tests do not prove every Done when item. Preserve unknown/missing evidence and manual verification needs.

### Mark reviewed

Add an owner action on a terminal source-editing run with changed files, independent of the seven-day attention window. It records **reviewed locally**, not GitHub approval, merge, deployment or task completion. Reopening local review is supported.

Use the existing request lifecycle with a new review operation and an expected review fingerprint. The server computes the fingerprint; the client returns it with the action. It covers the run id, result reference, changed files, commit/tree, worker test evidence, uncertain effects and latest known PR head. Do not include polling times or a CI pass/fail transition on the same head; CI failures have their own attention path. Missing values are explicit and canonicalized. A stale fingerprint rejects the request and asks the UI to refresh. On replay, the same operation is idempotent.

Persist the acknowledgement on the run through the journal/reducer, with worker time and fingerprint. Only the matching acknowledgement suppresses that run's ready-to-review item. A new run has no acknowledgement; changed result evidence or PR head invalidates the old one. Unknown remote head means “reviewed recorded result; remote head unknown”, not assurance about the current remote branch. Review acknowledgement must never suppress failures, scope drift, critical approvals, proposals, suggestions or uncertain effects. Those remain until their existing resolution actions apply.

The owner can mark an unverified result reviewed after seeing its missing evidence; the label continues to say unverified. The run itself remains in history. Review data is owner-only, excluded from exports, published pages, mirrors and vault notes.

## Milestone 1B: prepare and finish from the workspace

Complete this after 1A. It finishes the initial issue-to-review workflow without requiring users to coordinate the CLI and dashboard.

### Workspace preparation

Add explicit live inspection and create/reuse/remove actions for **interactive ticket worktrees**, reusing ADR 0036 helpers. The worker keeps its separate disposable run checkouts; a task worktree is never silently substituted for a run checkout, and its uncommitted edits are never silently copied into an agent run. Make this distinction visible when a run's base differs from interactive work.

Mount/remove through worker-owned queued requests. Resolve the registered repository from the ticket; never trust a browser-supplied filesystem path. Serialize conflicting operations for a ticket/repository, and recheck repository binding, branch and worktree identity immediately before touching disk. Reuse valid worktrees, refuse foreign folders, keep branches and preserve all existing dirty/ignored-file/session protections. On restart, inspect actual git registration and the request's mount identity before reconciling a partially completed operation; never repeat destructive work blindly.

Readiness is an explicit bounded read-only check with a capture time and target path/HEAD. Start with repository availability, git/worktree identity and dirty state, Quill worker status, runner executable availability, and configured test command presence. Check executable presence without executing repository scripts. These checks say whether prerequisites are known, missing or unknown; they do not certify the application can run. Do not probe arbitrary URLs or print environment values.

Show setup instructions and candidate commands from repository documentation/configuration as untrusted suggestions. Dependency installation, containers, migrations and dev-server launch stay in the terminal or an explicitly selected existing recipe with its normal permissions. Absence of a variable in the worker's environment is “not available to this worker”, not proof the user removed it. No new environment manifest in this release.

### Tracker preview and confirmation

Reuse the current user-configured provider, status mapping, redaction and opt-in `write_back` rule. The new dashboard path requires an ADR amendment to 0018, which currently restricts writes to CLI. It does not enable background sync writes, recipe writes or hook writes.

Preview the exact issue, observed remote status, target status and optional sanitized comment. Generate suggested text from recorded facts, allow editing, and omit local paths, secrets, private memory and local-only tickets. Preview and confirm are separate operations. A confirmation binds to issue identity, ticket revision, exact redacted payload and observed remote state; expire it after five minutes. Re-read remote state immediately before execution and reject a changed issue/status or invalid transition. Remote services may not support atomic compare-and-swap; disclose a detected race instead of claiming transactional guarantees.

Journal the confirmed request before dispatch and record per-effect outcomes. Status success with comment failure is partial success, not a total failure that can safely replay both. An ambiguous timeout or restart during a write enters “outcome unknown”; reconcile remote state and require a fresh explicit decision for any ambiguous comment resend. Do not automatically retry possibly accepted comments. Deduplicate local request ids and record provider ids when available; do not claim exactly-once remote delivery.

Completing review offers this preview; it does not send it. Review does not automatically choose Done: retain existing local lifecycle/status mappings and show the target explicitly. All supported tracker adapters retain their capabilities; unavailable transitions or credentials produce actionable failures, not fallback writes to another tracker.

## Milestone 2: measured agent efficiency

First make existing execution observable: per-recipe/model completed runs, first test-gate pass rate, repair attempts, failure signatures, owner interventions where actually recorded, queue time, wall time and measured/estimated/unknown spend. Do not turn missing usage into zero or use an opaque autonomy score. Use comparable task groups when evaluating savings.

Improve the existing bounded context and failure ledger before adding agents. Reuse valid memory, avoid repeating failed commands without new evidence, expose stale context, and keep test/repair/critic calls within existing run budgets. Preserve one active run per ticket and serialized source-writing runs per repository. Existing read-only concurrency can be used; file-disjoint writable parallelism is a separate future design because merges and shared tests can still conflict.

### Routing scope and deferred Jev exploration

On 2026-10-30 the owner asked to drop Jev for now. Its integration and benchmark are removed from the planned work. No TypeSafe account, credential or paid API is required for this roadmap.

Keep Node ESM, the existing Claude runner and explicit recipe/model selection. Improve deterministic next-action suggestions, bounded context reuse, budget visibility and failure recovery first. Measure improvements on comparable tasks using actual test outcomes, elapsed time and available usage; do not infer task success from a routing label. Quill cannot assume access to every internal `claude -p` model-call boundary, so per-turn cross-provider routing remains outside this design.

The previously supplied [LangChain harness article](https://www.langchain.com/blog/building-a-harness-with-jev) remains research background only. Any future classifier experiment needs a new explicit request and a separate evaluation. Existing deterministic guards, approval pins and verification requirements remain authoritative.

## Later opportunities, ordered by dependency

| Area | Useful capability | Prerequisite / scope boundary |
| --- | --- | --- |
| Intake | Assigned issues, saved queries, duplicate suggestions, stale-task reminders | Provider pagination, stable identities and explicit sync scope; retain manual choice |
| Local setup | Reusable setup recipes, service health, logs, ports and cleanup | Trusted command definitions and process ownership; never kill unrelated processes |
| Session continuity | Better handoff briefs, decisions, blockers and next experiments | Preserve provenance and stale-anchor handling; no full-transcript prompt by default |
| Verification | Acceptance-item evidence links, UI/browser artifacts and regression recipes | Worker-observed evidence remains distinct from assertions and manual checks |
| Review/delivery | PR feedback, conflict repair, CI diagnosis, release obligations | Exact head/revision checks and bounded repair; preserve merge/deploy authority |
| Knowledge | Proven fixes, repository conventions and onboarding context | Scope, source, expiry and contradiction handling before reuse |
| Multi-repo/team work | Dependency-aware task groups, shared visibility, remote workers | Separate identity/authorization/storage/execution design; no implied multi-user support |

## Implementation boundaries and compatibility

| Surface | Reuse / intended change | Required accompanying checks |
| --- | --- | --- |
| `ui/views/detail.js`, run detail and `ui/lib/runs.js` | Workspace composition, evidence, review action and attention selector | Existing links/tabs; keyboard/focus; stale/offline/read-only states; counts |
| `ui/lib/api.js`, static API and UI action dispatch | Owner reads and revision/fingerprint-aware review submission | Static mode makes no new network calls or mutation attempts |
| `src/server/http.js`, `src/server/requests.js` | Authenticated read endpoints and validated owner requests | Auth/CSRF, bounded inputs, stale data, duplicate requests and capability checks |
| Core request validation/reducer and projections | Minimal journaled review acknowledgement | Replay, absent legacy fields, no ticket revision side effects, schema fixtures |
| `src/cli/commands/receipt.js`, `src/handoff/receipt.js`, replay helper | Shared read-only receipt reconstruction | CLI digest semantics unchanged; historical sequence and mismatch cases |
| Brief builder, owner ticket projection | Bounded resume context with provenance | Existing sanitization and private/local-only exclusions |
| Worktree CLI/helpers and worker extension (1B) | Share safe operations without shelling out to CLI | Dirty/ignored files, branch/path validation, concurrency and interrupted requests |
| Tracker CLI/adapters and worker extension (1B) | Share preview/write logic, exact confirmation and outcomes | Provider fixtures, stale remote state, redaction, partial and ambiguous failures |
| Export, mirror, publisher, vault and static UI | Exclude new private operational data | Privacy sentinel fixtures and existing read-only export contracts |
| `docs/DATA-CONTRACT.md`, ADRs and Fieldnotes guidance | Document actual shipped requests, fields and behavior | Update when implemented; this proposed design does not override current contracts |

No new runtime dependency is required for 1A/1B. No bulk journal rewrite. Old stores/runs with no review field remain unreviewed; optional projection fields get safe defaults. The builder must explicitly version new event/request contracts and update supported-version tests as needed. Old binaries may not understand new operations; do not promise downgrade support after a new writer journals them.

Receipt replay and git inspection must not block routine snapshot serving. Use bounded work outside the reducer and cache only results keyed to immutable journal sequence or explicit check identity. A normal UI refresh reads recorded projections; it never launches git, a setup script, a model call or remote writes.

## Validation and release acceptance

1A is complete when a developer can open an existing issue, see its latest context, copy a bounded resume brief, dispatch through the existing dialog, inspect worker evidence/receipt, and acknowledge/reopen local review without losing failures or suggestions. Reload and worker restart preserve the acknowledgement. A changed fingerprint reopens review. Legacy tasks, repo-less tasks and read-only exports still work.

1B is complete when the same task can create/reuse a safe ticket worktree, refresh limited readiness and preview/confirm a tracker update. Missing repo, runner or credentials has a specific next step. Dirty or foreign worktrees are never removed. Partial writes and unknown remote outcomes remain visible and never trigger automatic duplicate comments.

Required focused tests: reducer replay and stale-review conflicts; attention/count regression; authenticated receipt/brief endpoints; receipt digest equivalence; UI loading/error/keyboard/mobile states; static export and privacy sentinels. Add worktree concurrency/crash and tracker partial-write fixtures with 1B. Run documented UI/browser checks using an isolated store. External-service writes require separate opt-in integration checks; do not infer them from mocks.

Use a manual seeded scenario covering success and one failure path per increment. Measure the number of context-switching steps before/after on the same task; retain correctness and evidence quality as release requirements even if fewer clicks are achieved.

## Decisions left to the builder

Choose exact helper names, endpoint spelling, reducer operation naming, file boundaries, cache size and responsive layout within the current Fieldnotes components. Prefer the existing expanded ticket experience; introduce no new top-level destination unless implementation shows a concrete navigation need. Select the smallest tests that exercise failure boundaries rather than mirroring rendering code. Any change to runtime providers, automatic permissions, publication policy, global concurrency or shared hosting needs a separate design.

## Review status

Prepared from the current repository and official Jev/LangChain sources. An independent builder check on 2026-10-30 found no important unanswered planning questions, including after checking current run eligibility and attention handling. Owner design approval remains pending before the implementation plan.

No product implementation, dependencies, external writes or live Jev benchmark are included in this design change. The builder check did not execute tests or validate live external APIs. After the owner deferred Jev, temporary benchmark scaffolding was removed. One tool-disabled Claude connectivity probe completed before cancellation; it was not a routing benchmark and establishes no performance comparison.
