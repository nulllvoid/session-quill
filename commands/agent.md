---
description: List, show or run a Session Quill agent recipe for a ticket, and accept or dismiss what a run suggests
argument-hint: list | show <recipe> | run <recipe> <KEY> [--note "..."] [--commit] [--push-branch <branch>] [--draft-pr] | suggestions <KEY> | accept|dismiss <run> <id>
allowed-tools: Bash(node *)
---

Run a Session Quill agent recipe. Recipes live in `.quill/agents/` (repository), `~/.claude/quill/agents/` (personal) or ship with the plugin; a recipe's frontmatter permissions are the most a run can get.

1. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quill.js" agent $ARGUMENTS
```

2. Relay the output. For `run`, "queued" means the run was accepted, not that it finished; the recipe's time cap applies and one run per ticket can be queued or running.
3. Never add `--commit`, `--push-branch` or `--draft-pr` unless the user asked for that exact permission. If the CLI says a recipe does not allow a permission, explain that instead of retrying.
4. A run's outputs are suggestions. Accept or dismiss one only when the user asks; a comment draft is never posted to the tracker.
