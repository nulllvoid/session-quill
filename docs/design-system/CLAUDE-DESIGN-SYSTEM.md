# Quill Fieldnotes — Claude design system

Version 1.1 · 19 October 2026 · Quill-owned design language.

This is an implementation contract for Claude and other coding agents working on Quill. It is not a recreation of the Claude app and has no affiliation with Anthropic's brand system.

## 1. Design intent

Build a calm, legible workspace for a developer who chooses tickets, dispatches agent runs, inspects evidence and decides what happens next. The important object is the work, not the dashboard chrome.

The interface should answer:

1. What should I do next, and why?
2. What is running or waiting, and what is blocking it?
3. What changed, what was verified, and what needs my decision?

Preserve the existing green/Geist identity. Use neutral surfaces, one primary evergreen accent, semantic status colors, fine separators and restrained movement. Do not add marketing headlines, decorative charts, hero imagery, glass panels, gradients, oversized empty areas or ornamental animation to operational screens.

## 2. Sources and precedence

| Source | Responsibility |
| --- | --- |
| Human task and applicable repository instructions | Current task scope and authorization |
| `docs/DATA-CONTRACT.md`, orchestration ADRs 0022–0025, autonomous-run ADRs 0026–0028 | State meanings, permissions, verification, execution and privacy |
| `ui/styles.css`, `ui/components.js`, current view renderers | Shipped implementation and theme/icon source values |
| This document | Visual direction, component usage and implementation guidance |
| `ui/assets/tokens.json` and `tokens.css` | Generated theme snapshot plus additive reference primitives |
| `docs/design-system/index.html` | Inspectable component examples and the Runs page with example data |
| `docs/AGENT-HANDOVER-ORCHESTRATION-1.0.md` | Known defects, scope gaps and prior validation limits |

`docs/UI-DESIGN.md` is an older behavioral specification. Its “inbox first”, Today/Tree labels and prior visual layouts are superseded by the current UI. Historical `docs/ui/graphite_ink` and `terminal_slate` directions must not be blended into Fieldnotes.

The user called the target “v.10”; the repository documents Orchestration-first **1.0**. Do not invent a separate v10 execution engine.

## 3. Foundation tokens

Use semantic variables, never copy colors into new components. The generator extracts the existing light/dark theme values from `ui/styles.css`.

| Role | Variable | Light | Dark |
| --- | --- | --- | --- |
| App canvas | `--bg` | `#f6f7f5` | `#151b1b` |
| Primary surface | `--surface` | `#ffffff` | `#1c2423` |
| Inset region | `--surface-inset` | `#eef1ed` | `#111716` |
| Body text | `--text` | `#23332d` | `#e9efec` |
| Supporting text | `--text-muted` | `#58685f` | `#acb9b3` |
| Primary fill | `--accent-fill` | `#245c49` | `#91cebb` |
| Primary foreground | `--accent-fg` | `#ffffff` | `#142e26` |
| Accent region | `--accent-soft` | `#e7f0e9` | `#233d33` |
| Focus indicator | `--focus` | `#23634f` | `#91cebb` |
| Faint text | `--text-faint` | `#627169` | `#8a9992` |
| Control boundary | `--border-strong` | `#7f8f86` | `#6f8277` |

Form controls (inputs, selects, textareas) draw their boundary with `--border-strong`, which meets 3:1 against `--bg` and `--surface` in both themes; `tests/ui/tokens.test.js` enforces it.

Use `--border` for separation and `--border-strong` for actionable boundaries. Text and outline colors have different roles; a separator is not necessarily a sufficient control boundary. Avoid lowering opacity on essential text. Validate contrast on the actual background; theme token checks do not certify every component combination.

### Typography

