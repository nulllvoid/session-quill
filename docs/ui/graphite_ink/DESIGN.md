# Graphite Ink

The dashboard's visual system since the 2026-10 redesign. It replaces [Terminal Slate](../terminal_slate/DESIGN.md) and keeps the same token names, so `tests/ui/tokens.test.js` still checks every foreground and background pair for WCAG AA in both themes.

## Principles

- **Warm graphite, one accent.** The neutrals share a single warm hue. The only accent is a highlighter lime (`--accent-fill`). The active view, the top Pick next candidate, the next-action rule and primary buttons use it. Status colours tell statuses apart and are never used for decoration.
- **Hairlines over boxes.** Containers are separated by 1px inset hairlines (`--hairline`, `--hairline-strong`) and spacing, not grey borders nested inside each other. Shadows are diffuse and tinted to the background.
- **One radius scale.** Large containers 16px, cards 12px, controls 8px, chips and keys 6px.
- **Type.** Geist and Geist Mono variable fonts, vendored in `ui/fonts/` under the SIL OFL (`ui/fonts/OFL.txt`), since the CSP allows only same-origin fonts and the dashboard works offline. Exported snapshots fall back to the system stack. Mono is reserved for keys, identifiers, endpoints and numbers. Labels use sentence case, not mono capitals.
- **Compact chrome.** A floating top bar (search, endpoint, actions), then one status line (health, receipt, refresh), then the filters. The brand and the workspace details live in the sidebar.
- **No dashes in UI copy.** Separators are colons, parentheses or sentences; an empty cell shows a muted hyphen labelled "none" for screen readers.
- **Board cards drop the status chip.** The column already names the status, so a card shows only the stale flag.
- **Motion is feedback only.** Cards rise in once on first paint (`body[data-ready]` stops polls from replaying it), the detail panel and dialogs slide in, and buttons press in. Everything runs on `--ease`/`--ease-press` and switches off under `prefers-reduced-motion`.
