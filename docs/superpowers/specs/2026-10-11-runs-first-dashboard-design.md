# Runs-first dashboard: design

Approved in conversation on 11 October 2026. Scope source: [Agent handover: Quill UI and orchestration-first 1.0](../../AGENT-HANDOVER-ORCHESTRATION-1.0.md) and the review of the `144c056` dashboard against the ui-ux-pro-max guidelines.

## Goal

The dashboard helps a user pick and inspect tickets, but operating agent runs still means moving between ticket details, batch strips and Activity. This change completes the dispatch → monitor → inspect evidence → decide → recover loop: a Runs page with a run detail panel, a run strip on every ticket, one Run agent dialog, a shell that fits a phone, and the two P1 correctness defects fixed.

Not a visual redesign: Geist, the evergreen accent and the semantic status colours stay. Only the tokens named in §7 change.

## Constraints

- Node ≥ 22, ES modules, plain HTML-string renderers in `ui/`, existing CSS tokens; no framework, bundler or runtime dependency.
- Everything rendered comes from the snapshot the server already serves (tickets, handoffs, requests, run proposals, `meta.handoff_limits`, capabilities). No worker changes, no new endpoints, no fabricated wait reasons or ETAs.
- Route IDs `picknext`, `board`, `tree`, `sessions`, `deployments`, `today` keep working; `runs` is added. Existing links keep resolving.
- Queued, running, tests passed and done remain distinct states. A completed run is never shown as a completed ticket or a deployment.
- Exports (`capabilities` all mutation flags false) show no owner-only controls, no local paths, no result links into the filesystem.
- Approval, clone consent, commit/push/PR permissions, concurrency caps and reservation stay enforced by the worker; the UI only reflects them.

## 1. Navigation and shell

### Sidebar

Two labelled groups replace the flat list:

| Group | Items (route id) | Count badge |
| --- | --- | --- |
| Work | Pick next (`picknext`), Board (`board`), Runs (`runs`) | Runs: number of queued + running runs, labelled "live"; falls back to the Needs-you count when nothing is live |
| Track | Activity (`today`), Sessions (`sessions`), Deployments (`deployments`), Relationships (`tree`) | unchanged |

`NAV_ITEMS` in `ui/views/header.js` gains a group field; keyboard shortcuts `1`–`7` follow the new order. The collapsed (72 px) sidebar keeps icons and badges; group labels hide.

### Phone bottom bar (< 900 px)

Five items: Pick next, Board, Runs, Activity, **More**. More opens a bottom sheet listing Sessions, Deployments and Relationships, with the same badges. The sheet closes on selection, Escape or backdrop tap. The active item is highlighted even when it sits inside More (More itself shows the active state).

### Top bar

One row at every width:

1. Search (grows; collapses to an icon button under 600 px that expands in place).
2. **Status button**: a dot plus a short label ("Updated just now", "1 provider error", "Offline"). Clicking opens a popover with connection details, provider health, worker health, last capture, and the Refresh button. Provider failures and offline state colour the dot and the label; they are never hidden.
3. Approvals button (existing `review-proposals` action) now opens Runs → Needs you.
4. Schedules, Export, theme, help as today.

- The request receipt line ("Receipt: handoff applied …") becomes a toast in the existing announcement region: shown for 6 s, dismissible, with the LIVE chip. Receipts also remain in the run detail they belong to.
- Filters move behind a **Filter** button showing the count of active filters (e.g. "Filter · 2"). Clicking opens a popover with the same Project, Category, Repo and Stale controls. The hash keeps the same filter parameters so links keep working. Views that ignore filters (Sessions, Deployments) hide the button.

### Width rules

Nothing may be wider than the viewport at 390 px. The top bar, filter popover, stats row, cards, run rows and the run detail panel all wrap or truncate rather than overflow. The board columns keep their intentional horizontal scroll inside the board region only.

## 2. Runs page (`#view=runs`)

