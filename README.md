# Session Tracker

A Claude Code plugin that binds development sessions to tickets, keeps a durable local record of what each session did, and gives you a loopback dashboard that answers "what should I pick next?", "where was I?" and "what still needs deployment?".

- **Ticket gate.** With the plugin loaded, supported write tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`), unknown shell commands and unregistered tools are denied until the session is bound to a ticket. Dedicated reads and a small tested read-only shell subset pass through. The gate is a workflow aid, not a sandbox: `/session-tracker:ticket off` disables it per session, audibly.
- **Durable capture.** Hooks persist events to local ingress before acknowledging; one worker per store journals them, rebuilds generated state, and writes markdown notes (plain folder or Obsidian vault) within 30 seconds. Your own Summary and Notes sections are preserved byte-for-byte.
- **Dashboard.** Pick next, Board, Tree, Sessions and Deployments views with revision-checked edits, a 10-second undo window, explicit conflicts, deterministic reconciliation every two hours and a Refresh that runs immediately.
- **Sharing.** Read-only standalone HTML snapshots with an export time; no credentials, request code or local paths.
- **Handoffs.** Analyse, analyse with follow-ups, or attempt a fix in an isolated Git worktree with explicit read/edit/commit/push/draft-PR permissions and a 20-minute cap.

Design documents live under [docs/](docs/README.md). Acceptance evidence is recorded in [docs/ACCEPTANCE-RESULTS.md](docs/ACCEPTANCE-RESULTS.md).

## Prerequisites

- **Node.js 22 LTS or newer**, installed explicitly. Node is **not bundled** with Claude Code; the hooks run `node` from your `PATH`.
- **Claude Code 2.1.x** (hook payloads and plugin layout were verified against the 2.1.284 documentation).
- **Git** and an authenticated **`claude`** CLI only if you use handoffs. **`gh`** only if you want GitHub PR polling.

Supported platforms are recorded after each acceptance run in `docs/ACCEPTANCE-RESULTS.md`; development and tests so far ran on Windows 11 with Node 24.

## Install

Cloning alone does not install the plugin. Load it with Claude Code's plugin directory flag:

```bash
claude --plugin-dir /path/to/session-tracker
```

To install permanently, add this repository to a marketplace you control and run `claude plugin install session-tracker@<marketplace>`, or keep using `--plugin-dir` (a shell alias works well). Run `claude plugin validate /path/to/session-tracker` to check the manifest.

## Initialize

From the repository you want to track:

```bash
node /path/to/session-tracker/bin/tracker.js init --store ~/Documents/Tracker --project my-project --project-name "My Project"
```

With the CLI on your `PATH` this is simply `tracker init ...`. `init` writes `~/.claude/tracker/config.toml` (user defaults), a committable `.tracker.toml` in the repository (project and category defaults; no secrets, no ownership), creates the store, starts the worker and verifies its heartbeat. Re-running is idempotent. Add `--yes` to skip prompts.

Keep the worker running across reboots by registering this with your OS (Task Scheduler, login item, systemd user unit):

```bash
node /path/to/session-tracker/bin/tracker.js worker start
```

Optional: put the CLI on your `PATH` as `tracker` (for example `npm link` or a shell alias) so the commands below read `tracker ...`.

## First tracked session

1. Start Claude Code in the repository with the plugin loaded. The SessionStart hook injects `Session Tracker session: <id>` and whether the session is bound.
2. Create and bind a ticket: `/session-tracker:ticket create "Preserve session checkpoints" --bind`. Supported writes are now permitted through normal Claude Code permissions.
3. Work. Successful writes, commits, PR creation, approved plans (`ExitPlanMode`) and end-of-turn checkpoints are captured and attributed to the ticket.
4. Promote the latest checkpoint as an approved plan with `/session-tracker:approve`. Approval is recorded provenance, never permission to commit, push or deploy.
5. Open the dashboard: `tracker ui`. The command prints a one-use owner link (loopback only, 10-minute validity) and opens your browser.

Other commands: `/session-tracker:status`, `/session-tracker:handoff <KEY>`, `/session-tracker:ui`; from a terminal `tracker ticket list`, `tracker sync`, `tracker export`, `tracker replay --into <dir>`, `tracker import <note.md>`, `tracker note restore <KEY>`, `tracker migrate --source <dir> --dry-run`.

## Status line

Add the tracker segment to your status line (`~/.claude/settings.json`):

```json
{ "statusLine": { "type": "command", "command": "node /path/to/session-tracker/scripts/statusline.js" } }
```

If you already have a status line, keep it and run both scripts from a small wrapper so neither replaces the other.

## Diagnostics

```bash
tracker doctor
```

Reports Node, Git and Claude versions, store ownership (copies on other machines are read-only), worker lock and heartbeat, ingress backlog, journal health and recent capture gaps. `tracker status --json` shows the binding for a session. Logs are under `~/.claude/tracker/logs/`.

## Uninstall

1. Stop the worker: `tracker worker stop` (and remove any OS registration you added).
2. Remove the plugin: stop passing `--plugin-dir`, or `claude plugin uninstall session-tracker`.
3. Your markdown store is yours and stays where it is. Tracker state (journal, blobs, projections) lives in `~/.claude/tracker/`; delete it only after backing it up if you want a clean slate.

## Privacy and limits

- No telemetry. Hooks capture tool metadata and selected assistant content, not full prompts, environments or command output.
- The gate covers tool calls delivered to its hooks. External processes, disabled hooks and host crashes are outside its guarantee, and a valid binding never bypasses normal Claude Code permissions.
- Exports are copies: they do not update and cannot be revoked after you share them.
- Handoffs use your configured model provider; selected ticket content leaves the machine when you queue one.

## Development

```bash
npm test                 # unit and integration suites (node:test)
npm run test:acceptance  # scenario suite mapped to docs/ACCEPTANCE.md
```

The license and public repository owner are release inputs; see [LICENSE-TBD.md](LICENSE-TBD.md).
