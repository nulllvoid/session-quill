---
description: Diagnose local setup, worker health, and capture problems
argument-hint: [--json]
allowed-tools: Bash(node *)
---

Run the bundled diagnostics from the current repository:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quill.js" doctor $ARGUMENTS
```

Explain the failing checks and the next useful action in plain language. Missing
optional integrations do not prevent local tracking. For missing setup or a paused
worker, recommend `/session-quill:start`. If the user requested repair, run the
bundled start command with the known session id; never guess an id or bypass store
ownership. Do not claim recovery until the command succeeds.
