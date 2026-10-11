# Quill UI implementation guidance

For UI, UX, visual assets, or orchestration interface work, read:

@docs/design-system/CLAUDE-DESIGN-SYSTEM.md

Use `docs/design-system/index.html` as the visual reference and `ui/assets/README.md` for asset integration. The design system is Quill's own Fieldnotes identity; it is not Anthropic's Claude brand or an official Claude component library.

Before editing, inspect the working tree and relevant existing renderers/tests. Preserve unrelated changes. Use the existing Node ES modules and CSS stack. Production behavior and safety contracts are defined in the data contract and orchestration ADRs; a visual specimen does not authorize a backend behavior change.

For the current implementation state and known defects, read `docs/AGENT-HANDOVER-ORCHESTRATION-1.0.md`. Recommendations in that document are not implemented features. The Runs page, run detail, ticket Runs tab and Run agent dialog are shipped; their contract is §5–§7 of the design system. Asset or specimen changes alone do not change that behaviour.

After asset-source changes, run `node scripts/build-ui-assets.mjs`, then `node scripts/build-ui-assets.mjs --check`. For interface changes, run the relevant UI/export tests and browser checks documented in the design system. Use an isolated dev-seed store for demos.
