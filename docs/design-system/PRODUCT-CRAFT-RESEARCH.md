# Session Quill: product craft direction

Date: 2026-10-30. Status: researched proposal, not implemented or usability-validated.
The user rejected the current Afterhours execution. Its palette and shell are experiments, not the accepted visual destination. Preserve existing work while revising the experience.

## Product thesis

Quill should feel like a personal software studio: understand the outcome, direct agent work, inspect evidence, and resume without reconstructing context. A vibe coder is the stated audience; the workflow hypotheses below still require observation with real users. Do not assume age, technical ability, or taste from that label.

The existing v2.3 Work hierarchy, execution intents, reviewed plan revisions and Daily continuity already support this direction. Keep their semantics. This is not a proposal to replace the runtime or add a general-purpose graph editor.

## Specific diagnosis

The supplied screenshot puts filters, three summary metrics, lenses and table headings ahead of the work. Parent and child titles are almost aligned; the shaded child region looks like another table section. “Classify relationships” describes a maintenance operation without explaining its consequence. Repeated priority and status controls compete with the next useful action. The new shell and older work renderer have different visual rhythms.

The current styling adds identity but does not substantially improve comprehension or continuity. A decorative Afterhours label cannot carry product differentiation.

## Research and application

These are design inferences from published guidance, not evidence that these products' patterns have been tested in Quill.

| Reference | Relevant finding | Quill application |
| --- | --- | --- |
| [Apple: Layout](https://developer.apple.com/design/human-interface-guidelines/layout) | Alignment, indentation, grouping and progressive disclosure explain relationships. | Make each child visibly subordinate; retain the parent context when opening details. |
| [Apple: Motion](https://developer.apple.com/design/human-interface-guidelines/motion) | Purposeful, brief, optional motion communicates feedback without slowing frequent actions. | Animate disclosure and pane transitions only where they preserve orientation; honor reduced motion. |
| [Linear: 2026 refresh](https://linear.app/now/behind-the-latest-design-refresh) | Quiet navigation, predictable actions and restrained separators keep attention on content. | Reduce toolbar layers, repeated icons and row chrome; give selected work the strongest emphasis. |
| [Warp: multiple agents](https://docs.warp.dev/guides/agent-workflows/how-to-run-multiple-ai-coding-agents) | Parallel work benefits from clear ownership, attention notifications and inspectable outputs. | Surface the responsible run, its latest real event and the evidence needed for a decision. |
| [Raycast: Action Panel](https://developers.raycast.com/api-reference/user-interface/action-panel) | Contextual actions can be grouped and exposed with predictable shortcuts. | Give selected work one obvious primary action and a discoverable secondary action menu. |
| [Cloudscape: Theming](https://cloudscape.design/foundation/visual-foundation/theming/) | Supported global customization covers typography, colors and radii, not arbitrary component-instance changes. | Use supported Cloudscape controls and tokens; compose Quill-specific work content without overriding private component internals. |

## Signature experiences

### 1. Resume with context

On returning, provide a compact, dismissible account of relevant changes, decisions and the next actionable item, with links to source evidence. Reuse Daily update continuity where available. If no saved summary exists, show factual state and an explicit generation action rather than silently inventing a recap. Preserve the selected task and expansion state.

### 2. Understand the work at a glance

Keep the expandable outcome list. Give parent rows stronger typography and a concise remaining-work statement. Indent children by a visible 20–24 px starting point, with a restrained connector terminating at the last child. Align their controls consistently within the child branch. Use spacing and grouping as well as color.

Required subtasks, independent follow-ups and unknown relationships must remain distinct. Replace the generic unknown-group heading with “2 relationships need a decision” plus “Choose whether these tasks are required to finish this outcome.” A child with unknown classification must never inherit a required label. Show all-child count separately from required completion.

Illustrative structure, not sample production data:

```text
Preserve session checkpoints                 Needs review
2 child tasks · relationship decisions pending
  │
  ├─ Torn journal tail verification           To do
  │  Relationship not classified
  └─ Durable ingress journal                  Done
     Relationship not classified
```

At deep levels, offer a focused subtree with ancestry breadcrumbs; do not silently flatten or drop descendants. Preserve semantic nested lists and disclosure behavior unless implementing a complete tree keyboard model.

### 3. Review without rebuilding context

On selection, open a stable detail pane with the outcome, current blocker, relevant run and available evidence. Bring existing plan, result and source links together. Embedded diffs or app previews are later capabilities only if their backing data and secure rendering exist; they must not appear as working affordances in a visual prototype.

Keep process success, test evidence, manual Done status and readiness to close distinct. Contextual actions may say Review plan, Inspect result or Run agent only when their actual conditions support them.

## Visual direction: precise, personal, calm

Use a warm paper light theme and neutral graphite dark theme with a restrained iris accent. Start with 15 px task titles, 13 px supporting text and 24–28 px page titles; adjust using real content and zoom rather than compressing to fit. Use one spacing rhythm and shared control heights across the shell and work content. Avoid full-row lavender washes and unnecessary nested cards.

The personality comes from a recognizable Quill mark, optional accent choice, thoughtful empty states and crisp interactions. Use plain, confident language. Keep playful artwork away from errors, permissions and verification results. Avoid a permanent decorative slogan consuming workspace space.

Desktop composition: quiet navigation, one compact workspace toolbar, outcome list and an optional detail pane. Replace the current large metric band with a small factual sentence. Preserve existing destinations and deep links. On phones, show list or detail, with Back restoring position.

## Quality gates for the next implementation

These are acceptance targets, not measurements already achieved.

- A first-time reader can identify a parent, its children and why completion is blocked without opening every row. Test this with representative users; internal inspection is not a substitute.
- At 1366×768, show at least six collapsed parent outcomes below navigation and filters.
- Verify 390, 768, 1024, 1366 and 1440 px widths, both themes and 200% zoom; no obscured actions or page-wide horizontal scrolling.
- Verify long titles, empty work, a thousand siblings, deep nesting, unknown relationships, reopened descendants, stale results and worker disconnection.
- Polling preserves focus, selection, expansion, scroll and drafts. Navigating to a different view starts at the intended position; returning to work restores context.
- Keyboard can expand, select, inspect, act and return. Escape dismisses overlays and restores focus. Actions do not depend on hover.
- Measure text and control contrast on their actual surfaces. Status has text or shape alongside color. Reduced motion removes nonessential transitions.
- A click produces immediate visible feedback; pending mutations remain visibly pending until confirmed. Undo and errors remain discoverable.
- No fabricated completion percentages, invented agent activity or silent elevation of execution permissions.
- Review real-content screenshots side by side before broadening implementation. Validate light mode as carefully as dark mode.

## Delivery order

1. Prototype the shell and Work list with actual representative hierarchy data, expanded and collapsed, both themes. Resolve parent-child comprehension first.
2. Implement and verify that vertical slice while preserving latest v2.3 behavior and routes.
3. Refine selection and the evidence/detail pane, then the composer and result handoff.
4. Add continuity presentation using existing supported data. Clearly separate any backend extensions into later work.

The current code remains work in progress. This document does not certify the prior shell, resolve the reported hierarchy problem, or claim that all tests pass.
