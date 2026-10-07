# ADR 0017 — Run access levels: standard, my settings, full

Date: 2026-10-07 · Status: accepted · Builds on [ADR 0008](0008-agent-recipes.md) and [ADR 0012](0012-agent-run-logs-and-context.md) (draft)

## Context

Handoff and recipe runs used a narrow fixed tool profile: read, edit in the checkout, run tests, read-only git, everything else refused, and no connectors. An interactive session can do much more, because the owner approves what it asks for as it goes. The owner asked for agents to have the same access as Claude, and chose two levels: their own Claude Code settings by default, and an opt-in full access for runs where they want no limits.

## Decision

- **Three levels, chosen per run.** `access` is part of the run request:
  - `standard`: Quill's profile as before (`--permission-mode dontAsk` with explicit allow and deny lists, the recipe's `tools` narrowing).
  - `settings`: the owner's Claude Code permission rules, settings files and connected MCP servers decide (`--permission-mode default`, no Quill allow list). With nobody to approve, anything that would need approval is refused. Fix runs use `acceptEdits`, so edits inside the isolated checkout go through. The run's side-effect permissions still gate what Quill always gated: without them, `git commit`, `git push` and `gh pr create` are denied, and `gh pr merge`, `git merge`, force pushes and checking out the default branch are always denied. Without edit permission, edit tools are denied.
  - `full`: no permission checks (`--permission-mode bypassPermissions`), and provider credentials stay in the agent's environment. The prompt tells the agent the limits are its own to keep.
- **Defaults.** The dashboard's Run dialog and handoff form preselect *My Claude Code settings*; `quill agent run` and `quill handoff` default to `--access settings`. A request that names no level is standard, so scheduled runs and requests queued before this change keep the narrow profile.
- **Full access is visible.** It is a separate choice marked as a warning in both dialogs, the CLI prints a warning when it is used, and the run shows a "Full access" chip (settings runs show "My settings").
- **Not for every run.** File runs (ADR 0015) are always standard, because their staging and undo rely on the agent never reaching the originals. Schedules never request access beyond standard. The self-check turn (ADR 0013) is always read-only, whatever the level.
- **Checked live** against Claude Code on Windows: in `settings`, the agent saw the owner's connectors (Gmail, Calendar, Jira, Docs), ran a read-only command, and had a file-writing command refused with "This command requires approval" in about nine seconds, without hanging; in `full`, commands ran without checks.

## Consequences

- Settings-level runs can use connectors such as Jira or docs for context, which ADR 0012 proposed, without a separate connector permission; what they may do with them is whatever the owner's settings already allow.
- A settings-level run's reach changes when the owner's settings change, and connectors that send messages (email, chat) are usable if the owner pre-approved them.
- A full-access run can do anything the owner can, including on other repositories and accounts. It is never the default and never scheduled.
- Recipe `tools` lists narrow standard runs only.

## Alternatives considered

- **Full access as the default.** Rejected: a click in the dashboard would run an unattended agent with no checks at all.
- **A separate connector permission.** Rejected for now: the owner's own settings already say which connector tools are approved.
- **Prompting the owner through the dashboard for each approval.** Rejected for now: runs are unattended by design; a run that waits for approval would hold its slot until the deadline.
