# Agent handover: Quill UI and orchestration-first 1.0

Prepared 11 October 2026 (Asia/Calcutta).

## Start here

The user requested a UI/UX audit, approved the recommended update, then asked to push it and re-analyse remaining gaps and user friction against the orchestration-engine scope. The latest request is to prepare this handover document.

The UI update is implemented and pushed. The follow-up audit identified confirmed defects and product gaps; those follow-up changes are **not implemented**, except for the Pick next checkpoint-association fix described below.

The user wrote “orchestration engine v.10.” This handover interprets that as **Orchestration-first 1.0**, because that is the documented scope, package version and branch. No separate v10 specification was found. Do not silently invent a v10 architecture.

Primary conclusion: the dashboard now helps users choose and inspect tickets more quickly, but operating agent runs still requires moving between ticket details, batch strips and Activity. The next work should complete the dispatch → monitor → inspect evidence → decide → recover workflow.

## Repository and delivery state

- Workspace: `C:\Users\shiva\Downloads\session-tracker-docs\session-quill-1.0`
- Branch: `feat/orchestration-1.0`
- Remote: `origin`, `git@github.com:nulllvoid/session-quill.git`
- Pushed commit: `144c056ea87bffa116876c34fc8ce340110875d4`
- Commit subject: `feat(ui): prioritize work and simplify ticket navigation`
- Local HEAD and upstream were verified equal before creating this document.
- The working tree was clean before this document was added.
- No PR was created, no merge performed, no release/tag published, and no installed plugin or real worker restarted during this work.
- This handover is a new local document; it is not part of the pushed commit above.

Inspect `git status` before editing: other agents or the user may have changed the workspace since this handover.

## Scope sources and constraints

Read these before implementing orchestration changes:

1. [Orchestration-first delivery plan](superpowers/plans/2026-10-11-orchestration-1.0.md)
2. [Always-on dashboard and run timings](decisions/0022-always-on-dashboard.md)
3. [Bulk runs and worker test gate](decisions/0023-bulk-runs-and-test-gate.md)
4. [Tracker onboarding](decisions/0024-tracker-onboarding.md)
5. [Remote run proposals](decisions/0025-remote-run-proposals.md)
6. [Data contract](DATA-CONTRACT.md), [UI design](UI-DESIGN.md), [README](../README.md) and [changelog](../CHANGELOG.md)

The plan references an external Claude document and its review. That external document was not accessed in this audit; findings use the repository's delivery plan, ADRs and implementation.

Preserve these boundaries:

- Node >=22, ES modules, plain HTML-string UI renderers, existing CSS tokens; no framework migration, bundler or new runtime dependency required.
- Deterministic worker logic owns repository resolution, scheduling limits, batching and test verification. Agent claims do not substitute for worker evidence.
- One queued/running reservation per ticket; fix serialization and configured concurrency limits must remain enforced by the worker.
- Shared-page edits create proposals, not immediate runs. Owner approval remains required.
- Clone consent and explicit commit/push/PR permissions remain intact.
- Read-only exports must retain capability restrictions and privacy sanitization.
- “Queued”, “running”, “tests passed” and “done” must remain distinct states. A completed run is not automatically a completed ticket or a deployment.
- No prewarmed worktree pool or nested run-group display was approved in the 1.0 plan. Do not expand into autonomous DAG execution or automatic approval under a UI task.
- Use test doubles for OS registration, tracker calls and clone operations; do not exercise the user's real machine configuration through tests.

The historical plan contains “Never push” and an author-specific commit trailer. The human explicitly authorized the push in this conversation, and it was completed. Do not fabricate authorship. Treat future push/release actions according to the actual user request and current repository instructions.

## What shipped in 144c056

### Shell and navigation

- Compact page titles and statistics replace the large introductory headings.
- Navigation can collapse to 72px on desktop; preference persists in local storage.
- “Today” is labelled “Activity”; “Tree” is labelled “Relationships”. Internal route IDs remain `today` and `tree`.
- Connection/workspace diagnostics move into disclosures. Provider failures and offline state remain visible.
- A global pending-proposals button opens Activity and clears filters so proposals are not hidden by an unrelated project selection.
- Detail docking considers available width after the sidebar, rather than only a fixed viewport breakpoint.

