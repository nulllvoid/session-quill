---
description: Track a task across sessions; create, reuse, switch, or inspect tickets
argument-hint: work "<task title>" [--description d] [--category c] | create "<title>" [--description d] [--category c] [--priority P2] [--parent KEY] [--bind] | bind <KEY> | show | off | on | relink <KEY> --external <EXT-KEY> | list | children <KEY>
allowed-tools: Bash(node *)
---

Run the Session Quill CLI for this session and show the user its output verbatim.

1. Find this session's id in your context: the SessionStart hook injected a line that starts with `Session Quill session:`. Use that id for `--session`. If no such line exists, run the command without `--session` and relay the error the CLI prints (it explains how to get an id); never guess or reuse another session's id.
2. For `create` and `work`, a description is required. If the arguments carry no `--description`, write one yourself from the conversation (what the user asked for and what you know) and add it; do not ask the user for it. Use exactly this Markdown format, with `
` for line breaks inside the quoted argument:

```
**Goal:** <one sentence: what the task achieves>

**Context:** <why it matters and where: files, components, constraints>

**Done when:**
- <a condition someone can check>
- <another, such as the test that must pass>
```

3. Run exactly:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/quill.js" ticket $ARGUMENTS [--description "<description>"] --session <session id>
```

If the CLI rejects the description, fix the parts it names and run the command once more.

4. Report the result. After `create --bind` or `bind`, state the key the session is now bound to. After `off`, remind the user that the gate is off for this session and audited; after `on`, that enforcement is restored.

Notes:
- Tickets are tasks, not sessions. Use `work "<concise task title>"` to reuse an open task with the same title in this project/repository, or create it, and bind this session atomically. Check `list --json` and bind a known key when the task already exists under a different title. Follow-ups, retries, and approvals stay on the same task; a new task needs its own ticket. Sessions may switch tickets, and multiple sessions may work on one ticket.
- Keys are sequential: DEV for general work, FEAT for `--category feature`, FIX for `--category bugfix`. Custom `key_prefix` settings override these. Never invent a key; report the worker's result. `create` always makes a separate task; `work` reuses a uniquely matching open task. Ambiguous matches require choosing an existing key, never guessing.
- Mentioning a configured ticket key (for example `PROJ-123`) in a prompt links the session automatically; these commands remain for manual control.
- `set <KEY> --description "<description>"` writes or replaces a ticket's description, in the same format. A session bound to a ticket without one is asked to write it.
- `create` inherits project and category defaults from the repository's `.quill.toml`; pass `--category` or `--priority` to override.
- Bindings never fall back to the working directory. Rebinding affects future tool calls only.
- Recorded approval or binding is never permission to commit, push or deploy.
