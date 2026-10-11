# Quill Fieldnotes

The design system for Quill's ticket and agent-orchestration UI.

- [Claude implementation contract](docs/design-system/CLAUDE-DESIGN-SYSTEM.md)
- [Interactive visual reference](docs/design-system/index.html)
- [Asset usage and provenance](ui/assets/README.md)
- [Token map](ui/assets/tokens.json)
- [Asset manifest](ui/assets/manifest.json)
- [Current implementation and scope gaps](docs/AGENT-HANDOVER-ORCHESTRATION-1.0.md)

Preserve the evergreen/Geist identity implemented in `ui/styles.css`. Historical Graphite Ink and Terminal Slate boards in `docs/ui/` are archived references, not the current visual direction. The older `docs/UI-DESIGN.md` remains useful for behavior contracts; its superseded layout descriptions must be read alongside the current design contract.

The reference kit is opt-in; the production dashboard keeps its own stylesheet. The Runs page and run detail are shipped (see §7 of the contract).

```sh
node scripts/preview-design-system.mjs
```

Open the printed localhost URL to use the SVG catalog, theme switch, and interactive state examples. The read-only preview serves only design-related files and does not start Quill's worker. Use `--port 0` to select an available port.
