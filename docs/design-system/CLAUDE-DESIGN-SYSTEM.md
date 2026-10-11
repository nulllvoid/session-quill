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
| `docs/design-system/index.html` | Inspectable component examples and proposed orchestration patterns |
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
| Run row | Recipe, ticket, execution state, phase/wait reason, elapsed time, next decision | Queued, running, completed, failed, cancelled, timed out; loading/unknown must be explicit |
| Status chip | Text + semantic color, optional dot/icon | Never communicate status with color alone; “Not test-verified” is not success |
| Attention item | What needs attention, affected entity, action | Separate run failures, proposals, suggestions and blocked tickets; define count scope |
| Evidence panel | Source, captured time, status, content preview, full content access | Loading, unavailable, fetch error, retry; fetched content must visibly render |
| Form field | Persistent label, input, short help | Required/invalid state linked with `aria-describedby`; preserve draft after failure |
| Tab group | Labelled tabs and associated panels | Selected state, arrow/Home/End keys, roving tabindex; hide inactive panel controls |
| Drawer | Title, close, context, primary actions | Escape, focus placement/restoration; inert background and focus containment when modal |
| Empty state | Short title, explanation, relevant next step | Distinguish no data, no matches, no permission and offline; do not display invented metrics |
| Batch summary | Aggregate execution counts, member outcomes, link to detail | Durable after reload; cancellation scope must name queued versus running members |
| Toast/receipt | Action and confirmed outcome | Supplement inline feedback; never imply queued work has completed |

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

Use explicit copy:

- “Queued. Waiting for the payments repository.”
- “Tests passed (worker).”
- “No test command. This fix is not test-verified.”
- “Run finished. Two suggestions need review.”
- “Worker offline. Showing the last snapshot.”
- “Cancel 3 queued runs” when active runs are unaffected.

Avoid “All good”, “Success!” or “Completed” without an entity. Show measured durations; never fabricate progress percentages or ETAs for unknown agent work.

## 7. Orchestration information architecture

**Shipped:** Pick next, Board, Relationships, Sessions, Deployments, Activity; ticket Overview/Activity/Delivery tabs. Internal route names `tree` and `today` remain for compatibility.

**Proposed:** a global Runs surface and an explicit ticket Runs section. The reference page's Agent runs specimen is an example with static data. It does not add routes, backend phases, capacity projections or result viewers to the app.

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
- Run `node --test "tests/ui/*.test.js" "tests/export/*.test.js"` after interface changes.
- Add behavior tests for new state transitions or evidence/ownership fixes; avoid tests that only mirror trivial style declarations.
- Browser-check light/dark, mobile/desktop, keyboard, long data, loading, error, empty, offline and read-only states relevant to the change.
- Verify icon/illustration SVGs, missing files, broken links, zero console errors and no runtime dependencies accidentally introduced.
- Update screenshots and user-facing docs when navigation or flows change.
- Report what is implemented, what is proposed, and what was actually tested. Asset creation is not completion of the orchestration-engine roadmap.

## 11. Suggested Claude task preamble

> Implement the requested Quill UI change using the Fieldnotes design system in `docs/design-system/CLAUDE-DESIGN-SYSTEM.md`. Preserve the current green/Geist identity, existing state and permission contracts, and static-export privacy. Reuse current renderers and assets. Distinguish shipped behavior from proposed Runs patterns. Verify the affected user flow at laptop and mobile sizes, including keyboard and failure states, and report the exact tests run.
