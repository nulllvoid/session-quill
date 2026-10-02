# Session Quill

[![CI](https://github.com/nulllvoid/session-quill/actions/workflows/ci.yml/badge.svg)](https://github.com/nulllvoid/session-quill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

A Claude Code plugin that binds development sessions to tickets, keeps a durable local record of what each session did, and gives you a loopback dashboard that answers "what should I pick next?", "where was I?" and "what still needs deployment?".

![Pick next view of the Session Quill dashboard](docs/images/dashboard-pick-next.jpg)

- **Ticket gate.** With the plugin loaded, supported write tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`), unknown shell commands and unregistered tools are denied until the session is bound to a ticket. Dedicated reads and a small tested read-only shell subset pass through. The gate is a workflow aid, not a sandbox: `/session-quill:ticket off` disables it per session, audibly.
- **Durable capture.** Hooks persist events to local ingress before acknowledging; one worker per store journals them, rebuilds generated state, and writes markdown notes (plain folder or Obsidian vault) within 30 seconds. Your own Summary and Notes sections are preserved byte-for-byte.
- **Dashboard.** Pick next, Board, Tree, Sessions and Deployments views with revision-checked edits, a 10-second undo window, explicit conflicts, deterministic reconciliation every two hours and a Refresh that runs immediately.
- **Sharing.** Read-only standalone HTML snapshots with an export time; no credentials, request code or local paths.
- **Handoffs.** Analyse, analyse with follow-ups, or attempt a fix in an isolated Git worktree with explicit read/edit/commit/push/draft-PR permissions and a 20-minute cap.

## Documentation

| For | Read |
| --- | --- |
| Using the plugin | This README, then `node bin/quill.js help` |
| How it works inside | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| What it must do (spec) | [docs/README.md](docs/README.md): PRD, TRD, data contract, UI spec, decisions |
| What has been verified | [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) and [docs/ACCEPTANCE-RESULTS.md](docs/ACCEPTANCE-RESULTS.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md) |

## Prerequisites

- **Node.js 22 LTS or newer**, installed explicitly. Node is **not bundled** with Claude Code; the hooks run `node` from your `PATH`.
- **Claude Code 2.1.x** (hook payloads and plugin layout were verified against the 2.1.284 documentation).
- **Git** and an authenticated **`claude`** CLI only if you use handoffs. **`gh`** only if you want GitHub PR polling.

Supported platforms are recorded after each acceptance run in `docs/ACCEPTANCE-RESULTS.md`; development and tests so far ran on Windows 11 with Node 24.

## Install

Cloning alone does not install the plugin. Load it with Claude Code's plugin directory flag:

```bash
claude --plugin-dir /path/to/session-quill
```

To install permanently, add this repository to a marketplace you control and run `claude plugin install session-quill@<marketplace>`, or keep using `--plugin-dir` (a shell alias works well). Run `claude plugin validate /path/to/session-quill` to check the manifest.

## Initialize

From the repository you want to track:

```bash
node /path/to/session-quill/bin/quill.js init --store ~/Documents/Quill --project my-project --project-name "My Project"
```

With the CLI on your `PATH` this is simply `quill init ...`. `init` writes `~/.claude/quill/config.toml` (user defaults), a committable `.quill.toml` in the repository (project and category defaults; no secrets, no ownership), creates the store, starts the worker and verifies its heartbeat. Re-running is idempotent. Add `--yes` to skip prompts.

Keep the worker running across reboots by registering this with your OS (Task Scheduler, login item, systemd user unit):

```bash
node /path/to/session-quill/bin/quill.js worker start
```

Optional: put the CLI on your `PATH` as `quill` (for example `npm link` or a shell alias) so the commands below read `quill ...`.

## First tracked session

1. Start Claude Code in the repository with the plugin loaded. The SessionStart hook injects `Session Quill session: <id>` and whether the session is bound.
2. Create and bind a ticket: `/session-quill:ticket create "Preserve session checkpoints" --bind`. Supported writes are now permitted through normal Claude Code permissions.
3. Work. Successful writes, commits, PR creation, approved plans (`ExitPlanMode`) and end-of-turn checkpoints are captured and attributed to the ticket.
4. Promote the latest checkpoint as an approved plan with `/session-quill:approve`. Approval is recorded provenance, never permission to commit, push or deploy.
5. Open the dashboard: `quill ui`. The command prints a one-use owner link (loopback only, 10-minute validity) and opens your browser.

Other commands: `/session-quill:status`, `/session-quill:handoff <KEY>`, `/session-quill:ui`; from a terminal `quill ticket list`, `quill sync`, `quill export`, `quill replay --into <dir>`, `quill import <note.md>`, `quill note restore <KEY>`, `quill migrate --source <dir> --dry-run`.

## Status line

Add the quill segment to your status line (`~/.claude/settings.json`):

```json
{ "statusLine": { "type": "command", "command": "node /path/to/session-quill/scripts/statusline.js" } }
```

If you already have a status line, keep it and run both scripts from a small wrapper so neither replaces the other.

## Diagnostics

```bash
quill doctor
```

Reports Node, Git and Claude versions, store ownership (copies on other machines are read-only), worker lock and heartbeat, ingress backlog, journal health and recent capture gaps. `quill status --json` shows the binding for a session. Logs are under `~/.claude/quill/logs/`.

## Uninstall

1. Stop the worker: `quill worker stop` (and remove any OS registration you added).
2. Remove the plugin: stop passing `--plugin-dir`, or `claude plugin uninstall session-quill`.
3. Your markdown store is yours and stays where it is. Quill state (journal, blobs, projections) lives in `~/.claude/quill/`; delete it only after backing it up if you want a clean slate.

## Privacy and limits

- No telemetry. Hooks capture tool metadata and selected assistant content, not full prompts, environments or command output.
- The gate covers tool calls delivered to its hooks. External processes, disabled hooks and host crashes are outside its guarantee, and a valid binding never bypasses normal Claude Code permissions.
- Exports are copies: they do not update and cannot be revoked after you share them.
- Handoffs use your configured model provider; selected ticket content leaves the machine when you queue one.
- An **attempt-fix** handoff runs the repository's own tests inside the isolated worktree, which means it executes repository code with your user account. Granting `edit_source` is granting that. Push and draft-PR permissions are enforced by removing provider tokens and disabling git prompts from the agent's environment unless you grant them, plus the explicit tool allow-list; treat them as policy you can audit in the handoff log, not as a sandbox.
- Plan mode: the gate identifies a session's plan file by its first `Write` of a Markdown file directly inside `~/.claude/plans` (the host does not report the path). See [ADR 0004](docs/decisions/0004-plan-path-first-claim.md).

## Development

```bash
npm test                   # unit, integration, acceptance and scaled performance suites (node:test)
npm run test:acceptance    # only the scenario suite mapped to docs/ACCEPTANCE.md
node scripts/dev-seed.mjs  # dashboard on a throwaway store with sample data
```

![Board view with the docked ticket detail](docs/images/dashboard-board-detail.jpg)

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a map of the code.

Session Quill is released under the [MIT License](LICENSE). Source: [github.com/nulllvoid/session-quill](https://github.com/nulllvoid/session-quill).