- Geist for interface text; Geist Mono for keys, durations, hashes and code.
- Reuse the bundled WOFF2 files under `ui/fonts/`; no remote font requests.
- Page title: 25px/1.2, weight 550–600. Section heading: 18px/1.25, weight 600.
- Body: 15px/1.45–1.5. Controls: 13px, weight 500. Supporting text: 12–13px.
- Essential controls and instructions must not shrink to 10–11px to fit a crowded layout. Reflow or simplify the layout.
- Enable tabular numbers. Keep paragraphs around 65–70 characters wide where practical.
- Reserve sentence case for UI labels; use all-caps only for sparse reference-page metadata.

### Spacing and geometry

- Base rhythm: 4, 8, 12, 16, 20, 24, 32, 48px.
- Use 12–16px within a component, 20–24px between groups, and 24–32px content gutters on desktop.
- Controls: 6px radius. Ticket cards: 10px. Larger panels: 12px.
- These effective radii match the current app's later overrides. Legacy `--radius*` variables remain unchanged; the opt-in kit expresses them as `--q-radius-*`.
- Desktop control height target: 36px; coarse-pointer target: at least 44px. The existing app has some smaller controls; new kit components should not inherit that debt.
- Content maximum: 1320px; expanded ticket reading width approximately 880px.
- Current sidebar: 224px expanded / 72px collapsed; detail width: 440px. Do not force docking if the remaining work area becomes unusable.

## 4. Assets

Use `ui/assets/manifest.json` to discover assets. See the adjacent README for exact integration examples.

- **Brand:** light, dark and monochrome marks derived from the existing Quill feather. Use the real bundled Geist text for wordmarks; do not add raster text assets.
- **Icons:** existing glyphs exported from `ui/components.js`, plus matching orchestration extensions: runs, queue, approve, diff, tests, lock, expand and collapse.
- **Illustrations:** empty queue, no results, review complete and worker offline. Use sparingly, generally 120–160px wide. Meaning lives in the accompanying text/action.
  Production views do not reference `/ui/assets/…` images. Static exports inline the stylesheet and bundle the scripts and must not contain `src="/ui/` URLs (`tests/export/static.test.js`), so dashboard empty states are text with a next step. Use illustrations only on surfaces that are never exported, or inline the SVG.
- **Tokens:** JSON map and standalone CSS. They are generated exports, not a second independently maintained theme.
- **Components:** `ui/assets/components.css` provides opt-in `q-*` styles. The production dashboard does not load this file automatically.

Icon rules: 16×16 viewBox, 1.5px stroke, rounded line ends/joins, `currentColor`. Use 16px in controls and 20px only when extra optical weight is needed. Do not mix another icon family into this kit. Existing `icon(name)` still supports only the original glyph names; adding SVG assets alone does not register new names in that renderer.

For decorative SVGs use `aria-hidden="true"` or `<img alt="">`. For icon-only actions give the button an accessible action label. For a meaningful standalone image provide suitable alt text. Do not rely on an SVG filename or tooltip as the sole accessible label.

## 5. Component contract

