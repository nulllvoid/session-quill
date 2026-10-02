# Session Tracker — Product Requirements (PRD)

Status: draft v0.1 · 2026-10-02 · Owner: Shivam
Companion docs: [TRD](TRD.md) (how it is built) · [UI design spec](UI-DESIGN.md) (how it looks and behaves) · [Decisions](decisions/)

## One-line summary

A public, installable Claude Code plugin that gives every developer their own session tracker: no write happens without a ticket, every session's work is logged to the developer's own notes (markdown folder or Obsidian vault) tagged to the real project, and a personal dashboard shows status, what to pick next, and a one-click handoff to an agent.

## Problem

Developers working with Claude Code run several sessions in parallel and switch between them constantly. Sessions get closed, compacted or forgotten with useful work inside them: analysis that was approved, plans that were agreed, files that were changed, PRs that were raised but never deployed. Nothing ties a session to the ticket or project it served, so traceability is lost and the same ground gets covered twice.

Existing fix: Shivam's PMLA Delivery Tracker (Claude Code hooks → Obsidian vault → daily agent → tracker artifact). It works, but it is hand-built for one person and one class of work (vulnerability tickets) and cannot be given to anyone else.

## Users

| User | Situation | Needs |
| --- | --- | --- |
| Developer using Claude Code (primary) | Many parallel sessions across repos and tickets, uses Obsidian, Notion, Jira or plain files for notes | Never lose a session's work; see status and pick-next at a glance; hand work to an agent |
| Developer without a note app | Same, but no Obsidian or Notion | Works with a plain markdown folder; no extra tooling |
| Team lead or teammate (secondary) | Wants to see where a developer's work stands | Read-only view of the shared dashboard |
| The agents (non-human) | Interval agent syncs notes to the dashboard; handoff agent analyses a ticket and files follow-ups | Clear, machine-readable notes and requests |

## Goals and success metrics

| Goal | Metric | Target for v1 |
| --- | --- | --- |
| Nothing written without a ticket | Share of write actions in tracked sessions that carry a ticket binding | 100 % with the gate on; unticketed sessions visibly flagged when it is off |
| Nothing lost when a session dies | Extinct sessions whose last checkpoint and conclusions are readable from the notes and the UI | 100 % of sessions that reached a Stop event |
| Traceable to the real project | Tickets and sessions carrying a project set automatically from the repo | 100 % in repos that ran `tracker init` |
| Fast daily use | Time from opening the dashboard to knowing what to pick next | Under 10 seconds, no instructions |
| Installable by strangers | Time for a fresh machine to install and track its first session | Under 10 minutes, following the README only |
| Trustworthy data | Dashboard shows last-sync time and degrades visibly when stale | Always; stale state noticed within 3 seconds |

## Scope

### In scope for v1

1. Ticket gate: a hook blocks Edit, Write, MultiEdit, NotebookEdit and write-like Bash commands (commit, push, merge, rm, mv, sed -i, redirects) in any session with no bound ticket, and tells Claude how to bind one. Reads and plan mode are never blocked.
2. Binding commands: `/ticket <KEY>`, `/ticket new "<title>" --cat <category> --parent <KEY>`, `/ticket` (show), `/ticket relink`, `/ticket off` (escape hatch, logged).
3. Capture: every write, commit, PR, approved plan (ExitPlanMode), conclusion (Stop with a conclusion marker) and compaction digest lands in the bound ticket's note within seconds; sessions get their own note with a last checkpoint.
4. Approval: `/approve` promotes the latest checkpoint to an approved analysis; an optional affirmative-phrase heuristic ("approved", "lgtm", "go ahead", "ship it") does the same.
5. Note schema: ticket, session, follow-up and handoff notes with closed-set `status` and `category`, `parent`/`children` links, mirrored tags, and automatic `project` from the repo's `.tracker.toml`.
6. Local store backends: plain markdown folder (default) and Obsidian vault. Jira as a link (key validated at bind). At least one local store is mandatory.
7. Interval agent: reconciles notes, marks stale tickets and extinct sessions, scores pick-next, mirrors everything to the dashboard; runs as a scheduled task or as `tracker sync` from cron.
8. Dashboard: one per user, private by default, shareable; views Pick next, Board, Tree, Sessions, Deployments, plus a ticket detail panel; edits limited to next action, status, mark deployed, handoff, refresh.
9. Handoff: a button that queues an agent run on a ticket with a mode (analyse / analyse + follow-ups / attempt fix) and an opt-in to read local source; results and child tickets are filed back to the notes.
10. Packaging: one Claude Code plugin (hooks, commands, skill, agent, UI template, note templates), installable from a marketplace entry or a git clone; `tracker init` wizard; no telemetry.
11. Migration of the existing PMLA tracker into the new tool as the reference installation.

### Out of scope for v1

- Jira or Notion as the system of record (they are mirrors or links only).
- Shared team dashboards and hosted sync between users.
- Notion mirror, Jira status sync, Linear and GitHub Issues links (phase 6).
- Mobile editing (phone is read-only).

## User stories