### Tabs

| Tab | Membership | Count |
| --- | --- | --- |
| Needs you | open run proposals (state `proposed`, not expired); done runs with ≥ 1 unresolved suggestion; runs in `failed`, `timed-out` or `cancelled` with no later run that has `retry_of` pointing at them | yes |
| Live | `queued`, `running` | yes |
| Failed | `failed`, `timed-out`, `cancelled` (all, retried or not) | yes |
| All | every handoff with `requested_at` in the last 30 days, plus proposals | no |

Tabs are a `tablist`; arrow keys move between them; the selected tab is in the hash as `tab=`. Default is Needs you when it is non-empty, otherwise Live, otherwise All.

Filters (Project, Category, Repo) apply to Runs through the run's ticket. The Needs-you count in the header approvals button is global and labelled so.

### Rows

Runs are grouped by `batch_id`; runs without one are listed individually. Within a tab, groups and single runs are ordered by most recent `requested_at`. A batch group header shows: batch short id, recipe or mode (or "mixed"), outcome counts ("3 done · 1 running · 1 queued · 1 failed"), a progress bar, and **Cancel queued** when the owner has `capabilities.handoff` and at least one member is queued. Cancelling sends one `handoff-cancel` per queued run, exactly as `quill handoff cancel --batch` does; running members are never claimed cancelled.

Each run row: state icon and label, ticket key (middle-ellipsised) and title, recipe or mode, access chip (read-only / edits source), one fact line, and a time. The fact line by state:

- `queued`: "Queued" plus, when the snapshot shows the cap in use, "· read-only slots 2/2 in use" or "· fix slot in use" from `meta.handoff_limits` and the count of running runs of that kind. When the ticket's repository already has a running fix, "· repository busy". Never a reason the snapshot does not contain; never an ETA.
- `running`: the phase if `timings` or `test_gate` reveal it ("agent 2 min", "tests running"), else "Running since …".
- `done`: test-gate chip (`testGateChip`), suggestion count ("2 suggestions to review"), PR link indicator.
- `failed` / `timed-out` / `cancelled`: `error` or the test-gate failure summary, plus "Retried as …" when a later run has `retry_of`.
- proposal: "Proposed on the team page by <editor>", with Approve and Dismiss inline (owner only).

Clicking a row opens run detail (§3). Rows are buttons with the run's state in `aria-label`.

### Data source

Everything is derived from snapshot handoff and proposal records in a new `ui/lib/runs.js` (`runTabs(snapshot, filters)`, `groupRuns(runs)`, `runFacts(run, snapshot)`, `needsYou(run)`). `activeBatches` in `ui/lib/bulk.js` keeps driving the Board and Pick-next batch strips; the strips gain a "View in Runs" link. Because Runs reads records rather than the page's `known` list, batch summaries survive a reload (handover P2).

### Proposals move

The "Proposed runs" section leaves Activity (`ui/views/today.js`) and the ticket Overview; proposals live in Runs → Needs you and in the ticket's Runs tab. Activity is history only. The fresh-proposal toast text points at Runs.

## 3. Run detail (`#view=runs&run=<id>`)

Opens in the same docked/modal side panel tickets use (same width rules, inert background and focus trap in modal mode, Escape closes and returns focus to the row). The panel has Previous/Next over the visible rows and **Open ticket**, which switches to Board with the ticket selected.

Sections, top to bottom:

