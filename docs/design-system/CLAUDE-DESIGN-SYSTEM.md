# Quill Fieldnotes — Claude design system

Version 1.0 · 11 October 2026 · Quill-owned design language.

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
| `docs/DATA-CONTRACT.md`, orchestration ADRs 0022–0025 | State meanings, permissions, verification, execution and privacy |
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
| Run row | One `<button>` per run: state chip, ticket key (middle-ellipsised, full key in `title`) and title, recipe or mode, access badge (Read-only / Edits source / Changes files, plus Full access when granted), worker test-gate badge, one fact line, requested time | The fact line states only recorded facts: queued → "Queued" plus slot occupancy from `meta.handoff_limits`, and "repository busy" for a queued fix whose repository has a running fix; running → "Running for under a minute" or "Running for N min" (whole minutes, so the row changes at most once a minute) and "setup …" when measured; done → suggestions to review, files changed, draft PR; failed → the error (else "Tests failed" / "Tests timed out" from the test gate, else "Failed") plus "Retried as a new run" or "Superseded by a later run". Nothing interactive nests inside the row button |
| Run strip | Under the ticket title: the current run (else the latest) with state, recipe, test-gate badge, suggestions to review and time; opens run detail | "No agent runs yet" when there are none (owner only, ticket not done); Run agent stays in the status controls |
| Run detail | Header (state, recipe and source, mode, access, test gate, measured timings, batch, retry relationship); Result; Changes; Delivery (PR, branch, uncertain effects); Where it is (owner-only checkout path as text with copy, never a link); Suggestions; actions | Sections absent from the record or stripped by an export are omitted, never rendered empty; the PR is a link only for http(s) URLs, otherwise text; uncertain effects use warning styling, never success; "Retry as new run" is not offered once a later run superseded the failed one; a stale link shows "Run not found" |
| Run agent dialog | Step 1 recipe cards (Edits source / Changes files / Reads source / Notes only marker, time cap); step 2 permissions with side effects under Advanced, each saying what it requires (Push enables once Commit is ticked, a draft PR once Push is ticked and a PR provider exists), a plain summary of what the run will do, prerequisite blockers and warnings | Queue is disabled while a blocker applies and says why; a missing test command is a warning ("Not test-verified"), not a pass |
| Status button | One top-bar button: dot and short label (Updated …, provider errors, Offline, Needs attention, Read-only snapshot) opening a popover with connection, health and Refresh | Errors and offline colour the dot and label; offline with provider errors reads "Offline · N provider error(s)"; never hidden behind the popover |
| Filter button | "Filter · n" opening a popover of the existing filters; active filters stay visible as removable tokens | Same hash parameters as before |
| Navigation | Grouped Work (Pick next, Board, Runs) and Track (Activity, Sessions, Deployments, Relationships); phones show Pick next, Board, Runs, Activity and More | The Runs badge counts live runs; a separate attention dot means "needs you"; shortcuts 1–6 unchanged, 7 opens Runs. The Runs button's own `aria-label` carries the counts ("Runs, N live, K need(s) you") and the badge and dot are `aria-hidden`; other items read "<Label>, N items". The collapsed 72px rail keeps compact badges and the dot |
| Top bar | Brand, search, status button, then actions (approvals, Schedules, Publish, Export, theme, help) | Stays one row at every width: below 900px action text labels are hidden, each action keeps an `aria-label`, and the approvals button shows icon plus count |
| Status chip | Text + semantic color, optional dot/icon | Never communicate status with color alone; “Not test-verified” is not success |
| Attention item | What needs attention, affected entity, action | Separate run failures, proposals, suggestions and blocked tickets; define count scope |
| Evidence panel | Source, captured time, status, content preview, full content access | Loading, unavailable, fetch error, retry; fetched content must visibly render |
| Form field | Persistent label, input, short help | Required/invalid state linked with `aria-describedby`; preserve draft after failure |
| Tab group | Labelled tabs and associated panels | Selected state, arrow/Home/End keys, roving tabindex; hide inactive panel controls |
| Drawer | Title, close, context, primary actions | Escape, focus placement/restoration; inert background and focus containment when modal |
| Empty state | Short title, explanation, relevant next step | Distinguish no data, no matches, no permission and offline; do not display invented metrics |
| Batch summary | Batch short id, recipe or "mixed", outcome counts across the whole batch, progress bar, "Cancel queued (n)" | Derived from run records, so it survives a reload; cancelling names only queued members and never claims running ones stopped |
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

Examples the shipped UI produces:

- "Queued · read-only slots 2/2 in use" — occupancy, not a claimed cause.
- "Queued · fix slots 1/1 in use · repository busy" — only for a queued fix.
- "Running for 2 min · setup 4 s" — the worker records agent and test time only when a run finishes, so a running row never names a phase.
- "Tests passed (worker)" / "Not test-verified" / "Tests failed".
- "2 suggestions to review".
- "Retried as a new run" / "Superseded by a later run".
- "Cancel queued (3)" when running members are unaffected.

A row or chip states only what the snapshot records. When the worker starts projecting live phases or wait reasons, add them here first, then to the UI.

Avoid “All good”, “Success!” or “Completed” without an entity. Show measured durations; never fabricate progress percentages or ETAs for unknown agent work.

## 7. Orchestration information architecture

**Shipped:** Pick next, Board, Runs, Activity, Sessions, Deployments, Relationships. Runs (`#view=runs`, shortcut 7) has Needs you, Live, Failed and All tabs (`tab=`), rows grouped by batch, and run detail in the side panel (`run=`). Needs you holds open proposals, finished runs with suggestions to decide, and failed or timed-out runs from the last 7 days on open tickets that no later run superseded; cancelled runs never need you; exports have no Needs you. Ticket detail has Overview, Runs, Activity and Delivery tabs (`section=`) and a run strip under the title. Proposed runs live in Runs → Needs you and the ticket's Runs tab; Activity is history only. Internal route names `tree` and `today` remain.

**Not yet built:** worker-projected phases and wait reasons, readiness checks the snapshot cannot answer, prewarmed worktrees, nested run groups.

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
- Runs rows and the run detail panel must fit 390px with no document overflow (the runs-first browser check asserts it).
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
