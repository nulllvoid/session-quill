---
description: Queue an agent handoff for a ticket with explicit permissions (analyse, analyse-followups or attempt-fix)
argument-hint: <KEY> [--mode analyse|analyse-followups|attempt-fix] [--note "..."] [--read-source] [--edit-source] [--commit] [--push-branch <branch>] [--draft-pr] | list | cancel <id>
allowed-tools: Bash(node *)
---

Queue a Session Tracker handoff. Permissions are explicit flags on the request; never add a permission the user did not ask for, and never infer one from approval text.

1. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/tracker.js" handoff $ARGUMENTS
```

2. Relay the output. "Request accepted" means the handoff was queued, not that it finished; execution is capped at 20 minutes and one queued or running handoff exists per ticket. Progress is visible with `handoff list` or in the dashboard.
3. If the CLI rejects a permission combination (for example `--push-branch main`), explain the rule it quotes instead of retrying with different permissions.