1. **Header**: ticket key and title; state chip; recipe name with source (built-in / personal / repo) and mode; access chip; test-gate chip; timings ("waited 12 s · setup 4 s · agent 2 min 10 s · tests 48 s"); batch link when `batch_id` is set; "Retry of …" when `retry_of` is set.
2. **Result**: `result_summary`, then an **Show full result** disclosure that loads `result_ref` through `load-content`. States: loading ("Loading result…" with `aria-busy`), loaded (escaped `<pre class="full">`), unavailable ("Result unavailable: capture incomplete"), failed ("Could not load the result: <message>" with **Retry**). A `generation-expired` error triggers a poll and then a retry, as today, but the failure is shown while that happens.
3. **Changes**: `changed_files` as code chips, `commit_sha` short with copy, `test_results` list, test-gate output in a disclosure when the gate failed.
4. **Delivery**: `pr_url` as an external link; `branch`; when `uncertain_effects` is non-empty a warning block "The worker could not confirm:" with each item. This block uses the warning tokens and is never rendered with success styling, including when the state is `done`.
5. **Where it is** (owner only, hidden in exports): `worktree_path` as text with a copy button. It is never an `href` and never fetched.
6. **Suggestions**: the existing `suggestionItem` list with Accept / Dismiss and their undo.
7. **Actions** row: Cancel (queued/running, `capabilities.handoff`), Retry as new run (terminal non-done states; opens the Run agent dialog pre-filled with the same recipe, `retry_of` set), Open ticket.

Proposals open the same panel with their payload (recipe, editor, publisher, proposed_at, expiry) and Approve / Dismiss. An expired proposal shows why ("older than 7 days" / "ticket done") and only Dismiss.

## 4. Ticket detail

- **Run strip** directly under the title chips, before Change status: the current run if one is queued or running, otherwise the latest finished run. It shows state, recipe, test-gate chip, "N suggestions to review" and a time, and links to the run detail. With no runs it shows "No agent runs yet · Run agent". It replaces the one-shot "Applied" receipt banner, which becomes a toast (§1).
- **Tabs** become Overview, Runs, Activity, Delivery. The Runs tab holds the run strip's full list (newest first, each row opening run detail), then the Proposed runs for this ticket, then **Run agent** and the recipe catalogue (`renderAgentsSection` without its per-recipe Run… buttons; one button per recipe stays but opens the unified dialog at step 2 with that recipe chosen). Overview loses the recipe catalogue and the proposals section.
- The hash gains `section=` for the detail tab (the parameter name `data-section` already uses) so a link can open a ticket on Runs; `tab=` stays reserved for the Runs page.

## 5. One Run agent dialog

Replaces the Handoff dialog (`renderHandoffForm`) and the recipe Run dialog (`renderRecipeRunDialog`). One dialog, two steps, one request shape as today (`handoff` payload: recipe, mode, note, permissions, access, branch, batch_id, retry_of).

**Step 1 — What to run.** Cards for each effective recipe (`effectiveRecipes`) and the three legacy modes, each with name, one-line description, "reads source" / "edits source" marker and the time cap. Legacy modes are marked "built-in". The chosen card is remembered per ticket for the session.

**Step 2 — How it may run.** Access (My Claude Code settings / Standard / Full access, with the existing warning copy), Source access (read, edit in isolated checkout), Note (max 280). **Advanced** (collapsed by default) holds Commit locally, Push branch with branch name, Open draft PR. Options that the recipe's frontmatter forbids are disabled with the reason. Options that require another option enable only when it is ticked, as today.

**Summary before queueing**, always visible at the bottom of step 2, in plain words assembled from the choices and snapshot facts:

> Reads source · edits in an isolated checkout · tests: `npm test` run by the worker · no commit, push or PR · result needs your acceptance

Prerequisite facts the snapshot already has render above the summary: no registered repository (blocker for source access, notes-only still allowed), repository needs clone (link to the Clone action), no test command (warning "fixes will be marked Not test-verified"), a run already queued or running on this ticket (blocker: "Cancel it first or wait"). The Queue button is disabled while a blocker applies and says why in its tooltip and an adjacent line.

Bulk runs keep their own dialog (`ui/views/bulk.js`), which gains the same summary line.

## 6. P1 correctness fixes

