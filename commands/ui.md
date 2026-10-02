---
description: Open the local Session Tracker dashboard (owner link) or write a read-only HTML snapshot
argument-hint: [--static <out.html>] [--no-open]
allowed-tools: Bash(node *)
---

Open the local dashboard or export a snapshot.

1. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/tracker.js" ui $ARGUMENTS
```

2. Relay the output. The owner link is one-use, loopback only and expires in 10 minutes; do not paste it anywhere other than back to the user. A `--static` export is a read-only copy that will not update and cannot be revoked once shared; it never uploads anything.