| Component | Required anatomy | States and behavior |
| --- | --- | --- |
| Primary action | Verb + object, optional icon | One primary action per decision region; pending label and duplicate-submit protection |
| Secondary action | Border or quiet treatment | Evidence/navigation actions should not compete with the primary decision |
| Ticket card | Key, title, status, next action, relevant metadata | Keyboard activation, visible selection, full key copy; preserve independent inner actions |
| Run row | One `<button>` per run: state chip, ticket key (middle-ellipsised, full key in `title`) and title, recipe or mode, access badge, worker test-gate badge, one fact line, requested time | The access badge is the run's kind (Read-only / Edits source / Changes files) plus its access tier: "Autonomous", "Autonomous + scopes (n)" (warning style; its `title` lists the scope names, and an export, which carries only `scope_count`, shows the count without names) or "Full access" (warning style). Standard and "my settings" runs show the kind only. The button's accessible name repeats the badge words. The fact line states only recorded facts: queued → "Queued" plus slot occupancy from `meta.handoff_limits`, "repository busy" for a queued fix whose repository has a running fix, and "Batch budget reached" for a queued batch member whose batch's recorded spend reached `meta.handoff_limits.batch_budget_usd`; running → "Running for under a minute" or "Running for N min" (whole minutes, so the row changes at most once a minute) and "setup …" when measured; done → suggestions to review, files changed, draft PR; failed → the error (else "Tests failed" / "Tests timed out" from the test gate, else "Failed") plus "Retried as a new run" or "Superseded by a later run". Nothing interactive nests inside the row button |
| Run strip | Under the ticket title: the current run (else the latest) with state, recipe, test-gate badge, suggestions to review and time; opens run detail | "No agent runs yet" when there are none (owner only, ticket not done); Run agent stays in the status controls |
| Run detail | Header (state, recipe and source, mode, access badge, test gate, measured timings, batch, retry relationship); Result; Recorded stage; Plan; Attempts (n); Verification; Changes; Critical changes (n); Production writes (full access); Delivery (PR, branch, uncertain effects); Learnings filed (n); Tools used; Turns & cost; Where it is (owner-only checkout path as text with copy, never a link); Suggestions; actions | Sections absent from the record or stripped by an export are omitted, never rendered empty. Plan, Attempts, Verification and Critical changes come from the run's result blob, which only the owner dashboard fetches; an export has none of them. Attempts carry outcome chips in words ("Worked", "Failed", "Refused (no scope)", "Refused", "Unavailable (needs auth)", "Unavailable (policy)", "Unavailable", "Skipped", "Outcome not stated"), "Claimed, no tool call seen" when the run's ledger shows no such call, and "Added from the run ledger" for a refusal the ledger recorded that the agent did not report. Learnings filed lists each entry with its trust chip and a link into Memory; Tools used counts the tools the attempts name, each marked "Call in the run ledger" or "Claimed, no tool call seen". Verification rows say "Passed (agent's check)", "Failed" or "Not verified", under the line that only "Tests passed (worker)" is Quill's own check. Each critical change shows its scope as a warning chip ("Needs write scope …"), risk, the action as escaped code, and where it stands: "Proposed as <key>; it waits for your decision in Needs you", approved, dismissed, expired, "Not proposed: <reason>" (owner only, from `critical_notes`), or "Not proposed: only a run that finishes done proposes its critical changes". Production writes (owner only, from `prod_effects`) lists each write as a warning chip "Written in production" with tool, scope and target, under "Full access lifts the guard: it recorded these writes and did not stop them". Uncertain effects and an interrupted run's possible writes (owner only) use warning styling, never success. The PR is a link only for http(s) URLs, otherwise text. "Resume as new run" is offered for a run that failed `interrupted` with a recorded session id; other failed, timed-out or cancelled runs get "Retry as new run"; neither once a later run superseded it. A stale link shows "Run not found" |
| Run agent dialog | Step 1 recipe cards (Edits source / Changes files / Reads source / Notes only marker, time cap); step 2 permissions with side effects under Advanced, each saying what it requires (Push enables once Commit is ticked, a draft PR once Push is ticked and a PR provider exists), Access, a plain summary of what the run will do, prerequisite blockers and warnings | Access lists Autonomous (checked by default), Standard and Full access (with "No Quill guard; prod writes allowed; your Claude Code deny rules still apply."); "Advanced: other access and write scopes" holds "Use my Claude Code settings" and the Write scopes checklist, one option per catalog scope with what it permits, which credentials it switches to and a target field where it takes one; the details element opens itself while it holds the checked access. Write scopes are disabled with "Write scopes need Autonomous access: only its guard holds a run to them." under any other access. Below Access: "Connected tools this run can use" as the latest run's Claude Code reported them (a `needs-auth` server reads "Unavailable (needs auth)", an untrusted project server "Not trusted for autonomous runs"), the production command-line tools with their credential state, and warnings: no read-only credentials configured (a warning, never a blocker), a configured profile the latest run could not use, a shared Bedrock/Vertex sign-in, residual owner credentials and ignored scope settings. On a critical change's child ticket a warning says the ticked scopes are "a scope grant without a pinned action". The time cap shown is the worker's for the checked access. Recipes that need an approved action pin (`critical-change`) are never listed. Queue is disabled while a blocker applies and says why, including a checked scope with no credentials configured; a missing test command is a warning ("Not test-verified"), not a pass. Turn and spend caps are CLI options (`--max-turns`, `--budget`), not dialog fields. The bulk dialog offers Access without write scopes |
| Critical change item | In Runs → Needs you and the child ticket's Proposed runs: "Critical change · <child key> <title> · proposed by run <id8> of <parent key>", time, each scope as a warning chip "Write scope <name:target>", "Action:" with the exact pinned action as escaped code, Verify, Rollback and Risk lines when recorded, "Approve and queue (scopes: …)" and Dismiss | An owner-approved proposal, never a run that already happened: nothing writes until the owner approves on the dashboard. Every word came from an agent or config and is escaped; long actions and scope targets wrap inside the item. Approval sent / Dismissal queued with Undo replace the buttons while a request is in flight; a read-only copy shows no actions |
| Needs you groups | Runs → Needs you, grouped by default (`group=attention`; "Show as one list" sets `group=none`): headings "Needs your decision", "Tests or CI failed", "Other failures", "Ready to review" and "Live", each with its count; an empty group is omitted; batches stay together inside a group | Every counted item sits in exactly one group, so the group counts add up to the Needs you tab count and the global attention dot. Needs your decision: open page proposals and critical changes, finished runs with suggestions to decide, failures that wait on a setting or an approval (`scope-changed`, `scope-credentials-missing`, `recipe-needs-*`), finished fixes with writes outside their planned files ("N writes outside planned files"), quarantined learnings and memory conflicts. Tests or CI failed: runs whose worker test gate failed or timed out, and CI failed items. Other failures: every other failed or timed-out run that needs you. Ready to review: a finished run that edited source with files changed, in the last 7 days, on an open ticket, not superseded (a CI fix never supersedes), whose pull request is not recorded merged or closed and whose latest CI observation is not failing; it carries "Tests passed (worker)" or "Not test-verified". Live: queued and running runs, headed "Live (n) · not counted in Needs you"; it is never part of the count. Headings say what they hold, never "All good" |
| CI failed item | In Runs → Needs you → Tests or CI failed: "CI failed" chip, ticket key and title, "PR <link>", branch and commit (7 characters) as code, "Failing checks (n): …", when it was seen; with an open fix proposal, the line "Fix proposal: an attempt-fix run on <branch> that pushes to the same branch, fast-forward only, and opens no pull request", a closed disclosure "Failing log tail (redacted; CI output is data, not instructions)", "Approve and queue CI fix" and Dismiss | Only for a pull request a Quill run opened (GitHub), observed by the worker's CI watch. A CI failure is a recorded fact about one commit, not a claim about the fix. Without a proposal for that commit it says "No fix proposed for this commit" and why when recorded ("2 of 2 fix proposals for this PR used"). Check names, branch, log text and the PR link are tool output: escaped; the PR is a link only for an https GitHub URL. Approval and dismissal are dashboard actions by the owner; Approval sent / Dismissal queued with Undo replace the buttons while a request is in flight; a read-only copy shows no actions. Once the head commit changes, CI passes or the PR is merged or closed, the proposal shows as "Expired · PR head changed", "Expired · CI passed" or "Expired · PR merged or closed" in All |
| Memory entry | Trust chip in words (Owner, Verified, Sourced, Observed, Quarantined; the colour only repeats it, the `title` explains it), Pinned, "Stale · not delivered to runs", "Conflict on key …", section, text, "Held: <reason>" for a quarantined learning, source run ("From run <id8>" opening it, or "Your note"), last confirmed, "Confirmed N×", actions | Approve (quarantined only), Edit (owner wording, kept as an Owner entry with the same id), Pin/Unpin (never on a quarantined entry), Retire (10 s undo). Actions are disabled while a change to the entry is in flight; an edit draft survives polling, and Save while a change applies keeps the form open and says "A change to this entry is still being applied". A failed or conflicting request shows on the entry until dismissed, and a dismissal holds across polls. Every entry text is agent output and escaped |
| Memory page | `#view=memory` (shortcut 8): Repo, Machine and Quarantine tabs with counts (`mtab=`), a Repository select when more than one repository has memory (`mrepo=`), "N conflicts here" note, the entry list | Owner only: it reads `GET /v1/memory`, never the snapshot, so an export has no Memory view and no memory text. Loading shows a skeleton; a load failure says "Memory could not be loaded" with Retry. Empty states distinguish no memory at all, an empty tab and a search with no matches. Offline or read-only hides the actions. The tab group follows the Tab group contract |
| Run notes | Ticket detail → Runs tab: "Run notes (n)", one note per finished run that attempted something, with its reconciled attempts and the task lessons it filed | Owner only (`run_notes` never reaches an export); newest first; "N fields withheld: instruction-like text" when the worker withheld any; a page-proposed run's note says "From a run proposed on a shared page: never given to other runs." |
| Memory attention items | "Quarantined learning" (text, held reason, where, filed time, "Review in Memory") and "Memory conflict" (key, how many entries disagree, where, "Runs get only the higher-ranked one", "Resolve in Memory") in Runs → Needs you | Owner dashboard only; they count in the Needs you tab and the global attention dot; a static export has neither |
| Status button | One top-bar button: dot and short label (Updated …, provider errors, Offline, Needs attention, Read-only snapshot) opening a popover with connection, health and Refresh | Errors and offline colour the dot and label; offline with provider errors reads "Offline · N provider error(s)"; never hidden behind the popover |
| Filter button | "Filter · n" opening a popover of the existing filters; active filters stay visible as removable tokens | Same hash parameters as before |
| Navigation | Grouped Work (Pick next, Board, Runs) and Track (Activity, Sessions, Deployments, Relationships, Memory); phones show Pick next, Board, Runs, Activity and More, and More lists the rest, Memory included | Memory is owner-only: an export or read-only snapshot has no Memory item and `#view=memory` falls back. Its badge counts the entries the page lists (all three tabs); what needs review is counted by the Runs attention dot. The Runs badge counts live runs; a separate attention dot means "needs you"; shortcuts 1–6 unchanged, 7 opens Runs, 8 opens Memory. The Runs button's own `aria-label` carries the counts ("Runs, N live, K need(s) you") and the badge and dot are `aria-hidden`; other items read "<Label>, N items". The collapsed 72px rail keeps compact badges and the dot |
| Top bar | Brand, search, status button, then actions (approvals, Schedules, Publish, Export, theme, help) | Stays one row at every width: below 900px action text labels are hidden, each action keeps an `aria-label`, and the approvals button shows icon plus count |
| Status chip | Text + semantic color, optional dot/icon | Never communicate status with color alone; “Not test-verified” is not success |
| Attention item | What needs attention, affected entity, action | Separate run failures, test and CI failures, proposals, critical changes, CI fix proposals, suggestions, finished fixes ready to review, quarantined learnings, memory conflicts and blocked tickets; define count scope (Needs you groups) |
| Evidence panel | Source, captured time, status, content preview, full content access | Loading, unavailable, fetch error, retry; fetched content must visibly render |
| Form field | Persistent label, input, short help | Required/invalid state linked with `aria-describedby`; preserve draft after failure |
| Tab group | Labelled tabs and associated panels | Selected state, arrow/Home/End keys, roving tabindex; hide inactive panel controls |
| Drawer | Title, close, context, primary actions | Escape, focus placement/restoration; inert background and focus containment when modal |
| Empty state | Short title, explanation, relevant next step | Distinguish no data, no matches, no permission and offline; do not display invented metrics |
| Batch summary | Batch short id, recipe or "mixed", outcome counts across the whole batch, progress bar, "Cancel queued (n)" | Derived from run records, so it survives a reload; cancelling names only queued members and never claims running ones stopped. While members are queued and the batch's recorded spend (finished members' `cost_usd`, estimates included) has reached `meta.handoff_limits.batch_budget_usd`, the counts end with "Batch budget reached": the worker starts no further member, and the queued ones wait until cancelled |
| Toast/receipt | Action and confirmed outcome, LIVE chip, dismiss | Neutral and good receipts clear after 6 s; critical receipts stay until dismissed; never imply queued work has completed |