### Pick next

- Ranked recommendations precede unlinked work.
- Unlinked work is collapsed under “Needs your attention”; open disclosure state survives polling.
- Added “Where you left off” with a checkpoint preview and a context link.
- During the follow-up audit, fixed a new association bug: the preview now comes from an actual complete checkpoint and its recorded `ticket_id`, rather than pairing a session's old preview with its current ticket. A regression test covers switching tickets after a checkpoint.
- Local ticket keys truncate visually on cards; full keys remain in the copy payload and hover title.

### Ticket details and Sessions

- Status/Handoff controls, next action and latest checkpoint come before long-form content.
- Overview, Activity and Delivery tabs group existing sections; arrow/Home/End keys navigate tabs.
- Expanded ticket view uses the content area; close/Escape restores context.
- Modal ticket details make background controls inert and trap Tab at the panel boundaries.
- Sessions show a longer checkpoint preview, a “View checkpoints” action and the current next action; binding metadata is collapsed.

### Changed files

- `ui/app.js`, `ui/components.js`, `ui/styles.css`
- `ui/views/header.js`, `picknext.js`, `detail.js`, `sessions.js`
- `tests/ui/render.test.js`, `tests/ui/workspace-design.test.js`
- `CHANGELOG.md`
- `docs/images/dashboard-pick-next.jpg`, `dashboard-board-detail.jpg`

## Verification already completed

| Check | Result and limit |
| --- | --- |
| Full `npm test` before the final checkpoint-association fix | 809 tests: 807 passed, 2 skipped, 0 failed |
| UI and export tests after that fix, on the pushed code | 100 passed, 0 failed |
| `git diff --check` | Passed before commit |
| Browser, 1280×720 | Top recommendation and Handoff action visible without scrolling |
| Browser, 390×844 | Document width equals viewport width; filter strip scrolls internally |
| Browser, 1440×900 / dark mode | Visually inspected |
| Keyboard and navigation | Ticket opening, tab arrows, expansion, Escape, and modal focus boundary checked |
| Workflow checks | Approval shortcut clears filters; checkpoint loading renders; Sessions opens Activity; unlinked-work disclosure survives polling |
| Browser runtime | No page errors in the tested flows |

Do not report that the full suite was rerun after the final association fix. Only the UI/export suite was rerun at that point.

Browser checks used the isolated development store from `node scripts/dev-seed.mjs`, not the user's live data. Both temporary development servers were stopped. Do not reuse the old one-use authentication URLs. No credentials are included here.

## Confirmed defects to address first

### P1 — Full run results are fetched but never displayed

**Origin:** Existing defect, exposed by the orchestration audit.

**Evidence:** `ui/views/agents.js` `runItem()` renders “Partial/full result” using `data-action="load-content"`. `ui/app.js` stores the fetched text in `appState.content`. `renderDetail()` receives that cache, but does not pass it to `renderAgentsSection()`, and run rendering never reads it. Timeline “Full text” has the same missing display path in `timelineItem()`.

**Reproduced:** Rendered a fixture ticket containing a run with `result_ref`, supplied a unique text sentinel in `content[result_ref]`, and verified that the result button exists while the text does not appear in the rendered HTML. This was a renderer-level reproduction, not a browser/network failure test.

**User friction:** A user clicks for evidence and sees no result. This blocks informed review even when the run succeeded.

**Fix:** Thread loaded content through run/timeline renderers or provide a shared content viewer. Add loading, empty/unavailable and visible failure states. Currently `load-content` only reacts to `generation-expired`; other fetch failures are not surfaced.

**Acceptance:** Clicking a run's result or timeline full-text action renders that item's escaped content. Failed loads show Retry. Polling/generation changes do not silently leave the user with an unexplained empty viewer. Test both full content and denied/unavailable content.

### P1 — Sessions checkpoint shortcut can open the wrong ticket

**Origin:** The new shortcut exposes an existing mismatch between session-wide last checkpoint and current ticket binding.

**Evidence:** `ui/views/sessions.js` displays `s.last_checkpoint_preview` but links “View checkpoints” to `current.id`. `src/core/reduce/sessions.js` `bindSession()` updates the current ticket without clearing the last checkpoint. `src/core/reduce/capture.js` records the checkpoint's own ticket and binding revision.

