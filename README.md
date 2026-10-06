# Session Quill

[![CI](https://github.com/nulllvoid/session-quill/actions/workflows/ci.yml/badge.svg)](https://github.com/nulllvoid/session-quill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

A Claude Code plugin that binds development sessions to tickets, keeps a durable local record of what each session did, and gives you a loopback dashboard that answers "what should I pick next?", "where was I?" and "what still needs deployment?".

![Pick next dashboard with workspace stats and unlinked session work](docs/images/dashboard-pick-next.jpg)

- **Zero-command tracking.** Mention a ticket key such as `PROJ-123` in a prompt, or start on a branch like `feat/PROJ-123-...`, and the session is linked to that ticket. Any tracker works through a URL template; no tracker host is built in.
- **Unlinked work inbox.** Files and commits from a session with no ticket wait on Pick next. Attach them to a ticket, create the ticket from its key, or dismiss them; each action has a 10-second undo. Tracker keys open their ticket in a new tab and copy with one click.
- **Ticket gate modes.** `nudge` (default) never blocks and asks once at the end of a turn about unlinked work. `strict` denies supported write tools, unknown shell commands and unregistered tools until the session is bound, while dedicated reads and a tested read-only shell subset pass through. `off` only captures. The gate is a workflow aid, not a sandbox: `/session-quill:ticket off` disables it per session, audibly.
- **Durable capture.** Hooks persist events to local ingress before acknowledging; one worker per store journals them, rebuilds generated state, and writes markdown notes (plain folder or Obsidian vault) within 30 seconds. Your own Summary and Notes sections are preserved byte-for-byte.
- **Dashboard.** Pick next, Board, Tree, Sessions, Deployments and Today views with revision-checked edits, a 10-second undo window, explicit conflicts, scheduled reconciliation (every two hours unless you set your own schedules) and a Refresh that runs immediately.
- **Schedules and providers.** Named jobs run on cron or interval schedules in your time zone, with a Schedules panel and Run now. PR state comes from GitHub (`gh`) or Bitbucket Cloud and Server.
- **Sharing.** Read-only standalone HTML snapshots with an export time; no credentials, request code or local paths.
- **Agent recipes.** Analyse, analyse with follow-ups, attempt a fix, check deployments or write a standup, or add your own recipes as Markdown files. Each runs in an isolated Git worktree with explicit read/edit/commit/push/draft-PR permissions that the recipe caps, and its suggestions wait for you to accept them.
- **Environments and Today.** Each merged PR owes a deployment per environment, shown as a PR-by-environment matrix with the evidence for each. Today lists what happened on each day of the last week, and a digest job writes the same summary into your daily note.
- **Publishers.** Share a roll-up note, a read-only HTML copy or a live claude.ai artifact page. Each sends only the fields and projects you list, and only after you confirm the destination.
- **Tracker sync and two-way pages.** Read status, assignee and fix version from Jira, GitHub or Linear without ever writing to them. On a two-way artifact page, teammates' status and next-action changes come back as revision-checked edits, and their comments join the ticket's timeline.

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
- **Claude Code 2.1.x** (verified with 2.1.288).
- **Git** and an authenticated **`claude`** CLI only if you use agent recipes. **`gh`** only for GitHub PR polling, and a Bitbucket or tracker token only if you use those integrations.
- A **claude.ai** sign-in in Claude Code only for artifact publishers. Live pages are published from a Claude Code session, because headless `claude -p` has no Artifact tools.

Supported platforms are recorded after each acceptance run in `docs/ACCEPTANCE-RESULTS.md`. CI runs the suite on Windows, macOS and Linux with Node 22 and 24.

## Get started inside Claude Code

From the repository you want to track, install the plugin:

```text
/plugin marketplace add nulllvoid/session-quill
/plugin install session-quill@session-quill
```

Start a new Claude session to load the plugin, then run:

```text
/session-quill:start
```

Keep coding. Quill detects the repository, saves its registration privately, starts
its background worker, and captures the current session. No CLI alias, tracker
connection, ticket, or repository configuration file is required. Node 22 or newer
must still be on your PATH; it is not bundled with Claude Code.

Open your dashboard whenever you need it:

```text
/session-quill:ui
```

The dashboard command also sets up Quill if needed and starts a missing worker.
After a reboot, the next Claude session reconnects automatically. You do not need
to configure Task Scheduler or systemd for ordinary session tracking. Scheduled
jobs run while the worker is running; opening Claude after downtime starts recovery.

Quill keeps your existing store. A first setup uses `~/.claude/quill/store`
(or `QUILL_HOME/store` when set). To choose a notes folder instead, run
`/session-quill:start --store <folder>` on first setup. To write team defaults
into a committable `.quill.toml`, explicitly use `--share-settings`.
Existing gate policies are preserved, including strict repository policies.

If something is wrong, use `/session-quill:status`. Run `/session-quill:start`
to reconnect or resume processing inside Claude. `quill doctor` remains available
for detailed diagnostics. A stopped worker stays stopped until you explicitly
resume it with `start`; hooks continue durable capture where storage is available.

### Terminal and advanced setup

The same install commands work from a terminal with `claude plugin` in place
of `/plugin`. Update with `claude plugin marketplace update session-quill`
and `claude plugin update session-quill@session-quill`.

From a development clone, use `claude --plugin-dir /path/to/session-quill`.
`npm link` optionally exposes `quill` on PATH. Otherwise run
`node /path/to/session-quill/bin/quill.js` in place of `quill`.
The Claude commands always locate their bundled CLI automatically.

```bash
quill start                                 # private setup or resume
quill ui                                    # open dashboard, starting worker if needed
quill worker stop                           # pause processing and automatic restart
quill start                                 # resume; captured activity catches up
quill init --store ~/Documents/Quill --project my-project --project-name "My Project"
quill repo add ~/src/payments-api
quill repo list
```

`quill init` retains the advanced interactive setup, including repository defaults.
`start` uses sensible defaults without prompts and requires a Git work tree.
The worker remains a single owner per store; it never takes ownership from another
machine. Automatic launch attempts are rate-limited to avoid a crash loop.

## Link sessions to your tracker

Add a `[tracker]` table to the repository's `.quill.toml` (shared with your team) or to `~/.claude/quill/config.toml` (just you). Secrets never go in either file.

```toml
[tracker]
system       = "jira"                          # jira | linear | github | custom
domain       = "https://example.atlassian.net"
url_template = "{domain}/browse/{key}"         # linear: "{domain}/issue/{key}" · github: "{domain}/{repo}/issues/{number}"
key_pattern  = '\b([A-Z][A-Z0-9]+-\d+)\b'      # the default; single quotes keep backslashes literal
prefixes     = ["PROJ", "OPS"]                 # empty = any key except common tokens like UTF-8
sources      = ["prompt", "branch"]
on_new_key   = "switch"                        # switch | add | ignore

[gate]
mode = "nudge"                                 # off | nudge | strict
```

A repository can make the gate stricter than your own setting but never looser, and it can narrow your `prefixes` list but never widen it. In `strict` mode a mention only links the session when `prefixes` is set. A `.quill.toml` that cannot be parsed makes its repository strict until it is fixed. Patterns match within whitespace-free words of up to 100 characters. The worker picks up edits to either file within about 10 seconds. `gate_enabled = false` still works and means `mode = "off"`.

## Schedules

Without configuration the worker reconciles every two hours. To choose your own cadence, add `[[schedule]]` tables to `~/.claude/quill/config.toml` (repositories cannot schedule jobs):

```toml
[[schedule]]
name = "reconcile"
job  = "reconcile"
every = "2h"                 # or 30m, 1d

[[schedule]]
name = "evening-sync"
job  = "reconcile"
cron = "30 19 * * 1-5"       # minute hour day-of-month month day-of-week, in the store's time zone
```

A run missed while the computer was off runs once when the worker starts. Open **Schedules** in the dashboard header for next and last runs and **Run now**. Jobs: `reconcile` checks PRs, `agent` runs a recipe, `digest` writes a daily summary, `publish` runs publishers and `tracker-sync` reads your tracker (each is described below).

## Environments, Today and the daily digest

List your deployment environments once in `[tracker]`; a repository's own `deployment_environments` in `config.toml` still wins (repositories registered by older versions of `quill init` list `["production"]`; remove that line to use the tracker's list).

```toml
[tracker]
environments = ["stage", "prod"]
```

Each merged PR then owes one deployment per environment. The ticket shows pending, done or N/A for each, with the evidence you or an agent recorded (a values-file tag bump, an ArgoCD sync, a release), and stays on Deployments until nothing is pending. **Today** (shortcut 6) shows the last week day by day and ticket by ticket. To get the same summary in your notes:

```toml
[[schedule]]
name = "daily-digest"
job  = "digest"
cron = "30 19 * * 1-5"
to   = ["vault-daily"]           # the store's daily/YYYY-MM-DD.md; or ["file"] with path = "notes/digest.md" (relative to the store, or ~/...)
```

The digest lives between `<!-- quill:digest:start -->` and `<!-- quill:digest:end -->`; your own text in the note is never touched, and if you edit the digest section Quill stops updating it until you empty it again.

## Publishing

Share a current view of your tickets with `[[publish]]` entries in `~/.claude/quill/config.toml`:

```toml
[[publish]]
name     = "team"
kind     = "artifact"          # a live claude.ai page; or "markdown" (a roll-up note) or "html" (a read-only copy, with path = "...")
projects = ["my-project"]
fields   = ["key", "title", "status", "next", "pr", "deployments", "updated"]
```

Only those fields of those projects are sent, through the same filter as exports (no local paths, links only with `include_links = true`). The first publish to a destination waits for you to confirm it, from **Publish** in the dashboard header or with `quill publish team --confirm`. A live artifact is published from a Claude Code session, which has the Artifact tools: run `/session-quill:publish team`. Later publishes update each row in place and keep anything someone edited on the page. Add `on = ["reconcile"]` to republish a note or copy after every reconciliation. With `two_way = true`, people you let edit the page can change a ticket's status or next action there; the next publish turns each change into an edit that applies unless the ticket changed since, and comments that name a ticket appear on its timeline.

## Tracker sync

To see what your tracker says about each linked ticket (status, assignee, fix version), name the token variable in `[tracker]` and schedule a sync. Quill only reads; it never writes to the tracker and never changes its own status from it.

```toml
[tracker]
system         = "jira"
domain         = "https://example.atlassian.net"
sync_token_env = "JIRA_TOKEN"        # an API token; for Jira Cloud also set sync_username_env = "JIRA_EMAIL"

[[schedule]]
name = "tracker-sync"
job  = "tracker-sync"
every = "6h"
```

GitHub (`GITHUB_TOKEN`, with `repo = "owner/name"`) and Linear (`LINEAR_API_KEY`) work the same way. The token is sent only to the tracker in your own config, never to one a repository names.

## Bitbucket pull requests

Set the repository's provider in `~/.claude/quill/config.toml` and put a token in an environment variable the worker can read. Quill never stores the token, and sends it only to the host you configure.

```toml
[repos.my-repo]
provider = "bitbucket"
token_env = "BITBUCKET_TOKEN"                       # an access token, sent as a bearer token
# username_env = "BITBUCKET_USERNAME"               # set this to use an app password with basic auth instead
# provider_url = "https://bitbucket.example.com"    # Bitbucket Server/Data Center; omit for bitbucket.org
```

## Agent recipes

A recipe is a Markdown file with frontmatter and a prompt. Quill ships `analyse`, `analyse-followups`, `attempt-fix`, `deploy-check` and `standup`; add your own in a repository's `.quill/agents/` (shared, and preferred for that repository) or in `~/.claude/quill/agents/` (just you).

```markdown
---
name: deploy-check
description: Check whether each merged PR reached each environment
mode: analyse                      # analyse | analyse-followups | attempt-fix
permissions: { read_source: true } # the most a run may get
tools: [Read, Grep, "Bash(git log:*)"]
timeout_min: 10
outputs: [summary, deploy_evidence, next_action]
---
For {{ticket.key}} ({{ticket.url}}): for each merged PR {{prs}}, find the deployment evidence...
```

Run one from the ticket's Agents panel, with `quill agent run deploy-check PROJ-123`, with `/session-quill:agent run deploy-check PROJ-123`, or on a schedule:

```toml
[[schedule]]
name   = "deploy-followup"
job    = "agent"
cron   = "0 11 * * 1-5"
recipe = "deploy-check"
scope  = "deploy-pending"          # deploy-pending | active | review | blocked | open
```

The run dialog shows what a recipe may do before you queue it; anything with a side effect stays off until you tick it, and scheduled runs only ever read. Results from your own recipes and `deploy-check` or `standup` arrive as suggestions on the ticket: accept or dismiss each one. A comment draft is never posted to your tracker.

## Example walkthrough

One ticket, `PROJ-123` in Jira, from first prompt to a page your team can see. It assumes `quill init` has run and that `[tracker]` in `~/.claude/quill/config.toml` names your Jira site, prefixes and `environments = ["stage", "prod"]`.

1. **Start working.** Open Claude Code in the repository on a branch such as `feat/PROJ-123-retry-flake`, or say "PROJ-123: make the retry test deterministic". The session is linked to `PROJ-123` before Claude's first tool call, and the ticket is created if the store has none. With no `[tracker]` table, run `/session-quill:ticket create "Make the retry test deterministic" --bind` instead.
2. **Let it capture.** Writes, commits, PR creation, approved plans and end-of-turn checkpoints are recorded against the ticket, and its note in your store updates within 30 seconds. Work done before the session was linked waits under **Unlinked work** on Pick next, where you attach it to a ticket or dismiss it.
3. **Approve the plan.** `/session-quill:approve` promotes the latest checkpoint to an approved plan. It is a record, never permission to commit, push or deploy.
4. **Open the dashboard.** `quill ui` prints a one-use owner link (loopback only, valid for 10 minutes) and opens it. Pick next ranks your open tickets; open `PROJ-123` for its timeline, PRs and deployments.
5. **Ask an agent.** From the ticket's **Agents** panel, or `quill agent run analyse PROJ-123`, a recipe works in an isolated checkout with only the permissions you tick. Its findings arrive as suggestions on the ticket, and you accept or dismiss each one.
6. **Merge and deploy.** When the PR merges, the next reconciliation records it (**Refresh** in the header, or `quill sync`, runs one now). `PROJ-123` now owes `stage` and `prod` deployments, which show on **Deployments**. Record each one with its evidence as it ships, or mark it N/A. A `deploy-check` recipe can look for the evidence and suggest it. Closing the ticket while a deployment is pending asks you to record, waive or leave it.
7. **Review the day.** **Today** shows what changed on each ticket today and on each of the last few days. A `digest` schedule writes the same summary into the store's daily note.
8. **Share it.** Add a `[[publish]]` entry (see [Publishing](#publishing)). For a markdown or HTML publisher, `quill publish team --confirm` confirms the destination and publishes. For a live artifact, run `/session-quill:publish team` in a Claude Code session and confirm when it asks; it prints the page's claude.ai link. Share the page from claude.ai. With `two_way = true`, people you let edit the page can change a ticket's status or next action. Each change comes back on the next publish as an edit that applies unless you changed the ticket since, and comments that name a ticket appear on its timeline.
9. **See the tracker's view.** With `sync_token_env` set and a `tracker-sync` schedule (see [Tracker sync](#tracker-sync)), the ticket shows Jira's status, assignee and fix version, and warns if the key does not exist. Quill never writes to Jira.

Other commands: `/session-quill:status`, `/session-quill:handoff <KEY>`, `/session-quill:agent`, `/session-quill:ui`; from a terminal `quill ticket list`, `quill ticket set <KEY> --status active --next "…" --repo <id>` (edit a ticket after creation or migration), `quill publish list`, `quill export`, `quill replay --into <dir>`, `quill import <note.md>`, `quill note restore <KEY>`, `quill migrate --source <dir> --dry-run` (add `--profile <path.json>` for a legacy tracker with other field names; see [TRD §Migration](docs/TRD.md#migration-and-rollout)), and `quill help` for the rest.

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
2. Remove the plugin: `claude plugin uninstall session-quill@session-quill` and `claude plugin marketplace remove session-quill`, or stop passing `--plugin-dir`.
3. Your markdown store is yours and stays where it is. Quill state (journal, blobs, projections) lives in `~/.claude/quill/`; delete it only after backing it up if you want a clean slate.

## Privacy and limits

- No telemetry. Hooks capture tool metadata and selected assistant content, not full prompts, environments or command output.
- The gate covers tool calls delivered to its hooks. External processes, disabled hooks and host crashes are outside its guarantee, and a valid binding never bypasses normal Claude Code permissions.
- Exports are copies: they do not update and cannot be revoked after you share them.
- Handoffs use your configured model provider; selected ticket content leaves the machine when you queue one.
- An **attempt-fix** handoff runs the repository's own tests inside the isolated worktree, which means it executes repository code with your user account. Granting `edit_source` is granting that. Push and draft-PR permissions are enforced by removing provider tokens and disabling git prompts from the agent's environment unless you grant them, plus the explicit tool allow-list; treat them as policy you can audit in the handoff log, not as a sandbox. Read-only git commands go through Claude Code's own read-only check instead of an allow rule, so options that write files or run programs (`git log --output=…`, `--ext-diff`) are refused. Programs you configured yourself in git config, such as `diff.external`, still run. Details are in [TRD §Handoff execution](docs/TRD.md#handoff-execution).
- Plan mode: the gate identifies a session's plan file by its first `Write` of a Markdown file directly inside `~/.claude/plans` (the host does not report the path). See [ADR 0004](docs/decisions/0004-plan-path-first-claim.md).

## Development

```bash
npm test                   # unit, integration, acceptance and scaled performance suites (node:test)
npm run test:acceptance    # only the scenario suite mapped to docs/ACCEPTANCE.md
node scripts/dev-seed.mjs  # dashboard on a throwaway store with sample data
```

![Board view with a selected ticket, docked details, and next action](docs/images/dashboard-board-detail.jpg)

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a map of the code.

Session Quill is released under the [MIT License](LICENSE). Source: [github.com/nulllvoid/session-quill](https://github.com/nulllvoid/session-quill).
