---
description: Enable or resume local session tracking here, with automatic setup and worker recovery
argument-hint: [--store <folder>] [--share-settings]
allowed-tools: Bash(node *)
---

Enable Session Quill in the current repository. This request authorizes local setup;
do not ask the user to repeat it or send them to a terminal.

1. Find the current session id in the context line `Session Quill session:`.
2. Run the bundled command, adding `--session <id>` when the id is known:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quill.js" start $ARGUMENTS --session <id>
```

Never guess a missing session id. If none is available, omit `--session` and explain
that capture attaches on the next session start. Use the current repository, not the
plugin directory, as the working directory.

The command detects the repository, privately registers it, keeps an existing store
or creates private local storage, and verifies the worker. It resumes an explicitly
stopped worker. It does not connect a tracker, publish anything, or change gate policy.
No repository file is written unless the user requests `--share-settings`.

Report readiness only after success. Keep the response short: Quill is ready; keep
working normally; `/session-quill:ui` opens the dashboard. A ticket is optional.
On failure, explain the actual problem. You may run the bundled `doctor` command
for diagnostics, but never bypass ownership checks or repeatedly retry a failed launch.