Prefer flat sections and separators. Use cards to group meaningful work units, not to enclose every label. Avoid nested cards within cards within cards.

## 6. Honest state language

These are separate concepts; do not merge their state machines:

| Entity | Examples | Must not imply |
| --- | --- | --- |
| Request | Sending, pending, applying, applied, conflict, failed | `applied` does not mean the agent finished |
| Run | Queued, running, done, failed, cancelled, timed out | `done` does not mean the ticket is done or deployed |
| Review obligation | Proposed, needs review, accepted, dismissed | “Needs review” is a UI-derived obligation, not a new run-state enum |
| Test gate | Passed, failed, timeout, skipped | Agent self-check is not worker verification |
| Session | Live, idle, ended, extinct | Live activity is not proof that a process is running |
| Deployment | Pending, recorded deployed, waived | Merged PR is not deployment |
| Run access | Autonomous, Autonomous + scopes (n), Full access | Autonomous is not unrestricted (the guard decides every call); Full access writes are recorded, not prevented |
| Recorded stage | Recorded: tested, committed, pushed, PR opened | The agent's `stage_reached` is a claim; a claim above the record reads "(not recorded)"; the worker's floor (investigated) is never shown as recorded |
| Critical change | Proposed, approved, dismissed, expired | A proposed critical change has not happened; approval queues one run limited to the pinned action, and that run's `done` does not mark the child ticket done |
| Memory trust | Owner, verified, sourced, observed, quarantined | Sourced means the cited line exists, not that the claim is true; observed is the agent's word; quarantined is never delivered to runs |
| CI observation | Failing, pending, passing, no checks | Recorded for one commit of a Quill-opened PR; "passing" is CI's word, not the test gate's; a failing check is not a failed run |
| Cost | ≈ $N (estimated), $N | Under a claude.ai subscription the cost is an estimate, not a bill |

