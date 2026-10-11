# 01 — Control and access for autonomous runs

Status: research report · Ticket FEAT-12 · 2026-10-12 · Input to the design. This report authorizes no behaviour change.
Brief: [00-problem-statement.md](00-problem-statement.md) (requirements R1–R9).

## Summary

- **Every serious agent platform layers three controls:** a policy engine that says allow, ask or deny for each tool call; an OS sandbox and network boundary; and narrowly scoped credentials. Vendors describe command-text rules as best-effort. The backstop that actually holds is the credential, or the OS sandbox. Claude Code's own docs say a Bash deny rule "isn't a security boundary around the program", because `sh -c`, absolute paths and `git -C . push` get past it.
- **Claude Code already has the parts Quill needs to run headless.** These are permission modes (`dontAsk`, `auto`, `bypassPermissions`), allow/ask/deny rules (deny > ask > allow, in every scope), `--disallowedTools`, PreToolUse hooks (exit 2 blocks even when an allow rule matches), a `PermissionDenied` hook, `--permission-prompt-tool` for a pause-for-approval host, and `--permission-prompts none` for unattended runs. Gating MCP tools by name is reliable, because tool names are canonical (`mcp__claude_ai_Atlassian__editJiraIssue`). Gating Bash is not.
- **The OS sandbox does not run on native Windows,** which is the owner's machine (A4). Quill therefore cannot use the sandbox as a backstop. The real boundary for R5 has to be read-only credentials: a kube context bound to `view`, an AWS `ViewOnlyAccess`/`ReadOnlyAccess` profile, a DB role with only SELECT (or a replica), an Argo CD `role:readonly` token, and Argo's MCP server in `MCP_READ_ONLY` mode.
- **For Quill's `autonomous` tier I recommend this combination:**
  - `dontAsk` mode with a generated allow list that includes every connected MCP server's read tools.
  - Scope-derived deny rules.
  - A deterministic, fail-closed Quill PreToolUse guard. It covers Bash, PowerShell, Monitor and MCP. It denies with a structured "record as a critical change" reason and logs the denial for the R6 ticket flow.
  - Per-scope credential profiles injected into the child environment.
  - `full` stays `bypassPermissions` with no Quill guard (R7).
- **R6 should default to "deny, record, continue, propose a child ticket".** Pausing mid-run is a later option (OpenHands' `WAITING_FOR_CONFIRMATION` and Claude Code's `--permission-prompt-tool` both support it). An approved critical-change ticket queues a new run that carries exactly the scopes the proposal named, an expiry, and, optionally, the exact command.

## Findings

### F1. How agent platforms gate actions