**Reproduction to automate:** Capture a checkpoint on ticket A; bind the same session to ticket B without capturing another checkpoint; open Sessions. The visible checkpoint remains A's, but the shortcut opens B's Activity. The Pick next equivalent was fixed before push; this Sessions path remains open.

**Fix:** Resolve `last_checkpoint_id` against the checkpoint collection and navigate using its recorded ticket. Distinguish the current ticket's next action from the checkpoint's historical ticket context. Handle unbound/missing checkpoints without inventing an association.

**Acceptance:** A→B rebinding still opens A's displayed checkpoint; B can remain separately labelled as the current ticket. Add a regression test and browser check.

### P2 — Completed batch summaries disappear after reload

**Origin:** Existing behavior; a stronger product gap under orchestration-first scope.

**Evidence:** `ui/lib/bulk.js` `activeBatches(snapshot, known)` includes terminal batches only when their IDs are in the page's `known` list. `ui/app.js` initializes `batches: []`; strips render only on Board and Pick next.

**Reproduced:** A done batch returns `['demo']` when `known=['demo']`, and `[]` with the same snapshot and `known=[]` after a simulated reload. The run records are not lost; their aggregate summary is no longer surfaced.

**Fix:** Derive recent/history batches from recorded handoffs, provide a stable detail route, and retain access to failed/skipped/completed members. Persistence of UI dismissal must not be mistaken for persistence of run history.

**Acceptance:** Queue a mixed-outcome batch, reload after completion, and still find the batch and every member outcome. Running, failed and completed views must survive closing/reopening the browser.

## Orchestration scope gaps and design recommendations

These are recommended follow-up work, not implemented features or proof that the worker lacks the corresponding capability.

| Priority | Gap and source evidence | Recommended behavior | Acceptance target |
| --- | --- | --- | --- |
| P1 | No global run workspace. `NAV_ITEMS` has ticket, relationship, session, deployment and activity views; runs live in ticket detail. | Add a Runs surface with Running, Queued, Needs review, Failed and History filters, linked to tickets and batches. | From any page, reach an active/failed run in one navigation step; inspect/cancel/retry without searching individual tickets. |
| P1 | Review evidence is incomplete. The worker records `patch_path`, `worktree_path`, `pr_url` and `uncertain_effects`; the Agents renderer has no dedicated presentation of these fields. | Provide a run detail view for diff/result, worker test evidence, local checkout location, PR link and uncertain side effects. Expose artifacts through authorized endpoints; never turn arbitrary local paths into unrestricted file reads. | A completed fix tells the owner what changed, what was verified and where it exists. Partial push/PR outcomes remain explicitly uncertain. |
| P1 | New tabs make run discovery ambiguous. `detail.js` keeps proposals and Agents in Overview after Description, Status, Approved plans and Follow-ups. Activity contains timeline/checkpoints, not the actual run controls. | Give Runs a labelled ticket section and surface a current-run/approval summary near the title. Keep timeline as history. | A user opening a running ticket can immediately find status, test evidence, cancel/retry and pending suggestions. |
| P2 | Queue reasons are not visible after submission. Bulk preview mentions capacity and “waits for repo”; run items mainly show queued/running and recorded timings. | Project the authoritative wait reason and current phase from worker state: capacity, repository lock, setup, agent, tests, repair. | Every queued run explains its wait; live phases never claim tests passed before worker evidence exists. Do not fabricate ETA. |
| P2 | Dispatch has competing concepts: Handoff, Run recipe, Analyze, Attempt fix, and Queue run. Legacy/built-in and recipe suggestion behavior differs. | Use one task-oriented Run agent entry with explicit recipe, scope, source access, test verification and side effects. Preserve legacy semantics until deliberately migrated. | Before queueing, users can tell whether the run reads/edits, where it runs, whether tests are configured and whether results need acceptance. |
| P2 | Readiness is weak at the point of dispatch. `renderHandoffForm` accepts a `prerequisites` object, but the app does not supply it. Missing repo/test configuration often leads to prose or CLI guidance. | Add a worker-derived readiness summary with actionable repo/clone/auth/test-command blockers. Keep notes-only analysis available where supported. | A fix cannot look ready when required prerequisites are missing; missing test command is explicitly unverified, not silently treated as a pass. |
| P2 | “Where you left off” and attention items still follow all recommended cards. Ticket “Needs attention” stats count blocked/stale tickets, not run failures or pending suggestions. | Separate work selection from operator attention: a compact attention strip with precise counts and direct links; place recovery context near the first recommendation. | Counts name their entity and scope. Failed runs, approvals and unreviewed results can be reached without scrolling through five recommendations. |
| P2 | Filter scope differs across sections. Pick next stats/recommendations are filtered, while attention deployment counts are global; the deployment shortcut retains current filters. | Explicitly label global counts or filter them consistently. A global-count shortcut should open the matching unfiltered destination. | Clicking an “awaiting deployment” count opens the items that count represents, including under a project filter. |
| P3 | Navigation labels changed but documentation still uses Today/Tree in several places. Small-screen six-item navigation truncates long labels. | Align user-facing docs/help with Activity/Relationships; evaluate a shorter mobile navigation or More menu if Runs is added. | Route compatibility remains intact; users can read labels and find every primary workflow at phone width. |

