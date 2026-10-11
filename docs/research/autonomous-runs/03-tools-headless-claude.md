# 03 — Tools in headless Claude Code runs

Status: research input · Ticket: FEAT-12 · 2026-10-12 · Claude Code **2.1.296** on this machine (Windows 11, `authMethod: claude.ai`)

Answers the "Tools" and part of the "Access" row of `00-problem-statement.md` §7. It is research only. It does not change any behaviour.

## Summary

- **Everything loads in `claude -p`.** Without `--bare`, a print-mode run loads the same context as an interactive session: user settings, plugins with their skills, hooks and MCP servers, user/local MCP servers, the project's `.mcp.json` and hooks (with no trust prompt), CLAUDE.md, auto memory, **and claude.ai connectors**. Connectors load only while the login is a claude.ai subscription. I confirmed this on this machine: a `-p` run in an empty folder saw 6 connected connectors (103 `mcp__claude_ai_*` tools), 16 plugins, 212 skills and the Quill plugin hooks.
- **The connectors load, but the permissions refuse them.** In `default` and `dontAsk`, an MCP call with no allow rule is denied. `--allowedTools "mcp__*"` approves **nothing**: the docs say an unanchored allow glob is skipped, and I reproduced the denial. An allow rule needs a literal server prefix: `mcp__claude_ai_Atlassian__*` or `mcp__claude_ai_Atlassian__get*`. Both worked.
- **PreToolUse hooks run in `-p`, and they can both deny and allow.** A hook `deny` with `permissionDecisionReason` reaches the model as the tool error. Verified: the model quoted the text back. A hook `allow` lets a call through in `dontAsk` mode **with no allow rule at all**. Verified. Deny rules still beat a hook's allow. So a Quill guard hook can be the policy engine for MCP and Bash calls: allow reads, deny writes with "record as a critical change".
- **The repo's own allow rules are ignored in worktrees.** Quill's worktrees are never trusted, so `permissions.allow` in a repo's `.claude/settings.json` is **not applied** in `-p` there. The repo's hooks and `.mcp.json` servers still are.
- **`stream-json` gives the live attempt data.** Its `system/init` event is a free per-run tool inventory, and the stream also carries `permission_denied` events and `tool_use`/`tool_result` per call.

## Findings (with sources)

### 1. What loads in `-p`, and the flags that change it

