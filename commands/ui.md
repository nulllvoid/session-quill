---
description: Open the local Session Quill dashboard (owner link) or write a read-only HTML snapshot
argument-hint: [--static <out.html>] [--no-open] [--revoke]
allowed-tools: Bash(node *)
---

Open the local dashboard or export a snapshot. The live command sets up Quill if needed
and reconnects or starts its worker automatically. First-time setup needs a Git
repository as the working directory; an existing dashboard can open from any directory.
Pass `--session <id>` when the `Session Quill session:` context line provides an id, so
first-time setup captures this session too. Never guess the id. Once initialized, opening
the dashboard does not register repositories or change session bindings or working directories.
If the user explicitly stopped processing, offer `/session-quill:start` to resume it.

1. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quill.js" ui $ARGUMENTS
```

2. Relay the output. The owner link is one-use, loopback only and expires in 10 minutes; do not paste it anywhere other than back to the user. Once used, the browser stays signed in for 7 days from its last use, so the plain dashboard address (shown on the `Dashboard:` line) works after that. `--revoke` signs every browser out. A `--static` export is a read-only copy that will not update and cannot be revoked once shared; it never uploads anything.

The dashboard opens Work: expand a parent to inspect pending required subtasks, use lenses and filters to prioritize, and open detail for evidence. Run agent offers Read only, Plan, Auto and Full access; legacy recipes remain under Advanced templates. Daily update generates a local draft for Today, Yesterday, Last 24 hours, or Since last update. Scheduling is opt-in; generating a summary never posts it or changes tickets.
