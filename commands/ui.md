---
description: Open the local Session Quill dashboard (owner link) or write a read-only HTML snapshot
argument-hint: [--static <out.html>] [--no-open]
allowed-tools: Bash(node *)
---

Open the local dashboard or export a snapshot. The live command sets up Quill if needed
and reconnects or starts its worker automatically. Use the current repository as the
working directory. Pass `--session <id>` when the `Session Quill session:` context line
provides an id, so first-time setup captures this session too. Never guess the id.
If the user explicitly stopped processing, offer `/session-quill:start` to resume it.

1. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quill.js" ui $ARGUMENTS
```

2. Relay the output. The owner link is one-use, loopback only and expires in 10 minutes; do not paste it anywhere other than back to the user. A `--static` export is a read-only copy that will not update and cannot be revoked once shared; it never uploads anything.