Examples the shipped UI produces:

- "Queued · read-only slots 2/2 in use" — occupancy, not a claimed cause.
- "Queued · fix slots 1/1 in use · repository busy" — only for a queued fix.
- "Running for 2 min · setup 4 s" — the worker records agent and test time only when a run finishes, so a running row never names a phase.
- "Tests passed (worker)" / "Not test-verified" / "Tests failed".
- "2 suggestions to review".
- "Retried as a new run" / "Superseded by a later run".
- "Cancel queued (3)" when running members are unaffected.
- "Recorded: PR opened · agent reports: deployed (not recorded)"; with nothing recorded above the floor, "Agent reports: verified (not recorded)" and "The worker saw no test gate pass, commit, push or pull request for this run."
- "47 turns · ≈ $1.87 (estimated)" under a subscription; "$0.42" only when the run had an API key (`cost_estimated: false`).
- "Refused (no scope)", "Unavailable (needs auth)", "Not verified", "Claimed, no tool call seen".
- "Critical change · PROJ-12 Sync payments to staging · proposed by run 1a2b3c4d of PROJ-7" with "Approve and queue (scopes: argo.sync:pay-stg)": an owner-approved proposal with an exact pin, not a change that ran.
- "Production write allowed (outcome not recorded)" under "Production writes (full access)": a call the observe-mode guard allowed and recorded, never prevented; whether it succeeded is not recorded, so the label never says it was written.
- "kubectl apply on stg may have run" (owner dashboard) and "1 production write may have run" (exports), for an interrupted run's guard-allowed writes.
- "Batch budget reached" on a held batch member and its batch summary.
- "Resume as new run" for an interrupted run with a recorded session; "Retry as new run" otherwise.
- "Held: instruction-like text (…)" on a quarantined learning; "Stale · not delivered to runs".
- "CI failed" on a CI item, "Failing checks (2): test (ubuntu), lint" and "Approve and queue CI fix": a failure CI recorded on one commit and a proposal; nothing runs until the owner approves.
- "Ready to review" with "Tests passed (worker)" or "Not test-verified": a finished fix whose changes wait for the owner, never "done" or "merged".
- "Live (3) · not counted in Needs you".