| Platform | Gate model | Headless / unattended behaviour | Notes relevant to Quill |
| --- | --- | --- | --- |
| **Claude Code** ([permissions](https://code.claude.com/docs/en/permissions), [modes](https://code.claude.com/docs/en/permission-modes), [hooks](https://code.claude.com/docs/en/hooks), [headless](https://code.claude.com/docs/en/headless)) | Modes: `default`, `acceptEdits`, `plan`, `auto` (a classifier reviews actions), `dontAsk` (auto-denies anything that would prompt) and `bypassPermissions`. Rules are evaluated "deny, then ask, then allow… rule specificity doesn't change the order". "Deny rules block in every mode, including `bypassPermissions`." "Allow rules have no effect in `bypassPermissions`." | In `-p` with no prompt host, prompts become denials. `--permission-prompts none` tells Claude nobody can approve, so it shouldn't retry. Denials appear in `permission_denials` in the JSON result. `--permission-prompt-tool` names an MCP tool that answers prompts, which is a pause-for-approval hook. | PreToolUse hooks run "before every tool call, whether or not it needs permission". A hook that exits 2 "stops the tool call before permission rules are evaluated", even when an allow rule matches. Hook timeouts **fail open** unless `"onFailure": "block"` is set (v2.1.295+). Settings files skip `mcp__` rules with parentheses (argument matching), but `--disallowedTools` accepts them. Allow globs work only after a literal server prefix (`mcp__github__get_*`). |
| **Claude Code auto mode** ([config](https://code.claude.com/docs/en/auto-mode-config)) | A model-based classifier. By default it blocks "Production deploys and migrations", "Granting IAM or repo permissions", "Modifying shared infrastructure", force push, `terraform destroy`, writes to secret managers, merging unapproved PRs, shells or port-forwards into sensitive targets, and more. Hosts named `prod`/`production` are sensitive by default. `autoMode.environment`, `soft_deny` and `hard_deny` are prose rules. | In `-p` "When repeated blocks reach a threshold [3 in a row / 20 total], the action doesn't run and Claude keeps working." The `PermissionDenied` hook fires **only** for classifier denials and receives `tool_input` and a reason such as `[Production Deploy]`. | The classifier ignores `autoMode` in project settings, to resist injection. Allow entries can override org `soft_deny`: "the combination is additive, not a hard policy boundary". Decisions are non-deterministic, so they can't be unit-tested. |
| **OpenAI Codex** ([approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security), [rules](https://developers.openai.com/codex/rules)) | Sandbox modes `read-only`, `workspace-write` (default: "no network access and write permissions limited to the active workspace") and `danger-full-access`. Approval policies are `on-request`, `never` and a granular per-category policy; `untrusted` is retired. `.rules` files use `prefix_rule(pattern, decision=allow\|prompt\|forbidden)`, the most restrictive match wins, and inline `match`/`not_match` cases act as tests. | `approvals_reviewer = "auto_review"` sends approvals to a reviewer agent that denies critical-risk actions, and "Prompt-build, review-session, and parse failures fail closed." In the cloud, the agent phase is offline by default, with a per-environment domain allowlist. | `codex execpolicy check` previews a decision, and admins enforce rules through `requirements.toml`. Quill's guard should copy this shape: a token-prefix policy with inline test cases. |
| **GitHub Copilot coding (cloud) agent** ([risks & mitigations](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations)) | Internet access is restricted by a firewall. The agent pushes to one branch only, either `copilot/*` or the PR's own branch, and "can only perform simple push operations". Branch protections and required checks apply. Only users with write access can trigger it. | "Workflows are not triggered until Copilot cloud agent's code is reviewed" and approved by a user with write access. | **Two-person rule:** "The user who asked for the pull request can't approve it." The credential (the push capability) is the boundary, not command parsing. |
| **OpenHands** ([security guide](https://docs.openhands.dev/sdk/guides/security)) | A security analyzer rates each action LOW/MEDIUM/HIGH/UNKNOWN. The policies are `AlwaysConfirm`, `NeverConfirm` and `ConfirmRisky(threshold=HIGH)`; UNKNOWN is confirmed by default. | A pending action pauses the run with `execution_status=WAITING_FOR_CONFIRMATION`. The host approves and calls `run()` again, or calls `reject_pending_actions()` with feedback "so the agent can try another approach". | This is the reference **mid-run pause** design. The docs warn that `execute_tool()` bypasses the analyzer, so every path into the tool must go through the gate. |
| **Factory Droid** ([droid exec](https://docs.factory.com/cli/droid-exec/overview)) | Read-only by default. `--auto low` allows project file edits; `medium` adds installs, builds, tests, commit and pull; `high` adds remote writes, deploys and migrations, still "subject to Droid's remaining hard safety checks". `--skip-permissions-unsafe` skips prompts but command blocks still apply. | **Fail-fast:** an over-level action "stops immediately with a clear error message, returns a non-zero exit code, and performs no partial changes." "An effective `ask` is not cleared merely by using `--auto high`." | This is the clearest public **autonomy ladder**. It maps closely to Quill's standard → autonomous → +scopes → full. |
| **Devin CLI** ([permissions](https://docs.devin.ai/cli/reference/permissions)) | Normal (reads auto-approved), Accept Edits, Bypass, and Autonomous (only with `--sandbox`; "shell commands and network fetches auto-approve because the OS-level sandbox enforces what they can touch"). Rule syntax is `Exec(prefix)` and `mcp__server__tool`, checked deny > ask > allow. | Org-level deny and ask rules "cannot be overridden by project or user config", even in Bypass or Autonomous mode. | Autonomy is earned by isolation, not by trusting command text. |
| **Cursor cloud agents** ([background agents](https://cursor.com/help/ai-features/background-agents)) | A dedicated VM per agent, owner-chosen secrets and network policy, and secret redaction. Third-party reviews note that commands auto-run. | No per-command approval: the VM and the credentials you give it are the control. | — |
| **Amp** | Has `amp.permissions` rules (allow / ask / reject / delegate to an external program), but I could not fetch primary docs this session (404s). Treat this as unverified. | — | "Delegate" means an external program decides allow or deny. That is the same shape as a Quill guard hook. |

**Cross-cutting patterns**
- **Approval queues:** GitHub requires workflow approval, OpenHands holds a pending-action queue, and Codex sends approvals to a reviewer agent.
- **Scoped grants:** Copilot's single branch, Factory's levels, Codex's granular categories, and Teleport/AWS just-in-time (JIT) grants (see F2).
- **Two-person rule:** Copilot blocks self-approval, and auto mode blocks "Merging a pull request no human has approved, approving Claude's own pull request".
- **Break-glass:** Factory and Codex expose it only as explicit unsafe flags meant for isolated environments. AWS recommends emergency access separate from JIT ([Identity Center temporary elevated access](https://docs.aws.amazon.com/singlesignon/latest/userguide/temporary-elevated-access.html)).

### F2. Least-privilege prod access for agents

| System | Read-only mechanism | Pitfalls | Source |
| --- | --- | --- | --- |
| Kubernetes | A dedicated kube context whose user is bound to the built-in `view` ClusterRole (RoleBinding per namespace, or ClusterRoleBinding). `view` "does not allow viewing Secrets, since reading the contents of Secrets enables access to ServiceAccount credentials… (a form of privilege escalation)". It grants no `pods/exec`, `pods/attach` or `pods/portforward`. | `edit` "allows accessing Secrets and running Pods as any ServiceAccount", so never hand it to a "mostly read" agent. Server-side dry-run is authorized like the real request ([dry-run authorization](https://kubernetes.io/docs/reference/using-api/api-concepts/#dry-run-authorization)), so a `view` identity cannot run `kubectl apply --dry-run=server` or `kubectl diff`. Use `kubectl auth can-i` to verify. | [RBAC default roles](https://kubernetes.io/docs/reference/access-authn-authz/rbac/) |
| AWS | A separate named profile (`AWS_PROFILE=quill-ro`) on a role with `ViewOnlyAccess` (list/describe/metadata, no data reads) or `ReadOnlyAccess` (includes `s3:Get*` and other data reads). Use short-lived SSO credentials from IAM Identity Center. | `ReadOnlyAccess` can read object data and some secrets-adjacent content. Prefer `ViewOnlyAccess`, plus targeted read grants (CloudWatch Logs) through a customer-managed policy. AWS notes `ReadOnlyAccess` doesn't cover every read action. | [ViewOnly vs ReadOnly analysis](https://dev.classmethod.jp/articles/iam-policy-readonly-vs-viewonly/), [re:Post](https://repost.aws/knowledge-center/readonly-policy-missing-permissions) |
| AWS JIT | IAM Identity Center temporary elevated access, or the TEAM open-source sample: request → approve → time-bound account assignment that is removed automatically. | Deploying TEAM is heavy for a single developer. The useful idea is a separate elevated profile that is short-lived and approved per task. | [AWS Security blog: TEAM](https://aws.amazon.com/blogs/security/temporary-elevated-access-management-with-iam-identity-center/) |
| GCP / Azure | A separate gcloud configuration or service account with `roles/viewer` (or narrower), and `az` with the Reader role. Point the agent at them with `CLOUDSDK_ACTIVE_CONFIG_NAME` / `AZURE_CONFIG_DIR`. | `gcloud auth print-access-token` prints a live token, which auto mode blocks by default. | general practice |
| Databases | A login role granted only SELECT (Postgres `pg_read_all_data`, or explicit grants), ideally against a read replica or hot standby, which rejects writes server-side. | `default_transaction_read_only` is only a default: "Any subsequent attempt to change it is equivalent to a `SET TRANSACTION` command", so a session can switch to READ WRITE. It is not a boundary. | [Postgres client config](https://www.postgresql.org/docs/current/runtime-config-client.html) |
| Argo CD | A local account or SSO group with `role:readonly`, or a project-scoped policy such as `p, quill, applications, get, <project>/*, allow`. Writes are separate actions: `sync`, `update`, `delete`, `override`, `action/*`, plus `exec, create`. | A token with `applications, sync` can deploy whatever is in git. `exec` gives a shell. | [Argo CD RBAC](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/) |
| Argo CD MCP | `argoproj-labs/mcp-for-argocd` with `MCP_READ_ONLY=true` disables `create_/update_/delete_/sync_application` and `run_resource_action`. | — | [mcp-for-argocd](https://github.com/argoproj-labs/mcp-for-argocd) |
| Jira / Atlassian | The Rovo MCP server. Admins can allow or block by intent (Read/Write/Search) and by app. OAuth scopes are split (`read:jira-work` vs `write:jira-work`). | The admin data-security policies are "enforced only for OAuth, not API tokens" (third-party summary of Atlassian docs; verify). A single developer usually can't change org-level Rovo settings, so Quill gates by tool name. | [Atlassian Rovo MCP GA](https://www.atlassian.com/blog/announcements/atlassian-rovo-mcp-ga), [prevent access](https://support.atlassian.com/security-and-access-policies/docs/prevent-atlassian-rovo-mcp-server-access/) |
| MCP generally | OAuth 2.1 scopes with step-up: on a write the server returns `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, and the client re-authorizes with more scope. Tokens are audience-bound (RFC 8707); "MCP servers MUST NOT pass through the token". Tool annotations (`readOnlyHint`, `destructiveHint`) exist but "clients MUST consider tool annotations to be untrusted unless they come from trusted servers". | WunderGraph's docs and user-filed issues report that step-up re-authorization is not implemented in Claude Code yet. Don't depend on it. | [MCP authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) |
| JIT brokers | Teleport offers access requests with expiry and "deny new MCP tools by default, JIT access requests for high-risk tools". Opal and ConductorOne offer similar time-bound grants. | These are enterprise products. For one developer, the equivalent is "a scope grant on a single run, with an expiry". | [Teleport JIT](https://goteleport.com/learn/infrastructure-identity/just-in-time-access/), [Teleport MCP](https://goteleport.com/blog/secure-ai-agents-zero-code-mcp/) |

Quill already has a credential precedent. `childEnvFor` strips provider tokens and sets `GIT_TERMINAL_PROMPT=0` unless the run may push (`src/handoff/runner.js:371-381`). Stripping is weaker than substitution, though: `~/.kube/config` and `~/.aws/credentials` still exist on disk and are read by default. The backstop must therefore **point** each CLI at a read-only identity (`KUBECONFIG=<ro file>`, `AWS_PROFILE`/`AWS_CONFIG_FILE`, `PGSERVICEFILE`, `CLOUDSDK_ACTIVE_CONFIG_NAME`, `ARGOCD_AUTH_TOKEN`), not merely unset variables.

### F3. How reliable is read/write classification?

**Claude Code's own statement.** "A Bash rule matches the command text Claude writes… It doesn't match the same program invoked in a different form, so a deny or ask rule … isn't a security boundary around the program." Its examples are `/usr/bin/curl`, `sh -c '…'`, `git -C . push` and `git 'push' origin main`. Claude Code does split compound commands (`&&`, `||`, `;`, `|`, `&`, newlines) and applies deny/ask to every subcommand, including inside `$(…)` and loops. Argument-constraining patterns are "fragile" ([permissions](https://code.claude.com/docs/en/permissions#bash-rule-limits)).

**Concrete pitfalls for prod CLIs**
- **Wrappers and indirection:** `sh -c`, `bash -c`, `powershell -Command`, `cmd /c`, `eval`, `xargs`, `env X=1 cmd`, `timeout`, `nohup`, `npx`, `watch`. Also aliases and functions from shell rc files, git aliases (`git p` → push), `git -c alias.x='!sh -c …'`, and variables (`C=push; git $C`).
- **Scripts:** `./deploy.sh`, `make deploy`, `npm run release`, `python migrate.py`, `terraform apply` through a wrapper. The guard can't see inside them.
- **Read-looking verbs that execute or exfiltrate:**
  - Shells into workloads: `kubectl exec`, `kubectl debug`, `kubectl port-forward`, `kubectl proxy`, `kubectl cp`.
  - Reading secrets: `kubectl get secret -o yaml`, `aws secretsmanager get-secret-value`, `gcloud auth print-access-token`.
  - Remote execution: `aws ssm send-command` / `start-session`, `aws lambda invoke`, `argocd app actions run`.
  - Role escalation: `aws sts assume-role`.
- **Same verb, different direction:** `aws s3 cp s3://b/k .` reads, `aws s3 cp . s3://b/k` writes, and `aws s3 sync --delete` destroys.
- **Hidden context:** the target cluster comes from `--context`, from `KUBECONFIG`, or from current-context in the file. A guard that only reads the command line guesses wrong.
- **SQL:**
  - `psql -c "WITH d AS (DELETE …) SELECT …"` is a write that starts with `WITH`.
  - `SELECT pg_terminate_backend(…)`, `SELECT nextval(…)` and functions with side effects are writes that start with `SELECT`.
  - `COPY … TO PROGRAM` runs a program, and `psql -f file.sql` or a heredoc hides the SQL.
  - Only the DB role or a replica decides this reliably.
- **Windows specifics:**
  - Quill runs on Windows, where Claude Code exposes both `Bash` (Git Bash) and `PowerShell` tools. Claude Code parses the PowerShell AST separately. A guard that inspects only `Bash` misses `PowerShell`, and also `Monitor`, whose commands run through the shell.
  - The sandbox "runs on macOS, Linux, and WSL2. On native Windows, Claude Code runs commands unsandboxed" ([sandboxing](https://code.claude.com/docs/en/sandboxing)).

**Guardrail tools that exist (all are text-level detectors)**
- **Claude Code PreToolUse hooks.** The official docs include a worked `rm -rf` deny example. The JSON on stdin carries `tool_name`, `tool_input` and `permission_mode`. The hook can return `permissionDecision: deny|ask|allow|defer` plus `updatedInput`.
- **[cc-safety-net](https://github.com/kenryu42/cc-safety-net)** (Node). It uses semantic parsing and recursive unwrapping of `bash -c` up to 10 levels across six interpreters. It blocks `git push`, `gh api` writes and PR merges, and has a fail-closed strict mode.
- **[destructive_command_guard (dcg)](https://github.com/Dicklesworthstone/destructive_command_guard)** (Rust). It ships 50 pattern packs and scans heredocs, but **fails open** on timeouts and parse errors.
- **[Codex execpolicy](https://developers.openai.com/codex/rules)** uses prefix rules with inline tests.
- **Review of all three:** "No hook inspects tool calls other than Bash", meaning MCP and Write go uncovered. "Interpreter coverage is incomplete." The review recommends **fail-closed for unattended runs** ([defence-in-depth review, Jul 2026](https://codex.danielvaughan.com/2026/07/17/destructive-command-defence-in-depth-codex-cli-is-dangerous-command-cc-safety-net-dcg-pretooluse-hooks/)).
- **Server-side checks:**
  - `kubectl auth can-i <verb> <resource> --context X` asks the API server what the credential can do, which makes it a good preflight.
  - OPA Gatekeeper or ValidatingAdmissionPolicy enforce policy at the cluster.
  - Argo CD project RBAC.
  - GitHub branch protection and rulesets (the push is accepted or refused on the server).
  - These are the reliable layer for writes that get past the guard.

**Conclusion.** Classify for **routing and honesty** ("this looked like a prod write, so I proposed a ticket instead"), not for security. Run the guard fail-closed on recognized prod binaries and unknown wrappers. Make the credential the thing that guarantees R5. MCP is the easy case: the tool name is canonical and not shell-parsed, so `mcp__<server>__<tool>` gating is exact at tool granularity. Argument-level MCP checks need the hook.

### F4. Mid-run pause or a separate ticket?

| Pattern | Who uses it | Fit for Quill |
| --- | --- | --- |
| Deny and continue; the agent reports | Claude Code `-p`/`dontAsk`, auto mode thresholds | Simple and matches the existing worker. The run keeps investigating. Natural fit for R6. |
| Fail-fast, whole run stops | Factory `droid exec` | Too abrupt for R1. It wastes the investigation. |
| Pause for approval, then resume the same run | OpenHands confirmation mode; Claude Code `--permission-prompt-tool` (an MCP tool that blocks until answered); Agent SDK `canUseTool` | Keeps the context hot, but holds a worker slot and a time cap while waiting. The owner may be away for hours, and the checkout and credentials stay live. Good later as an opt-in "hold up to N minutes" setting. |
| Separate reviewed artifact executed later | Copilot (PR + workflow approval + non-self approval) | Matches R6 exactly. The run proposes, the owner approves a ticket, and a **new** run carrying the granted scope executes it. It is auditable and fits Quill's existing proposals and the pending-vs-confirmed contracts. |

## Options with trade-offs

### O1. Which engine for the `autonomous` tier

| Option | How | Pros | Cons |
| --- | --- | --- | --- |
| **A. `dontAsk` + generated allow list + Quill guard hook** | Allow `Read`, `Glob`, `Grep`, `Bash`, `PowerShell`, the `Edit`/`Write` set per recipe, `WebFetch`, `WebSearch`, `mcp__<server>__*` for each discovered server (or only the read tools), plus a scope-derived deny list. A PreToolUse hook `node <quill>/guard.mjs` with `onFailure: block`. | Deterministic and unit-testable. Works the same on every Claude Code version and plan. Denials are visible in `permission_denials`, and the guard writes a structured ledger. | Quill has to maintain the classification tables. A bare `Bash` allow plus guard means correctness rests on the guard and the credentials. |
| **B. `auto` mode + Quill deny rules + guard** | `--permission-mode auto --permission-prompts none`, with `autoMode.environment` listing the owner's prod namespaces and clusters (passed through `--settings`). | Catches unanticipated destructive actions semantically. The `PermissionDenied` hook captures classifier blocks. | Not deterministic, so it can't be tested. Depends on availability, version and cost. Quietly keeps going after 3/20 blocks. Owner allow entries soften the defaults. |
| **C. `bypassPermissions` + guard** | Like `full`, plus a hook. | Nothing is refused for lack of an allow rule. | `bypassPermissions` also skips protected-path checks (`.git`, `.claude`). Hard to explain. It erases the difference from `full`, and the guard would be the only gate. |
| **D. Credentials only** | Inject read-only profiles, allow everything. | Strongest R5 guarantee for configured systems. | Unconfigured systems get no protection, there is no R6 routing signal, and the agent wastes turns on 403s. |

### O2. Granularity of scopes

- **Coarse levels (Factory style):** easy to explain, but too blunt for R8 ("Jira writes but not kubectl").
- **Named scopes with an optional target (proposed):** `k8s.write:<context>`, `db.write:<env>`. Matches R8, maps cleanly onto credentials, and a proposal can request exactly one.
- **Exact-command grants:** an approved critical-change ticket carries the command it will run (`kubectl -n pay scale deploy/x --replicas=3 --context stg`). This is the most precise and makes a good two-person-style check, but it is brittle when the real fix needs a slightly different command. Offer it as "pin command" on the approval and default to scope + target.

### O3. Approval flow for R6

1. **Deny, record, propose a child ticket (default).** Cheapest and fits the existing proposal machinery.
2. **Opt-in hold.** `--permission-prompt-tool mcp__quill__approve` waits up to N minutes for a dashboard click, then falls back to option 1.
3. **Auto-reviewer (Codex style).** A second model approves low-risk scoped writes. This conflicts with R6's "manual user approval", so don't build it.

## Recommendation for Quill

### R-1. The access ladder

| Tier | Runtime | Prod reads | Prod/external writes | Credentials | Guard |
| --- | --- | --- | --- | --- | --- |
| `standard` | as today: `dontAsk` + Quill profile, no MCP | no | no | tokens stripped | built-in rules only |
| **`autonomous`** (new default) | `dontAsk` + generated allow list (all discovered MCP servers' tools, `Bash`, `PowerShell`, `WebFetch`/`WebSearch`, edits per recipe) + scope-derived `--disallowedTools` + Quill PreToolUse guard (`onFailure: block`) | yes | **denied by the guard** with reason `QUILL_CRITICAL_CHANGE <scope> <target>`, recorded in `critical_changes[]` | read-only profiles injected per configured system; git tokens stripped unless git scopes are granted | on, fail-closed for recognized prod binaries and wrappers |
| `autonomous` + scopes | same | yes | allowed **only** for the granted `scope[:target]`, each grant with an expiry (default: this run) | the elevated profile for that scope only, e.g. `KUBECONFIG=<stg-rw>` for `k8s.write:stg` | on, with the granted scopes removed from the deny set |
| `full` | `bypassPermissions`, no Quill guard, no Quill deny rules beyond today's subagent rule | yes | yes (R7) | the owner's normal environment (`keepCredentials: true`) | **off**. Claude Code's own critical-path `rm` breaker still applies; Quill cannot and should not remove it. |

Notes:
- **R7 compliance:** `full` adds no Quill hook. The owner's own `~/.claude/settings.json` deny rules still apply in every mode, because Claude Code enforces them. Say so in the UI ("your own Claude Code deny rules still apply"). Don't strip them, since that would mean rewriting user settings.
- **Why A and not B for `autonomous`:** tests in success criterion 5 need deterministic classification. Auto mode can be offered as an extra checkbox ("Also use Claude's auto-mode classifier") that switches the mode to `auto` and keeps Quill's deny list and guard. Classifier denials would then reach the ledger through a `PermissionDenied` hook.
- **Pass the guard per run,** through `--settings '{"hooks":{…}}'`, so it never touches the owner's settings files. Use `--permission-prompts none` so Claude knows not to retry denied calls.
- **Discover MCP servers** from the `system/init` event (`mcp_servers`) of a cheap probe run, or the first event of the real run. Read `mcp__claude_ai_<server>__<tool>` names from `tools`. Show them in the Run agent dialog as "Connected tools this run can use". This also answers the open question in the brief about whether connectors load under `-p`.

### R-2. Scope taxonomy

The guard denies a call when it classifies as a write in scope S and S is not granted. Unknown verbs of a recognized prod binary count as writes. Unrecognized binaries are local work, allowed, with the credentials as backstop.

| Scope | Covers | Bash / PowerShell patterns (after unwrapping) | MCP tools (examples on this machine or common servers) | Credential when **not** granted → when granted |
| --- | --- | --- | --- | --- |
| `jira.write` | create/edit/transition/comment/worklog/link issues | `acli jira … create\|edit\|transition`, `curl -X POST\|PUT\|DELETE …/rest/api/` (host in the Jira list) | `mcp__claude_ai_Atlassian__{createJiraIssue,editJiraIssue,transitionJiraIssue,addCommentToJiraIssue,addWorklogToJiraIssue,createIssueLink}` (reads such as `getJiraIssue` and `searchJiraIssuesUsingJql` are always allowed) | connector OAuth is shared, so **the tool-name gate is the boundary**; say so in the UI |
| `confluence.write` | create/update pages, comments | — | `…Atlassian__{createConfluencePage,updateConfluencePage,createConfluence*Comment}` | as above |
| `slack.post` | send/schedule messages, canvases | `curl …slack.com/api/chat.postMessage` | `mcp__claude_ai_Slack__{slack_send_message,slack_schedule_message,slack_create_canvas,slack_update_canvas}` (`slack_send_message_draft` counts as a read-safe draft) | as above |
| `k8s.write:<context>` | any mutating kubectl/helm verb, plus exec, port-forward, cp, debug, proxy, and reading secrets | `kubectl` verbs outside {get, describe, logs, top, explain, api-resources, api-versions, version, cluster-info, auth can-i, config view\|get-contexts\|current-context, events}; `kubectl get secret*`; `helm` outside {list, status, get, history, show, template, lint, search, repo list}; `k9s`. Target = `--context`, else `KUBECONFIG`'s current-context (the guard resolves it). | kubernetes MCP servers' mutating tools | `KUBECONFIG=<ro kubeconfig>` (user bound to `view`) → `<rw kubeconfig for that context>` |
| `argo.sync:<project/app>` | sync, rollback, terminate-op, resource actions | `argocd app sync\|rollback\|terminate-op\|actions run\|set\|patch`, `argocd app delete` (also counts as `deploy`) | `mcp-for-argocd`: `sync_application`, `run_resource_action` (and create/update/delete under `argo.admin`) | `ARGOCD_AUTH_TOKEN` of a `role:readonly` account, plus `MCP_READ_ONLY=true` → a token with `applications, sync, <proj>/<app>` |
| `cloud.write:<provider>:<account\|project>` | mutating aws/gcloud/az calls, IAM, secrets reads, remote exec | `aws` service verbs outside {describe-\*, list-\*, get-\* (except `get-secret-value`, `get-parameter --with-decryption`), `s3 ls`, `s3 cp s3://… <local>`, `logs filter-log-events\|tail\|start-query\|get-query-results`, `sts get-caller-identity`}; `aws ssm send-command\|start-session`, `lambda invoke`, `sts assume-role` count as writes. The same shape applies to gcloud (`list\|describe\|get-iam-policy` are reads; `auth print-*-token` is a write) and az (`list\|show` are reads). | cloud MCP servers' mutating tools | `AWS_PROFILE=quill-ro` (`ViewOnlyAccess` + log read) → the named elevated profile; `CLOUDSDK_ACTIVE_CONFIG_NAME`, `AZURE_CONFIG_DIR` the same way |
| `db.write:<env>` | any non-SELECT statement, and any statement the guard can't see | `psql\|mysql\|mongosh\|redis-cli\|sqlcmd` with `-c`/`-e`/`--eval`: allow only when the statement parses as a single plain `SELECT`/`SHOW`/`EXPLAIN` (no `ANALYZE`, no CTE with DML, no `COPY`, no function call on a deny list). `-f`, a heredoc, stdin or an interactive session counts as a write unless the env's credential is read-only. Migration tools (`flyway`, `liquibase`, `prisma migrate`, `alembic upgrade`, `rails db:migrate`) count as writes. | DB MCP servers' `execute`/`query` tools: treat as a write unless the server is configured read-only | a SELECT-only role, or replica DSN via `PGSERVICEFILE`/env → the RW DSN for that env |
| `git.push` | push to a non-default branch on the ticket's repo | `git … push` with any global options (`-C`, `-c`), `gh repo sync`, `git push --force*` → `git.force` (never in scopes; `full` only) | GitHub MCP `push_files`, `create_or_update_file`, `create_branch` | git tokens stripped (today's `childEnvFor`) → token kept; branch protection is the server-side backstop |
| `git.pr` | open/edit a draft PR, comment | `gh pr create\|edit\|comment\|ready`, `gh api -X POST …/pulls` | GitHub MCP `create_pull_request`, `add_issue_comment` | same token as `git.push` |
| `git.merge` | merge or approve a PR | `gh pr merge\|review --approve`, `git merge` into the default branch, `gh api …/merge` | GitHub MCP `merge_pull_request`, `create_pull_request_review(APPROVE)` | an approval-capable token. Two-person rule: Quill never grants `git.merge` on a PR the same run opened, unless the access is `full`. |
| `deploy:<env>` | anything that changes what runs in an environment outside Argo | `helm upgrade\|install\|rollback`, `kubectl apply\|rollout`, `terraform apply\|destroy`, `pulumi up`, `serverless deploy`, `gh workflow run`, `make deploy`/`npm run deploy\|release` (name heuristics), and posting `/deploy` or `atlantis apply` comments | CI MCP `trigger_workflow`/`run_pipeline` | an env-specific deploy credential; usually also implies `k8s.write`/`cloud.write` for that target |

Rules the guard always applies in `autonomous` (with or without scopes):
1. **Unwrap before classifying:** `sh|bash|zsh|pwsh|powershell|cmd -c`, `eval`, `env`, `xargs`, `timeout`, `nohup`, `npx`, `time`, `watch`. Classify the inner command. If it can't be parsed (variables in the program position, command substitution in the program position, base64 piped to a shell, `curl | sh`), deny with `QUILL_UNPARSEABLE`. This is the cc-safety-net "strict" behaviour.
2. **Look up scripts:** `./x.sh`, `bash x.sh`, `make <t>`, `npm run <t>`, `just <t>`. Look the target up in the checkout. If the script body references a recognized prod binary or a write verb, treat it as that scope. Otherwise allow it as local work. This is heuristic; the credential is the backstop.
3. **Cover every shell tool:** `Bash`, `PowerShell` and `Monitor`, plus MCP (`mcp__.*`). `Write`/`Edit` outside the checkout stay denied by Claude Code's working-directory rules.
4. **Unknown MCP tools:** classify by verb prefix. `get|list|search|read|fetch|lookup|query(read-only server)|describe|view` are reads. `create|edit|update|transition|add|delete|send|post|sync|run|execute|merge|approve|trigger|schedule|share|trash` are writes in the server's scope (`mcp.write:<server>` when there is no specific scope). An explicit per-server override table, stored in Quill config and editable in the dashboard, wins over the heuristic. Use `readOnlyHint` only when the server is on the owner's trusted list.
5. **Record and continue:** every denial returns exit 2 with `QUILL_CRITICAL_CHANGE scope=<s> target=<t> tool=<name> summary=<first 200 chars>`, and appends a JSON line to the run's guard ledger. The worker merges the ledger with the agent's `critical_changes[]` and the JSON result's `permission_denials`, so a proposal exists even if the agent forgets to report it (R3).

### R-3. The critical-change flow (R6)

1. **Detect.** The guard denies the call, and the run continues with other routes (R1). The result contract's `critical_changes[]` entries carry `scope`, `target`, `why`, `proposed_commands[]`, `evidence[]`, `rollback`, `verification`, and the guard ledger ids they correspond to.
2. **Propose.** The worker files each entry as a **proposed** local child ticket (category critical, linked to the parent and the run). It uses the existing proposal and pending state, never "confirmed".
3. **Approve.** The owner reviews it in Runs → Needs you, then picks the scopes to grant (prefilled from the proposal, editable to narrower), an expiry, and optionally pins the commands. The approval records who approved and when. For `git.merge` the approval cannot come from the run that opened the PR.
4. **Execute.** Approval queues a new run on the child ticket: `autonomous` access + exactly the granted scopes, the elevated credential for those scopes only, and the child's plan as the task. Its guard denies anything outside the grant, which can produce a further proposal rather than scope creep.
5. **Verify and close.** The executing run must report verification evidence (Kibana, Argo health, `kubectl rollout status`). Grants expire when the run ends. The ticket records the outcome and links both runs.
6. **Mid-run hold.** Later and optional: let the owner set "hold up to N min for approval". It uses `--permission-prompt-tool` pointed at a Quill MCP tool, keeps the worker slot, and falls back to step 2 on timeout.

### R-4. What to configure on the owner's machine (one-time, guided by the doctor skill)

| System | Configuration |
| --- | --- |
| Kubernetes | A `quill-ro` kubeconfig: per cluster context, a user bound to `view`, checked with `kubectl auth can-i --list`. Optionally an RW kubeconfig per context for `k8s.write:<context>`. |
| AWS | A `quill-ro` SSO profile with ViewOnlyAccess + `CloudWatchLogsReadOnlyAccess`. Elevated profiles are named in Quill config per `cloud.write` target. |
| Databases | A per-env DSN pointing at a replica or SELECT-only role. Quill refuses `db.write:<env>` grants when no RW DSN is configured. |
| Argo CD | A `role:readonly` token for reads, MCP with `MCP_READ_ONLY=true` by default, and a project-scoped sync token per app for `argo.sync`. |
| Unconfigured systems | The doctor should report each prod CLI found on PATH that has **no** read-only profile, labelled plainly as "guarded by command checks only (not a hard boundary)", and the run header should show the same label. |

### R-5. Tests to add (success criterion 5)

- **Guard table tests** in the style of Codex `match`/`not_match`:
  - wrappers: `sh -c "kubectl delete …"`, `git -C . push`, `git -c x=y push`, `pwsh -Command "kubectl apply …"`;
  - kubectl: `kubectl get secret`, `kubectl exec`;
  - AWS: `aws s3 cp` in both directions, `aws ssm send-command`;
  - SQL: `psql -c "WITH d AS (DELETE…) SELECT"`, `psql -f`;
  - helm and Argo: `helm upgrade`, `argocd app sync`;
  - context resolution: from the KUBECONFIG current-context;
  - MCP verb heuristic plus override table.
- **Behaviour tests:**
  - A granted scope removes exactly its own denials.
  - `full` emits no hook and no Quill deny list.
  - A hook timeout blocks.
  - The ledger, `critical_changes` and `permission_denials` merge into one proposal per (scope, target).

## Open questions

1. **Connectors under `-p`.** Do claude.ai connectors (`mcp__claude_ai_*`) load in a worker-spawned `claude -p` with the owner's login? Verify with the `system/init` event on this machine before designing the allow list. (The brief records this as unverified.)
2. **Read-only credentials.** Will the owner (Paytm Money) be allowed to create read-only kube users, AWS profiles and DB roles, or does org IAM forbid self-service? If not, R5 rests on the guard alone, and the UI must say that.
3. **Shared connector OAuth.** Jira and Slack connectors share one OAuth identity across reads and writes, so the tool-name gate is the only boundary. Is that acceptable, or should `jira.write` require a separate API token?
4. **Unknown MCP tools.** Should an unknown MCP tool from an unknown server default to deny-and-propose (safe, but may starve R2) or allow-as-read? This report recommends the verb heuristic with "write" as the fallback.
5. **Auto mode.** Should `autonomous` additionally run Claude's auto-mode classifier by default once the owner's Claude Code version supports it in `-p`, accepting non-deterministic extra denials in exchange for catching unanticipated destruction?
6. **Grant expiry semantics.** Should a grant last for one run only, for one ticket, or for a wall-clock window? Should a retry of a failed executing run inherit the grant automatically?
7. **Owner deny rules under `full`.** If the owner's own `~/.claude/settings.json` deny rules refuse a write under `full`, should Quill surface this as "blocked by your settings" rather than a run failure?
8. **Amp and Cursor.** Their command-approval details could not be confirmed from primary docs this session. They are low priority, because neither changes the recommendation.
