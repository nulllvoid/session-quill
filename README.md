# Session Tracker — docs

Design documents for **Session Tracker**: a public Claude Code plugin that gives every developer their own session tracker — no write without a ticket, every session logged to the developer's own notes (markdown folder or Obsidian vault) and tagged to the real project, plus a personal dashboard with status, pick-next and a one-click agent handoff.

Working name `session-tracker`; final name, licence (MIT proposed) and repo home are open questions.

## Documents

| Doc | What it answers | Live, editable copy |
| --- | --- | --- |
| [docs/PRD.md](docs/PRD.md) | Why, for whom, what must be true (goals, metrics, scope, requirements, release plan, risks) | — |
| [docs/TRD.md](docs/TRD.md) | How it is built: architecture, note schema, ticket gate, capture hooks, interval agent, handoff agent, packaging, migration, rollout | [Claude Doc](https://claude.ai/code/artifact/e7c5396d-215e-40fd-8e8a-37cb7f1ee220) |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | Brief for the designer: users, principles, screen map, data, screens, components, interactions, visual system, deliverables | [Claude Doc](https://claude.ai/code/artifact/5aac569c-9868-4eb4-92eb-b79cf1bf295c) |
| [docs/decisions/](docs/decisions/) | Architecture decision records | — |
| [docs/diagrams/](docs/diagrams/) | Rendered diagrams (PNG) from the live docs; Mermaid sources are inline in the markdown | — |

The live Claude Docs are the editing surface (comments, inline edits); the markdown here is the committed snapshot. Re-export after meaningful changes and commit.

## Layout

```
docs/
  PRD.md            product requirements
  TRD.md            technical requirements and design
  UI-DESIGN.md      UI design spec for the designer / design agent
  decisions/        ADRs, one file per decision
  diagrams/         architecture, handoff-flow, rollout, screen-map, board-wireframe (PNG)
```

## Status

Draft v0.1, 2026-10-02. Build has not started; the open-questions checklist at the end of the TRD gates phase 1.