**Full results and timeline text display.** `renderDetail` passes `content` into `renderAgentsSection` and `timelineItem`; both render `content[ref]` in a `<pre class="full">` after the button, and the button label flips to "Hide". The `load-content` handler in `ui/app.js` records `appState.contentState[ref] = 'loading' | 'loaded' | { error }` so renderers show loading and failure states with Retry. Run detail (§3) uses the same mechanism.

**Sessions → View checkpoints.** `ui/views/sessions.js` resolves `s.last_checkpoint_id` in `snapshot.checkpoints` and links to that checkpoint's `ticket_id`, labelled with that ticket's key. The current binding is shown separately ("Now on PROJ-44") with its next action. When the checkpoint is missing or has no ticket, the preview stays and the link is omitted; no association is invented.

## 7. Visual tokens and small fixes

- `--border-strong`: dark `#6f8277`, light `#7f8f86` (≥ 3:1 against `--surface` in both themes) for inputs, selects, checkboxes and the focus-adjacent outline.
- `--text-faint`: dark `#8a9992` so faint and muted text differ visibly; light unchanged. Verified ≥ 4.5:1 on `--surface`, `--surface-raised` and `--surface-inset`.
- Card keys: 11.5 px monospace, middle ellipsis (`LOCAL-pre…-00000001`) with the full key in `title` and in the copy payload.
- Board column "Hide" becomes an icon button with `aria-label="Hide <column>"`; hidden columns reappear through the existing control.
- Runs page row and batch header styles reuse `.card`, `.chip`, `.btn` and the status tokens; one new token `--run-bar` for the batch progress fill (accent) is added.

## 8. Error handling

- Snapshot without `handoffs` or `handoff_limits` (older worker, exports): Runs renders with what exists; wait facts and caps are simply omitted.
- Request failures for cancel, approve, dismiss, accept show the server's error code and message in the row/panel, matching the existing `pending`/error pattern; `handoff-reserved` on approve shows the active run and links to it.
- Generation changes during a load show "Snapshot changed, reloading…" and retry once.
- A `run=` in the hash that no longer exists shows "Run not found" in the panel with Open Runs.

## 9. Testing

Renderer tests (`tests/ui/*.test.js`, `node:test`):

- `runs.test.js`: tab membership for every state including expired proposals and retried failures; grouping by batch and ordering; fact lines for queued with caps in use, repository busy, running with timings, done with suggestions, failed with retry; no ETA or reason text without snapshot evidence.
- `run-detail.test.js`: every section with and without data; content loading, loaded, unavailable and failed states; escaping of result text and file names; `uncertain_effects` never inside a success-styled element; `worktree_path` absent when `capabilities.handoff` is false.
- `detail.test.js` additions: run strip for queued, done and none; Runs tab contents; Overview no longer contains recipes or proposals; full result and timeline full text render when `content` has them.
- `sessions.test.js`: checkpoint on A, rebind to B → link targets A; missing checkpoint → no link.
- `run-dialog.test.js`: step 1 cards, step 2 option gating by recipe frontmatter, summary text for each combination, blockers disable Queue, retry pre-fill.
- `header.test.js`: groups, badges, bottom bar with More, status popover content, filter count.
- `export.test.js` additions: a static export renders Runs and run detail with no Cancel/Approve/Accept controls, no `worktree_path`, no result links.

Browser checks (Playwright from the local runtime, dev-seed store, not committed as a dependency): at 1440×900, 1280×720 and 390×844, light and dark, reduced motion on and off — `document.documentElement.scrollWidth === innerWidth` on every view; queue a run and watch it move Live → Needs you; open run detail by keyboard, Tab stays inside the modal, Escape returns focus to the row; More sheet opens and closes; filter popover sets the hash. Refresh `docs/images/dashboard-*.jpg`.

`npm test` and `git diff --check` pass before the branch is offered for review.

## Out of scope

Worker projections (wait reasons the snapshot lacks, readiness endpoints), prewarmed worktrees, nested run groups, automatic approval, a new palette or typeface, documentation and README screenshots beyond the refreshed dashboard images.