A row or chip states only what the snapshot records. When the worker starts projecting live phases or wait reasons, add them here first, then to the UI.

Avoid “All good”, “Success!” or “Completed” without an entity. Show measured durations; never fabricate progress percentages or ETAs for unknown agent work.

## 7. Orchestration information architecture

**Shipped:** Pick next, Board, Runs, Activity, Sessions, Deployments, Relationships, Memory. Runs (`#view=runs`, shortcut 7) has Needs you, Live, Failed and All tabs (`tab=`), rows grouped by batch, and run detail in the side panel (`run=`). Needs you holds open proposals (page proposals and critical changes), finished runs with suggestions to decide, failed or timed-out runs from the last 7 days on open tickets that no later run superseded, quarantined learnings (one item each), memory conflicts (one item per key), CI failed items (one per Quill-opened PR whose latest CI observation is failing, while no fix proposal for that commit was approved or dismissed) and finished fixes ready to review; cancelled runs never need you; exports have no Needs you. Needs you is grouped by default (Needs you groups, `group=`); the Live group inside it is shown but never counted. The Needs you tab count and the global attention dot count that same unfiltered set, memory items included; with filters, memory items show only under a repository filter alone, and only that repository's. Memory (`#view=memory`, shortcut 8, under Track) is owner-only and absent from exports. Ticket detail has Overview, Runs, Activity and Delivery tabs (`section=`) and a run strip under the title; the Runs tab carries the ticket's Run notes. Proposed runs, critical changes included, live in Runs → Needs you and the ticket's Runs tab; Activity is history only. Internal route names `tree` and `today` remain.

