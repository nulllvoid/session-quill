---
description: Approve (promote) the latest captured checkpoint for the bound ticket, or dismiss it
argument-hint: [--checkpoint <id>] | dismiss [--checkpoint <id>]
allowed-tools: Bash(node *)
---

Promote the latest complete checkpoint of this session's bound ticket as an approved plan, or dismiss it.

1. Find this session's id in your context (the line starting with `Session Tracker session:`).
2. If `$ARGUMENTS` starts with `dismiss`, run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/tracker.js" dismiss <remaining arguments> --session <session id>
```

   Otherwise run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/tracker.js" approve $ARGUMENTS --session <session id>
```

3. Show the output. Approval is idempotent and attaches to an exact checkpoint, ticket and session. Recorded approval is not permission to commit, push or deploy; if the user wants those, they must ask explicitly.