## Suggested implementation order

1. **Correctness and evidence:** fix full-result/timeline display and Sessions checkpoint association. Cover failure states and escaping. These are small changes and do not require an architecture rewrite.
2. **Durable run visibility:** derive run/batch history from snapshot records; add stable navigation to an individual run and its ticket. Keep request-submission outcomes distinct from execution outcomes.
3. **Orchestration UX:** add the Runs surface and relocate ticket run controls so their purpose is obvious. Consolidate operator attention without reintroducing a tall home-page introduction.
4. **Readiness and queue explanations:** add only the worker projections/endpoints needed for accurate preflight and phases. Document any contract/event changes and update ADRs as appropriate.
5. **Polish and docs:** consistent action names, filter scope, mobile navigation and refreshed screenshots.

Avoid another palette/font redesign. Retain Geist, evergreen accents, semantic status colors and existing motion/reduced-motion support.

## Recommended test scenarios

- Completed/failed run → full result, loading failure and Retry; long output remains readable and escaped.
- Checkpoint on A → rebind to B → Sessions still opens the checkpoint for A.
- Mixed-outcome batch → reload → all members and aggregate outcome remain discoverable.
- Two fixes for one repo → second run explains its wait; cancellation does not falsely claim the active run was stopped when only queued members were cancelled.
- Fix with no test command → explicitly unverified; worker failure → repair → failure remains distinct from success.
- Proposal arrives while an unrelated project filter is active → global approval shortcut reaches it; no run starts without approval.
- Missing repository, needs-clone, no-code and notes-only analysis each have appropriate actions.
- Read-only export → no owner-only mutation controls or newly exposed local paths/logs.
- Keyboard-only use of Runs/ticket tabs, modal boundaries, Escape, and focus restoration; opening a drawer while a health popover is open deserves additional coverage.
- 1280×720, 1440×900, 390×844, light/dark, reduced motion, large ticket/run lists and long keys.

## Commands and local tooling

```powershell
git status --short
git log -3 --oneline
node --test "tests/ui/*.test.js" "tests/export/*.test.js"
npm test
git diff --check
node scripts/dev-seed.mjs
```

The seed helper creates a throwaway store and prints a one-use owner URL. Keep that secret out of commits/docs. Stop the helper when finished; do not restart the real user worker for screenshot tests.

The default `python` command was not available in this session. Bundled Python was available at:

`C:\Users\shiva\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`

Use `-X utf8` or explicit UTF-8 file encoding on Windows. A first editing attempt exposed Windows default-encoding/newline issues; they were normalized before commit. `git diff --check` passed. Load current workspace dependency paths again if the runtime bundle changes.

Browser checks used Playwright from the bundled Node modules, without adding a project dependency. Test scripts/logs were temporary; only the renderer regression tests and documentation screenshots are committed.

## Next-agent kickoff

Read this handover and the 1.0 delivery plan, verify the branch and working tree, then reproduce the two P1 correctness defects before changing code. Start with result rendering and checkpoint ownership. Present the Runs workspace and deeper orchestration additions as the recommended next scope; do not describe them as already implemented. Preserve the worker's approval, verification, concurrency and export boundaries throughout.
