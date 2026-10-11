# Session Quill data handling

This describes the implementation prepared for 1.0.0. Quill is a local Claude Code plugin, CLI, worker and dashboard. It does not operate a hosted Quill account service or send Quill telemetry. Local-first does not mean that every feature stays offline.

## What Quill reads and stores

- Ticket keys, titles, descriptions, status, next actions, relationships and notes supplied by the user or an enabled tracker. Tracker records may include assignee names and other personal information.
- Session identifiers, repository paths, changed-file metadata, commit and PR references, timestamps and work history. Selected assistant checkpoints and approved plans are stored as content-addressed blobs. Quill does not make a complete copy of chat transcripts.
- The Stop hook reads appended Claude transcript records to aggregate reported token usage, without retaining their conversation text in the usage record.
- Agent context, replies, test output and run logs. These may contain source code, confidential work details or secrets accidentally included in notes or tool output. Do not treat the store as a secret-redacting vault.

Runtime data defaults to `~/.claude/quill/`, or the directory selected by `QUILL_HOME`. This includes ingress, the append-only journal, blobs, projections, run state and logs. Markdown notes live in the configured store, which may be outside that directory or inside a user-synced folder. Quill does not encrypt the local store. Your operating system and any folder-sync service control access to these files.

## Execution and external destinations

| Feature | What runs or leaves the machine | When |
| --- | --- | --- |
| Hooks and local dashboard | Node hook processes, a background worker, local file reads/writes and a loopback HTTP API. The hooks themselves make no network or model calls. Resume context is provided to the Claude session. | Once tracking is enabled; hooks can recover a missing worker. |
| Tracker sync | Authenticated requests and ticket identifiers to the configured Jira site, GitHub/GitHub Enterprise API, or Linear API. Reads may include assigned-issue queries. | When the user configures/enables sync; scheduled reads can continue while the worker runs. |
| Tracker write-back | Selected ticket status and optional comments to the configured tracker. | Opt-in write-back, previewed and confirmed. |
| PR reconciliation | Requests through `gh` or the configured Bitbucket API for repository and PR state. | Configured scheduled or manual reconciliation. |
| Repository setup | Git operations, including a network clone from an allowed remote host. | A clone requires user confirmation. |
| Agent recipes | `claude -p` in a worktree or file-task workspace. Selected ticket notes, plans, checkpoints, history and permitted source context reach the configured model provider. The agent uses the user's Claude configuration and permitted tools/integrations. | A queued run with recipe-limited permissions; remote proposals require approval except configured trusted read-only recipes. Model usage may incur provider charges. |
| Test gate | The repository's configured test command executes with the user's account inside the run worktree. Tests can themselves access networks and credentials. | After an authorized fix run when a test command is configured. |
| Push and PR creation | Git/provider operations send permitted code changes and PR content to the selected repository host. | Only when the run has the corresponding permission. |
| Publishing and sharing | Selected fields/projects become Markdown, an HTML snapshot, or a claude.ai artifact. Configured two-way pages can return edits and proposals. | A publisher destination is configured and confirmed; subsequent updates follow its configuration. External copies follow the destination's retention rules. |

The local dashboard uses one-use bootstrap links and hashed session tokens. Owner cookies expire after seven days of inactivity. `quill ui --revoke` invalidates dashboard sessions; it does not delete work records. A worktree is isolation for changes, not an operating-system security sandbox.

## Credentials

Optional tracker/provider integrations read credentials from user-configured environment variables or the provider CLI's authentication. Quill asks users to put environment-variable names, not token values, in its configuration. This is not the directory's `userConfig` credential flow and must be disclosed during directory review. No MCP server or HTTP hook is declared by this plugin.

## Retention and removal

There is no general automatic expiry for the journal, notes, checkpoint blobs or work history. Treat those records as retained until the owner removes them. Removing a ticket from a view or marking it done is not an erasure of its journal history.

To stop collection, stop the worker and disable/uninstall the plugin hooks. If a login entry was installed, remove it with `quill worker uninstall`. See the README's [uninstall instructions](../README.md#uninstall). Uninstalling the plugin intentionally preserves existing work records.

After stopping the worker and disabling the plugin, the owner can back up and remove the selected Quill home and note store. Also account for exported HTML, mirrors, published artifacts, backups and synced folders. Quill cannot revoke an exported copy or erase records already held by a tracker or model provider. Avoid deleting a shared notes folder wholesale if it contains unrelated work.

## Contact

Use [GitHub issues](https://github.com/nulllvoid/session-quill/issues) for ordinary support. Report security issues privately through [GitHub security advisories](https://github.com/nulllvoid/session-quill/security/advisories/new). Never post credentials or confidential ticket data in a public issue.