- As a developer, when I start editing in a session that has no ticket, I want the write refused with a one-line instruction, so I bind a ticket before any work lands untracked.
- As a developer, when I run `/ticket new "Fix consumer lag alert"` inside a repo, I want the note created with the right project, key prefix and category defaults, so I never tag by hand.
- As a developer, when I approve a plan or say "lgtm" to an analysis, I want it recorded on the ticket as approved, so an agent or a future me can act on it without re-deriving it.
- As a developer, when a session is closed or compacted, I want its last checkpoint and files touched kept on the ticket, so nothing is lost.
- As a developer, when I open the dashboard, I want the top five things to pick next with a reason each, so I decide in seconds.
- As a developer, when I click Handoff on a ticket, I want an agent to read the note, optionally look at my local repo, and file child follow-ups, so the work advances while I am elsewhere.
- As a developer, when the agent has not synced for hours, I want the dashboard to say so plainly, so I never act on stale status.
- As a new user, I want to install the plugin, run `tracker init`, and have my first session tracked within ten minutes, with no cloud account required for the core.
- As a teammate with a shared link, I want to read a developer's board without being able to change it.

## Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1 | PreToolUse gate denies write tools and write-like Bash commands when no ticket is bound; deny reason tells Claude the exact command to run | Must |
| FR-2 | Gate never blocks reads, searches, plan mode, or non-write Bash | Must |
| FR-3 | Binding is per session, stored locally, survives resume, and is shown in the status line | Must |
| FR-4 | `/ticket new` creates a note from the template with project, category, parent and key prefix defaults | Must |
| FR-5 | Writes, commits, PRs, approved plans, conclusions and compaction digests are captured to notes within 5 seconds; hook failures never block a session except the gate | Must |
| FR-6 | `/approve` and the affirmative-phrase heuristic promote a checkpoint to an approved analysis; heuristic is configurable and can be disabled | Should |
| FR-7 | Notes carry closed-set status and category, parent/children links, mirrored tags, project, and a versioned format | Must |
| FR-8 | Markdown folder and Obsidian vault supported as local stores; Jira key validated on bind when configured | Must |
| FR-9 | Interval agent reconciles links, infers missing category, marks stale (5 days) and extinct (48 h), scores pick-next, and mirrors rows to the dashboard | Must |
| FR-10 | Dashboard shows Pick next, Board, Tree, Sessions, Deployments and a detail panel; shows last-sync and a stale banner over 6 hours | Must |
| FR-11 | Dashboard edits are limited to next action, status, mark deployed, handoff request and refresh; each shows a queued state until confirmed | Must |
| FR-12 | Handoff runs with mode and source opt-in, never pushes to main, caps at 20 minutes, files a handoff note and child notes, and reports done or failed with a reason | Must |
| FR-13 | Plugin installs from a marketplace entry or git clone; `tracker init` writes `.tracker.toml` in a repo and user config under `~/.claude/tracker/` | Must |
| FR-14 | `tracker migrate` upgrades note formats and migrates the PMLA v2 layout with a dry run | Should |
| FR-15 | `tracker ui --static` produces an offline HTML dashboard for users without cloud scheduled tasks | Could |
| FR-16 | Notion mirror, Jira status sync, Linear and GitHub links via the same adapter interface | Later |

## Non-functional requirements

- Performance: each hook completes in under 200 ms; note rewrites debounced to once per 30 seconds per ticket.
- Reliability: append-first event log; a replay command rebuilds notes from the log; the gate is the only hook allowed to fail closed.
- Privacy: no telemetry; nothing leaves the machine except what the user's own agent pushes to their own dashboard or mirror backend.
- Portability: macOS, Linux, Windows native and WSL; Node 18 or newer; no dependencies beyond Node.
- Accessibility: dashboard meets WCAG AA in light and dark, full keyboard operation, status never by colour alone.
- Compatibility: works with Claude Code settings hooks today; the mods API is an optional later path.

## Release plan

Six gated phases; each starts when the previous gate passes. Dates are not set.

| Phase | Delivers | Gate |
| --- | --- | --- |
| 1 Core plugin, local | tracker.js, hooks, `/ticket`, `/approve`, markdown or Obsidian store, project tagging | One session tracked end to end with no manual note edits |
| 2 Migrate PMLA | Reference install: notes normalised, hooks swapped, v2 kept for rollback | Every PMLA ticket shows the right status in Dataview |
| 3 Agent and UI | 2-hourly agent, dashboard DB, Pick next, Board, Sessions, Deployments | Dashboard matches the store after two scheduled runs |
| 4 Handoff | Handoff task and local subagent, child notes, Tree view | One handoff files a correct child note |
| 5 Public release | README, init wizard, marketplace entry, static UI, two outside testers | A fresh machine installs and tracks a session in under 10 minutes |
| 6 Extend | Notion mirror, Jira status sync, Linear and GitHub links, optional mod | — |

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Gate is too strict and annoys users | Users disable it and lose traceability | Reads never gated; `/ticket off` is logged and surfaced, not silent; default phrase list keeps binding to one command |
| Hook latency slows sessions | Users uninstall | 200 ms budget, append-first log, debounced note writes |
| Subagent tool calls bypass the gate | Untracked writes | Verified in phase 1; cwd-based binding fallback |
| Vault sync conflicts across machines | Corrupted notes | Event log is the source for replay; agent reconciles; multi-machine is an open question for v1 |
| Claude Code hook API changes | Plugin breaks | Settings hooks are the stable surface; mods path kept optional; version pin in the manifest |
| Public users expose private data by sharing a dashboard | Privacy incident | Dashboard private by default; no telemetry; README states what the dashboard contains |

## Open questions

See the checklist at the end of the [TRD](TRD.md#open-questions): tool name and repo home, v1 backends, PMLA profile, distribution channel, machines, store path, Jira key, Bash gate scope, approve heuristics, thresholds, agent interval, handoff default mode, retiring the PMLA artifact.
