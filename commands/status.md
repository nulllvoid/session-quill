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

3. Summarize whether capture is enabled and whether processing is ready. If setup is missing or processing is unavailable, offer `/session-quill:start` to enable or recover it inside Claude. If the user asked you to repair Quill, run that command directly. Diagnose persistent failures with the bundled `doctor` command; never claim capture succeeded without evidence.