Source: [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [MCP](https://code.claude.com/docs/en/mcp), [Permissions — what runs before you trust a folder](https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder).

- "Without it [`--bare`], `claude -p` loads the same context an interactive session would, including anything configured in the working directory or `~/.claude`." `--bare` skips hooks, skills, commands, subagents, plugins, MCP servers, auto memory and CLAUDE.md. It also does not use OAuth/subscription login, so it needs `ANTHROPIC_API_KEY`, and connectors are gone. The docs note that `--bare` "will become the default for `-p` in a future release". **Quill must pin its behaviour explicitly and not rely on today's default.**
- **claude.ai connectors** are fetched when the active auth is a claude.ai subscription login. They are *not* loaded when `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, a third-party provider, or a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` is active. You can turn them off with `ENABLE_CLAUDEAI_MCP_SERVERS=false`, and block one with `deniedMcpServers: [{serverName: "claude.ai Slack"}]`. Tool names are `mcp__claude_ai_<Server>__<tool>`. MCP server precedence is local > project > user > plugin > claude.ai connector.
- **Plugin MCP tools** are named `mcp__plugin_<plugin>_<server>__<tool>`. The server registers as `plugin:<plugin>:<server>`.
- **Untrusted folder under `-p`** (every Quill worktree and sandbox):
  - Project hooks, the `env` block and skill `allowed-tools`: used.
  - `.mcp.json` servers: "Connected without asking, approved or not".
  - `permissions.allow` and `additionalDirectories` from `.claude/settings.json`: **not used**, with a stderr warning ("this workspace has not been trusted").
  - Subagent frontmatter hooks and inline MCP servers: not used.
  - The fix is `projects["<path>"].hasTrustDialogAccepted: true` in `~/.claude.json`, or Quill passes the rules itself.
- Flags:

  | Flag | Effect relevant to Quill |
  | --- | --- |
  | `--setting-sources user,project,local` | Limits which settings files load. `user` alone also skips the project's `.mcp.json`. |
  | `--settings <file\|json>` | Overrides matching keys for this run. Its `hooks` **merge** with plugin hooks: in my probe, both Quill's plugin hooks and the injected hook fired. Its permission rules add to the file rules. |
  | `--mcp-config <files>` / `--strict-mcp-config` | Adds servers, or with strict uses only those. In `-p`, it waits up to `MCP_TIMEOUT` (30 s) for pending servers. |
  | `--append-system-prompt[-file]` | Adds text and keeps the default tool and safety guidance. This is the right place for Quill's run contract, memory and tool inventory, instead of stuffing stdin. |
  | `--agents <json\|file>` / `--agent <name>` | Defines or selects a subagent persona. `agents/quill-handoff.md` could be used through `--agent session-quill:quill-handoff`, which appeared in my probe's `agents` list. |
  | `--add-dir` | Grants file access only. Most `.claude/` config is not discovered there, except skills. |
  | `--permission-prompt-tool <mcp tool>` | An MCP tool answers prompts. This is a possible mid-flight approval channel. |
  | `--permission-prompts none` | Denies anything nobody resolved and tells Claude "nobody can approve, don't retry". Also removes `AskUserQuestion`. Requires 2.1.259 or later. |
  | `--output-format stream-json --verbose` | One JSON event per line: `system/init`, `assistant`/`user` with tool_use/tool_result, `system/permission_denied`, `system/api_retry`, and a final `result` with `permission_denials[]`, `num_turns` and `total_cost_usd`. `--include-hook-events` adds hook lifecycle events. `--forward-subagent-text` adds subagent text. |
  | `--max-turns N` | Print mode only. It "exits with an error when the limit is reached". |
  | `--max-budget-usd X` | A spend cap that includes subagents. A better runaway bound than turns alone. |
  | `--model`, `--fallback-model`, `--effort` | Per-run model choice. |
  | `--tools "..."` | Restricts **built-in** tools only. It has no effect on MCP tools. |
  | `--json-schema` | Validated `structured_output`. Could replace Quill's fenced-JSON parsing and repair turn. |

### 2. Permission rules, modes and hooks

Source: [Permissions](https://code.claude.com/docs/en/permissions), [Permission modes](https://code.claude.com/docs/en/permission-modes), [Hooks](https://code.claude.com/docs/en/hooks).

- **Evaluation order:** "deny, then ask, then allow. The first match … determines the outcome." An allow rule can't carve an exception out of a deny rule. Deny rules from any scope or the command line apply.
- **MCP rule syntax:**
  - `mcp__srv` (the whole server), `mcp__srv__*` and `mcp__srv__tool` are all valid.
  - "Allow rules accept tool-name globs only after a literal `mcp__<server>__` prefix … An unanchored allow glob such as `"*"`, `"B*"`, or `"mcp__*"` is skipped with a warning and doesn't auto-approve anything."
  - Deny and ask rules *do* accept `mcp__*`, which removes every MCP tool from context.
  - Parameter-matching rules for MCP tools work only via `--disallowedTools`. Settings files skip any `mcp__…(…)` rule.
- **Bash rules:**
  - `Bash(git diff *)` is a prefix match. The space matters: `git diff*` also matches `git diff-index`.
  - Compound commands (`&&`, `||`, `;`, `|`, `&`, newline) must match per subcommand for an allow. Deny and ask rules match any subcommand, including ones inside `$(…)`, subshells and loops.
  - "A deny or ask rule … isn't a security boundary around the program": a full path, `sh -c` or an interpreter bypasses it. For a real boundary, use sandboxing, read-only credentials or a PreToolUse hook.
  - Some commands run without any rule: a built-in read-only set, read-only git included.
- **Modes in `-p`** (no human present):
  - `default`: anything that would prompt is denied. The tool error reads "Claude requested permissions to use X, but you haven't granted it yet." (observed)
  - `dontAsk`: also denies whatever would prompt, and says so: "denied because Claude Code is running in don't ask mode …" (observed). Reads in the working dirs, the read-only command set and allow-rule matches still run. `AskUserQuestion`, `requiresUserInteraction` MCP tools, network-path reads and org-`ask` connector tools are denied even when allowed.
  - `acceptEdits`: edits plus `mkdir`/`touch`/`mv`/`cp` in the working dirs. Everything else is as in `default`.
  - `plan`: keeps its read-only blocks in `-p`.
  - `bypassPermissions`: skips prompts, except the "actions no mode auto-approves". Deny rules and hook denies still apply.
  - `auto`: a classifier reviews actions and is available in `-p` (2.1.281 or later). In `-p`, a blocked action is denied and "Claude keeps working". Possible alternative or backstop, see Open questions.
  - A `-p` run with no `--permission-mode` starts in `default` (sessions that fetch feature flags) or `auto` (2.1.285 or later without feature flags). **Always pass the mode.**
- **PreToolUse hooks:**
  - They run for every tool, MCP included, before the permission prompt, and they run in `-p` (verified).
  - Output: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask|defer","permissionDecisionReason":"…","updatedInput":{…},"additionalContext":"…"}}`.
  - For `deny`, the reason is "shown to Claude". For `allow`, it goes to the debug log only.
  - With several hooks, precedence is deny > defer > ask > allow. Exit 2 is a deny with stderr as the reason.
  - "Deny and ask rules are still evaluated regardless of what the hook returns." A hook allow can't override a deny rule.
  - `defer` (honoured only in `-p`) ends the run with `stop_reason: "tool_deferred"`, and the session resumes with `--resume`. This is a native "pause for approval" primitive. It is ignored when Claude makes parallel tool calls.
  - Hook input includes `session_id`, `transcript_path`, `cwd`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`, and for MCP calls `mcp_server: {name, source}`. Observed: `{"name":"claude.ai Atlassian","source":"claudeai"}`. The docs advise basing trust on `source`, not on the name prefix.
  - A timed-out hook **does not block** unless `"onFailure": "block"` is set (2.1.295 or later). Quill's plugin hooks use a 5 s timeout today.
  - Matchers for MCP need `.*`: `mcp__claude_ai_Atlassian__.*`. Plugin servers need the scoped prefix `mcp__plugin_<p>_<s>__.*`.

## Empirical results (exact commands)

All runs were done from an empty folder, `…/scratchpad/toolprobe/empty`, with the prompt on stdin, as the worker does. Bash (Git Bash) on Windows, claude 2.1.296. The only MCP call I made was `getAccessibleAtlassianResources`, a read-only list. I recorded no site names, URLs or ids.

**E0 — inventory without the model**

```
claude --version                 → 2.1.296 (Claude Code)
claude auth status               → authMethod "claude.ai"
claude mcp list                  → (~1 min, health-checks every server)
```

- Connected: claude.ai Claude Docs, Google Calendar, Google Drive, Gmail, Slack, Atlassian.
- Needs auth: claude.ai DevRev, Notion, monday.com, Linear, Intercom, HubSpot, Figma, Canva, Box, Asana; plugin:engineering slack, linear, atlassian, notion, datadog; plugin:data hex, amplitude, amplitude-eu.
- Failed (no dynamic client registration or not configured): plugin:engineering asana, github, pagerduty, gmail, google calendar; plugin:data bigquery, snowflake, databricks, definite; plugin:bigdata-com.
- **No Argo or Kibana server is configured on this machine.** Jira and Confluence are available through `claude.ai Atlassian`.
- `~/.claude/settings.json` has **no `permissions` block and no hooks**. 8 plugins are enabled there, including `session-quill@quill-local`.

**E1 — what a `-p` run sees** (cost $0.006, 1 turn, 18 s)

```
echo "<list MCP servers, deferred tools, skills; call nothing>" | claude -p --output-format stream-json --verbose --max-turns 3 --model haiku --permission-mode dontAsk
```

The `system/init` event reported:

- `permissionMode: dontAsk`.
- 32 built-in tools, including Task, Bash, PowerShell, Skill, ToolSearch, WebFetch, WebSearch, Monitor and Workflow.
- MCP tools: Atlassian 32, Claude_Docs 8, Gmail 30, Google_Calendar 9, Google_Drive 11, Slack 13. These are loaded as **deferred** tools, so the model calls `ToolSearch` first. A `tool_reference` result was observed.
- `mcp_servers` with per-server status (`connected`, `needs-auth`, `failed`).
- 16 plugins, `plugin_errors: []`, 212 skills and 255 slash commands.
- `agents` including `session-quill:quill-handoff`.
- `memory_paths`.
- SessionStart hook events appeared ahead of init, so Quill's plugin hooks ran.

**E2 — MCP permission matrix** (prompt: call `mcp__claude_ai_Atlassian__getAccessibleAtlassianResources` once, report OK/DENIED)

| Run | Flags | Outcome |
| --- | --- | --- |
| A | `--permission-mode default --allowedTools "mcp__*"` | **Denied**: "Claude requested permissions to use mcp__claude_ai_Atlassian__getAccessibleAtlassianResources, but you haven't granted it yet." Also listed in `permission_denials` and as a `system/permission_denied` event. |
| B | `--permission-mode default --allowedTools "mcp__claude_ai_Atlassian__getAccessibleAtlassianResources"` | **Allowed** (OK 2). |
| C | `--permission-mode dontAsk --allowedTools "mcp__claude_ai_Atlassian__get*"` | **Allowed** (OK 2). |
| D | `--permission-mode dontAsk` (no rule) | **Denied**: "…denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools…" with `decision_reason_type: "mode"`. |

**E3 — hook as guard.** I injected a PreToolUse hook with `--settings '{"hooks":{"PreToolUse":[{"matcher":"mcp__claude_ai_Atlassian__.*","hooks":[{"type":"command","command":"node \"<scratch>/hooks/guard.mjs\" <deny|allow>","timeout":10}]}]}}'`.

| Run | Flags | Outcome |
| --- | --- | --- |
| H_deny | dontAsk + allow rule `mcp__claude_ai_Atlassian__get*` + hook deny | **Denied despite the allow rule.** The tool error the model saw was "PreToolUse:mcp__claude_ai_Atlassian__getAccessibleAtlassianResources hook error: QUILL-GUARD: external write not permitted; record it as a critical change instead." The model repeated the reason. |
| H_allow | dontAsk, **no allow rule**, hook allow | **Allowed** (OK 2). A hook allow is enough in `dontAsk`. |

The hook received `permission_mode: "dontAsk"` and `mcp_server: {name: "claude.ai Atlassian", source: "claudeai"}`.

**E4 — not conclusive.**

- `claude -p --init-only --output-format stream-json` exited in 2 s with **no** output, so it gives no init inventory.
- `echo "/mcp" | claude -p --output-format stream-json --verbose` hung for more than 2 min under Git Bash. I stopped it, so it is not usable as a probe here.

## Recommendation for Quill

### A. Spawn line for `access: "autonomous"`

```
claude -p --output-format stream-json --verbose
  --permission-mode dontAsk --permission-prompts none
  --max-turns 150 --max-budget-usd <per-run cap, e.g. 5>
  --setting-sources user,project,local         # explicit; never --bare (it drops connectors and subscription auth)
  --settings <run-settings.json>               # guard hook + permissions, written per run by the worker
  --append-system-prompt-file <run-context.md> # contract, memory, tool inventory, try-or-report rules
  [--model <recipe model>] [--resume <id>]
  (prompt on stdin, as today; --include-hook-events optional for debugging)
```

- **Why `dontAsk` and not `default`:** both deny unanswered prompts in `-p`, but `dontAsk` tells the model plainly why, and Quill's hook is the thing that allows. Together with `--permission-prompts none`, Claude is told not to retry and `AskUserQuestion` is removed.
- **Why not `bypassPermissions` plus a hook:** a hook deny would still work there. But if the hook fails or times out, everything runs. With `dontAsk`, a broken or missing guard degrades to "refused", not to "allowed". Keep `bypassPermissions` for `full` (R7) only.
- **Do not set `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `apiKeyHelper`** in the child env for autonomous runs. Any of them silently removes the claude.ai connectors. `childEnvFor` should explicitly delete `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` unless the owner opted into API billing, and record which auth applied.

### B. `run-settings.json` written by the worker

```json
{
  "permissions": {
    "allow": [
      "Read", "Glob", "Grep", "Skill", "ToolSearch", "WebSearch", "WebFetch",
      "Bash(git status *)", "Bash(git log *)", "Bash(git diff *)", "Bash(git show *)",
      "<recipe test runners>",
      "<edit tools when edit_source is granted>"
    ],
    "deny": [
      "Bash(git push --force *)", "Bash(git checkout main *)", "Bash(git checkout master *)",
      "Bash(gh pr merge *)", "Bash(git merge *)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|PowerShell|mcp__.*|WebFetch",
        "hooks": [ { "type": "command", "command": "node", "args": ["<quill>/bin/quill-guard.js"], "timeout": 10, "onFailure": "block" } ] }
    ]
  }
}
```

- The allow list covers built-in local work only. **Leave every MCP tool out of `allow`.** The guard hook decides each MCP call:
  - **Read** (allow): names matching `get|list|search|fetch|read|query|describe|lookup|view` and `readOnlyHint: true` where the server provides it.
  - **Write** (deny with "record as a critical change"): `create|update|edit|delete|send|post|transition|add|schedule|share|trash|merge|sync|apply|rollback|…`.
  - **Unknown** (deny, and report it as unavailable-for-policy so the owner can classify it).
- **Bash:** the guard classifies prod CLIs.
  - Allow reads: `kubectl get|describe|logs|top`, `aws … describe-*|list-*|get-*`, `gcloud … list|describe`, `argocd app get|list|diff|history`, `psql -c` limited to SELECT, and so on.
  - Deny writes: `kubectl apply|delete|patch|scale|rollout restart|exec`, `argocd app sync|rollback`, `terraform apply`, `helm upgrade`, DDL/DML, `git push` without a grant.
  - Return `permissionDecision: "deny"` with a reason that names the scope that would grant it (R6 and R8).
- **Do the same in Quill's existing plugin `PreToolUse` hook** (`src/hooks/adapter.js`, which already branches on `QUILL_HANDOFF_*`), keyed on a new `QUILL_HANDOFF_ACCESS`/`QUILL_HANDOFF_SCOPES` env. Inject the hook through `--settings` as well, so the guard does not depend on the plugin being enabled.
  - The two decisions combine as deny > allow, so they are safe together.
  - Set `onFailure: "block"`, and raise the timeout above today's 5 s on the guard path. A timed-out hook otherwise falls through to `dontAsk`, which still denies MCP and Bash, so this fails closed anyway.
- **Specific grants (R8)** become guard config (for example `{"scopes":["jira:write","kubectl:staging"]}`), not more CLI rules. CLI rules can't express "write tools of server X except on context prod" reliably, and settings files can't hold MCP parameter rules.
- **Treat the guard as a classifier, not a boundary.** Bash text rules are bypassable (`sh -c`, full paths, scripts). The real backstop for R5 is read-only credentials in the child env: kubeconfig context with a viewer role, an AWS read-only profile, a DB read-only role. See the access research report.

### C. Tool inventory per machine

- **Cheapest and authoritative:** every run's `system/init` event. The worker parses it at run start and stores it:
  - `tools[]`, `mcp_servers[{name,status}]`, `plugins[]`, `plugin_errors[]`, `skills[]`, `agents[]`, `claude_code_version`.
  - Keep it in `memory/_machine.md` or a `tool-inventory.json` in Quill's store.
  - It costs nothing extra and reflects the exact env of the run.
- **Without a run:** `claude mcp list` (about 1 min, plain text, health per server, URLs must be redacted), `claude mcp get <name>`, plus reading `~/.claude/settings.json` (`enabledPlugins`) and `~/.claude/plugins/installed_plugins.json`. Run it from `quill doctor` or the worker at most hourly. There is no JSON flag, so parse the "name: … - status" lines.
- **Feeding it to the run:** put a short section in `--append-system-prompt-file`:
  - "Connected tools: Atlassian (Jira/Confluence; read allowed, writes become critical changes), Slack (read), …".
  - "Needs auth (unavailable): Notion, Linear, Datadog…".
  - Known CLIs on PATH (kubectl/aws/argocd, detected with `where`).
  - Repo memory of which tool answered what last time.
  - Tell the model MCP tools are deferred and must be loaded with `ToolSearch`, and that `needs-auth` servers must be reported as unavailable (R3), not silently skipped.

### D. Live attempt tracking

- Switch `spawnAgent` to `--output-format stream-json --verbose` and parse line by line.
- Each `assistant` `tool_use` paired with its `user` `tool_result` (`is_error`) is one attempt.
- `system/permission_denied` events (with `decision_reason_type`) and the final `result.permission_denials[]` give the "refused" ledger with no model cooperation. The model's own `attempts[]` cross-checks it.
- The final `result` line carries what `--output-format json` carries today (`result`, `session_id`, `num_turns`, `total_cost_usd`, `is_error`), so `parseAgentResult` can take the last line.

### E. Turn and budget caps

- Today's 40 turns is too low for investigate, try an alternative and verify. A probe that only loads one MCP tool already takes 3 turns: ToolSearch, call, answer.
- Suggested: `analyse` 80, `attempt-fix` 150, self-check 20, repair 3, always paired with `--max-budget-usd` and the existing wall-clock time cap.
- Hitting `--max-turns` is an error exit. Record it as "turn cap reached", which is distinct from failed.

### F. Other settings

- Pass `--agent session-quill:quill-handoff` or an `--agents` file so the shipped agent definition is actually used.
- To make a repo's own `permissions.allow` apply, the worker would have to mark its worktrees trusted in `~/.claude.json`. Prefer leaving them untrusted and passing Quill's rules through `--settings`.

## Open questions

1. **`auto` mode as backstop.** Should `autonomous` use `--permission-mode auto --permission-prompts none` (classifier) plus the Quill guard, instead of `dontAsk`? The classifier would let unanticipated safe actions through, such as novel read CLIs, without Quill listing them. But it costs extra model calls and its decisions are less predictable or explainable. I did not test it here.
2. **Org-level connector policy.** If Paytm's org later sets connector tools to `ask`, `dontAsk` denies them even when a hook allows them. Such tools must be reported as unavailable.
3. **Argo and Kibana.** Neither is configured as an MCP server or connector on this machine. They are either CLIs (`argocd`, `curl` to Kibana) or a future MCP server. The guard rules for them depend on which.
4. **Hook latency.** `mcp__.*` and `Bash` hooks run on every call. Quill's hook is Node, so cold start per call is about 100–200 ms on Windows. This needs measuring under a 150-turn run.
5. **`defer` for mid-flight approval.** `permissionDecision: "defer"` plus `--resume` could pause a run for owner approval instead of spawning a ticket. It is ignored with parallel tool calls and leaves a session on disk indefinitely. It needs a design decision against R6.
6. **Inventory without a model call.** `--init-only` emitted nothing and `/mcp` in `-p` hung under Git Bash. Worth retesting from Node `spawn` (the worker's path) before relying on the `system/init` of real runs only.
7. **Default changes.** If `--bare` becomes the `-p` default, connectors and plugins disappear silently. Gate on `claude_code_version` from init, and fail the run setup if `mcp_servers` is unexpectedly empty.

## P0 results (2026-10-12)

claude 2.1.296 (Claude Code), Windows 11, haiku, `node scripts/probe-autonomous.mjs` (exit 0). Setup: `-p --output-format stream-json --verbose --permission-mode dontAsk --permission-prompts none --max-turns 4 --settings <file>` with a PreToolUse hook (`onFailure: "block"`, matcher Bash|PowerShell|Monitor|mcp__.*|Read|Glob|Grep|Edit|Write|MultiEdit|NotebookEdit|Task|Agent) and no allow rules.

| probe | verdict | note |
| --- | --- | --- |
| hookAllowBash | true | ok |
| hookAllowPowerShell | true | ok |
| hookAllowEdit | true | Write |
| hookAllowMonitor | true | ok; Monitor in tools: true; hook saw: true |
| hookDenyHonoured | true | deny reason reached the model as tool error |
| onFailureBlock | true | crash w/o onFailure: Read ran=true; with block: Read ran=false |
| settingsMergeWithPlugin | true | injected hook fired 1x; plugin hook events seen: true |
| subagentsCarryGuard | true | agent called: true; parent Bash: false; hook saw subagent Bash: 1x |
| initHasMcpSource | true | sources: plugin,claudeai; 25 servers |
| credRedirectHonoured | true |  |
| disableAutoMemory | true | with flag: 0 memory files; control without flag: 2 |
| addDirReadable | true | result: PROBE-TOKEN-7731 |
| maxBudgetFlag | true | flag accepted; cap 0.0005; result subtype "error_max_budget_usd" (0.01 was not exceeded by one short haiku reply) |
| permissionPromptsNoneFlag | true | exit 0; flag accepted by this CLI |
| timeoutBlock | true | hook sleep 15s, timeout 2, onFailure block: Read ran=false |
| credRedirectHonoured.kubectl | n/a | CLI not installed on this machine |
| credRedirectHonoured.aws | n/a | CLI not installed on this machine |
| credRedirectHonoured.gcloud | n/a | CLI not installed on this machine |
| credRedirectHonoured.az | n/a | CLI not installed on this machine |
| credRedirectHonoured.psql | n/a | CLI not installed on this machine |
| credRedirectHonoured.git | true | owner env had one; redirect hid it |

Notes:
- `--permission-prompts none` exists on 2.1.296 (choices host|none).
- `onFailureBlock` was tested on a Read inside cwd (which dontAsk would otherwise allow): a crashing hook without `onFailure` let it run, with `onFailure: "block"` it was blocked; a hook sleeping 15 s with `timeout: 2` was also blocked.
- `subagentsCarryGuard`: a Bash call made by a subagent reached the hook, so `Task`/`Agent` can be allowed when the recipe allows fan-out.
- Credential redirect: only `git` is installed here (kubectl, aws, gcloud, az, psql absent: n/a). With `GIT_CONFIG_GLOBAL` stub and `GIT_CONFIG_NOSYSTEM=1` the owner's credential helper was hidden. `GIT_CONFIG_NOSYSTEM=1` is needed because Git for Windows sets the helper at system level; spec §4.4 should list it.
- `maxBudgetFlag`: a 0.01 cap was not reached by one short haiku reply; 0.0005 produced `error_max_budget_usd`.
- All required hook-allow probes passed, so no P0 fallback to spec §3 is needed.
