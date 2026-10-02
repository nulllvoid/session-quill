---
description: Show the quill binding, worker health and capture backlog for this session
argument-hint: [--json]
allowed-tools: Bash(node *)
---

Show the Session Quill status for this session.

1. Find this session's id in your context (the line starting with `Session Quill session:`).
2. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quill.js" status $ARGUMENTS --session <session id>
```

3. Relay the output. If the worker is unavailable, suggest `node "${CLAUDE_PLUGIN_ROOT}/bin/quill.js" doctor` and `worker start` from a terminal; do not start the worker from inside a gated session unless the user asks.