A CI fix is a proposal too: the worker watches the checks of pull requests Quill runs opened (GitHub, the last 7 days), records each change as a CI observation, and for a failing commit stages at most one fix proposal (two per pull request) carrying a redacted log tail of at most 4096 characters. Only the owner's **Approve and queue CI fix** on the dashboard queues the run, which checks out that commit, pushes to the same branch fast-forward only and never to a protected branch.

A critical change is a proposal, never an action already taken: an autonomous run that needs a write outside its scopes records it, the worker turns it into a local-only child ticket and a run-origin proposal with an exact action pin, and only the owner's **Approve and queue** on the dashboard starts the one run allowed to make it. The approved run's guard allows that exact action and nothing else in its scopes.

**Not yet built:** worker-projected phases and wait reasons, readiness checks the snapshot cannot answer, prewarmed worktrees, nested run groups, turn and spend fields in the Run dialog (CLI only), the live phase and verify outcome of an approved critical run on its Needs you item.

Recommended Runs workflow:

1. Choose work and recipe.
2. Review prerequisites, source access, worker test configuration and side effects.
3. Queue; show the request acknowledgement separately from execution state.
4. Monitor authoritative phase/wait reason and cancellation scope.
5. Inspect result, diff, worker test output and uncertain side effects.
6. Accept/dismiss suggestions or retry as a new run with an explicit relationship to the previous attempt.

Do not hide execution controls deep below a description. Do not label an Activity tab as the place for run history if it only contains ticket timeline events. Global attention counts must link to the same unfiltered set, or be labelled/filtered consistently.

Repository bindings belong to the checkpoint/event that recorded them. A session's current ticket must not overwrite the meaning of a historical checkpoint preview.

## 8. Interaction, accessibility and responsiveness

- Keep the first recommended ticket and its action visible at 1280×720 with typical data. Test actual content, not just an empty fixture.
- Test at 390×844, 1024px, 1280×720 and 1440×900. Constrain document overflow; horizontally scrolling filters/tables must remain visibly usable.
- Preserve every authorized action on narrow layouts. Move secondary navigation to an explicit menu rather than shrinking labels indefinitely.
- Use native buttons/inputs and visible focus. Do not add nested interactive elements inside a button. A clickable article with separate inner actions needs deliberate keyboard behavior.
- Polling must preserve drafts, focused controls, expanded evidence, selected tabs and scroll. Re-rendering must not repeatedly announce unchanged health.
- Use stable identities for records and disclosure state; do not key important state solely by array position.
- Use live regions for meaningful request/run transitions; provide persistent inline failure details.
- Use 160–200ms feedback and 200–300ms user-triggered transitions. Animate opacity/transform only where useful; respect reduced motion.
- Never animate every polling update. Skeletons are for unresolved loading, not a substitute for an error or empty state.
- Runs rows, the run detail panel, Needs you items, the Run agent dialog and the Memory page must fit 390px with no document overflow and no item wider than its container; scope targets, memory keys, commands and tool names are agent or config text of any length and must wrap (the 1.1 release browser check asserts both).
- Test text zoom, long titles/keys, keyboard-only interaction, disabled controls and real touch target dimensions.

## 9. Implementation rules

1. Read relevant existing renderers and tests before changing markup. Reuse `esc`, `attr`, `icon`, `timeEl`, `statusChip`, `requestFeedback`, and snapshot normalization.
2. Escape all record and tool-output text. Do not concatenate trusted-looking run output as HTML.
3. Preserve capability checks for mutations and static exports. No secrets/private paths in routes, screenshots, generated assets or example data.
4. Preserve revision checks, pending versus confirmed state, undo deadlines, clone approval and per-action side-effect permissions.
5. Do not use an illustration, loading animation or green badge to mask unknown evidence.
6. Do not import `tokens.css`/`components.css` into production just to use one new asset. Existing components should continue using current tokens; opt in deliberately for new surfaces.
7. Generated theme files must come from `node scripts/build-ui-assets.mjs`. Edit the source styles/generator, then regenerate. Do not hand-edit token exports or generated SVGs.
8. UI color/spacing changes belong in the existing styling system. The reference page may use inline custom properties for token demonstrations; that is not a general production style convention.
9. Keep dependencies unchanged unless the task truly needs one. This kit uses browser APIs and Node built-ins.
10. Verify that new asset paths are served by the app before referencing them in production. The design reference uses a repository-root static server; the worker may have a narrower asset allowlist.

## 10. Delivery checklist

- Confirm scope: production change, design reference, or proposed feature.
- Run `node scripts/build-ui-assets.mjs --check` for generated-asset drift.
- Run `node scripts/build-ui-assets.mjs --check` after any `ui/styles.css` token change; regenerate with `node scripts/build-ui-assets.mjs` when it reports drift.
- Run `node --test "tests/ui/*.test.js" "tests/export/*.test.js"` after interface changes.
- Add behavior tests for new state transitions or evidence/ownership fixes; avoid tests that only mirror trivial style declarations.
- Browser-check light/dark, mobile/desktop, keyboard, long data, loading, error, empty, offline and read-only states relevant to the change.
- Verify icon/illustration SVGs, missing files, broken links, zero console errors and no runtime dependencies accidentally introduced.
- Update screenshots and user-facing docs when navigation or flows change.
- Report what is implemented, what is proposed, and what was actually tested. Asset creation is not completion of the orchestration-engine roadmap.

## 11. Suggested Claude task preamble

> Implement the requested Quill UI change using the Fieldnotes design system in `docs/design-system/CLAUDE-DESIGN-SYSTEM.md`. Preserve the current green/Geist identity, existing state and permission contracts, and static-export privacy. Reuse current renderers and assets. Distinguish shipped behavior from proposed Runs patterns. Verify the affected user flow at laptop and mobile sizes, including keyboard and failure states, and report the exact tests run.
