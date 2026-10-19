# ADR 0026 — Autonomous access, the run guard and credential isolation

Date: 2026-10-13 · Status: accepted · Builds on [ADR 0017](0017-run-access-levels.md), [ADR 0022](0022-always-on-dashboard.md), [ADR 0023](0023-bulk-runs-and-test-gate.md) and [ADR 0025](0025-remote-run-proposals.md) · Amends ADR 0017 and ADR 0025 (see below) · Spec: `docs/superpowers/specs/2026-10-12-autonomous-runs-design.md` §2–§4, §8–§9

## Context

ADR 0017 gave runs three levels. `standard` is Quill's narrow tool list, with no connectors. `settings` hands every decision to the owner's Claude Code rules, and in an unattended run that means anything needing approval is refused. `full` has no checks at all. None of them behaves like the owner's own interactive session: one that investigates with every connected tool, tries alternatives, and reads production freely while never changing it without consent.

Such a run needs three things. It must be able to use any tool. Something must decide each call against what this run was granted. And the owner's normal credentials must not be reachable from the run's processes, because no command classifier can be complete.

The runtime probes (research 03, "P0 results", Claude Code 2.1.296 on Windows) showed what Claude Code supports:
- A PreToolUse hook's `allow` lets Bash, PowerShell, Monitor, Edit/Write and subagent calls through under `--permission-mode dontAsk` with no allow rules, and its `deny` reaches the model as a tool error.
- `onFailure: "block"` refuses the call when the hook crashes or times out.
- `--settings <file>` hooks run alongside plugin hooks.
- `system/init` reports each MCP server's `source`.
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `--add-dir`, `--max-budget-usd` and `--permission-prompts none` behave as needed.
- git honours the redirected configuration. The other prod CLIs were not installed on the probe machine and are unverified.

## Decision

### Access ladder

`access` gains `autonomous`: `ACCESS = ['standard', 'settings', 'autonomous', 'full']`.

| Tier | Permission mode | Who allows a call | Prod / external writes | Child env | Quill guard |
| --- | --- | --- | --- | --- | --- |
| `standard` | `dontAsk` + Quill's profile | Quill's allow list | no | provider tokens stripped | none |
| `settings` | `default` / `acceptEdits` | the owner's rules | the owner's rules | as before | none |
| **`autonomous`** | `dontAsk` + `--permission-prompts none`, **no static allow rule** | **the guard hook only** | denied as a critical change | every credential location redirected | **enforce, fail closed** |
| `autonomous` + scopes | same | same | only the granted `scope[:target]` | the scope's profile for its own system | enforce, granted scopes covered |
| `full` | `bypassPermissions` | nobody | allowed | the owner's environment | none that denies (observe only) |

- **Defaults.** New runs from the dashboard Run dialog, the bulk dialog, `quill agent run` and `quill handoff` default to `autonomous`. The dialog lists Autonomous (checked), Standard and Full access. "Use my Claude Code settings" (`settings`, kept for compatibility) sits under **Advanced**. A request that names no level is still `standard`, so the following stay standard: schedules, page proposals (ADR 0025), file runs (ADR 0015, which reject any other level) and requests queued before this change. A queued run keeps the access it was recorded with.
- **Full access** carries the note "No Quill guard; prod writes allowed; your Claude Code deny rules still apply." in the dialog and the CLI. Its permission mode and environment are unchanged. The guard runs in observe mode (`QUILL_HANDOFF_GUARD=observe`, a grant with access `full`, and a hook without `onFailure: "block"`): it allows every call, including when it fails, and writes what enforce mode would have decided to the ledger. The observer is set up only when Claude Code is at least 2.1.295; an older one runs the full-access run unobserved, with no `prod_effects`. When the run ends, in any state, the calls enforce mode would have refused as a production or external write become the run's `prod_effects` ({ scope, target, tool, t }; no git, no Quill commands, no call text).
- **Why `dontAsk` plus an allowing hook.** If the hook crashes, times out or is missing, `dontAsk` refuses the call. Under `bypassPermissions` the call would run. The static allow list is empty, so nothing reaches a tool unless the guard said yes. A recipe's `tools` list still narrows the built-in tool families it does not name (Read, Glob, Grep, LS, Bash, PowerShell, Monitor, Edit, Write, MultiEdit, NotebookEdit, WebFetch, WebSearch, Task, Agent). MCP and connector calls are the guard's to decide, so `deploy-check` can still read Argo or Kibana (ruling R8). `Task`/`Agent` are refused unless the run may fan out (ADR 0023); P0 showed that subagent calls carry the guard.
- **Minimum runtime.** `onFailure: "block"` needs Claude Code ≥ 2.1.295. The worker runs `claude --version` (cached for 10 minutes) before it creates a checkout or a process. A version below 2.1.295, or one it cannot read, fails the run with `runtime-too-old` and tells the owner to update or to queue it again with standard access. The init event's `claude_code_version` is checked again, and a run that reports an older runtime is stopped with the same code. `quill doctor` warns about an older Claude Code.
- `--bare` is never used. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are removed from the child unless `[handoff] api_billing = true`, because any of them silently drops claude.ai connectors.

### Wiring

For an autonomous run, dispatch writes these into the run directory `quillHome()/handoffs/runs/<id>/`:
- `grant.json`: `access`, `permissions`, `scopes`, `actionPins` (empty except on a run approved from a critical change, ADR 0028), `readableRoots`, `writableRoots`, `protectedPaths`, `mcpPolicy`, `trustedMcpServers`, `trackerHosts` and `defaultBranch`. It is written once and its SHA-256 goes into `QUILL_HANDOFF_GRANT_SHA256`. A missing or changed file denies everything except local calls that touch no file.
- `run-settings.json`: the guard as a PreToolUse hook (`node bin/quill-guard.js` as command plus arguments, no shell; matcher `Bash|PowerShell|Monitor|mcp__.*|WebFetch|WebSearch|Read|Glob|Grep|Edit|Write|MultiEdit|NotebookEdit|Task|Agent`; timeout 10 s; `onFailure: "block"`), with empty allow and deny lists. It is passed with `--settings`.
- `context/`: the memory snapshot directory, passed with `--add-dir`. It holds the run's memory projections, never the quarantine (ADR 0027).
- `env/`: credential stubs.
- `mcp-servers.json`: `{ "<server>": "<source>" }`, written by the stream collector as soon as the init event arrives (ruling R20).

The agent process gets these variables:
- `QUILL_HANDOFF_ID`, `QUILL_HANDOFF_TICKET_ID`, `QUILL_HANDOFF_TICKET_KEY`
- `QUILL_HANDOFF_ACCESS=autonomous`
- `QUILL_HANDOFF_PERMISSIONS` (the granted keys)
- `QUILL_HANDOFF_SCOPES`
- `QUILL_HANDOFF_GUARD=enforce`
- `QUILL_HANDOFF_GRANT_SHA256`
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`

The plugin's own PreToolUse hook only records the event when `QUILL_HANDOFF_GUARD` is set, so a call is decided once. The worker's test gate and every follow-up turn (repair, self-check, test repair) use the same environment, settings and context directory. The self-check turn also gets no edit tools. On a terminal state everything in the run directory except the ledger is deleted.

Readable roots are:
- the checkout, or the sandbox when the run has no source access
- the run directory and its `context/`
- the temp directories
- Claude's `plugins` and `skills` directories

Writable roots are the run directory and temp. The checkout is writable only when `edit_source` (or `edit_files`/`delete_files`) is granted.

Protected paths are never writable:
- the checkout's `.mcp.json`, `.claude/` and `.git/` (ruling R13)
- the Quill install's guard code
- the run's own `grant.json`, `run-settings.json`, `ledger.jsonl`, `env/` and `mcp-servers.json`
- Claude's settings and credential locations under the home directory

Everything else, including the Quill home outside the run directory, `~/.kube`, `~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.ssh`, `~/.netrc`, `~/.pgpass`, `~/.docker/config.json`, `~/.git-credentials` and `~/.claude*`, cannot be read.

### What the guard decides (spec §4.2)

- **Order of checks:**
  1. an untrusted MCP server
  2. an unparseable command
  3. Quill's own privileged commands, and any start of Claude Code (R57)
  4. file roots and protected paths, with links resolved and wildcards over-approximated
  5. git per-run permissions and protected branches
  6. `unknown-prod`
  7. scopes and action pins
- **Per-run permissions keep their ADR 0017 meaning, and the guard enforces them.** `git commit` needs `commit`. `git push` needs `push_branch` and a non-protected target. `gh pr create` needs `open_draft_pr` and `--draft`. Pushing to the default or a protected branch, force pushes, merges into a protected branch and history rewrites are always denied outside `full`.
- **Quill is privileged.** The `quill` command (in any spelling, `node …/bin/quill.js`, `npx session-quill`) is allowed only for `status`, `ticket show|list|children`, `agent list|show|suggestions`, `handoff list`, `repo list` and `doctor`.
- **No nested Claude Code (ruling R57, final review C1).** A Claude Code session started from a run gets neither the run's `--settings` nor a guard (it inherits `QUILL_HANDOFF_GUARD`, so the plugin's gate stands down too), yet it signs in with the owner's login and loads the owner's claude.ai connectors and user MCP servers. In every tier except `full` the guard refuses, as `QUILL_DENIED nested-claude-code`, any call that would start it: the program `claude`, `claude.exe` or `claude-code` by name or path; `npx`, `pnpm dlx`, `bunx`, `yarn dlx` or `npm exec` of `@anthropic-ai/claude-code` (any version); `node …/@anthropic-ai/claude-code/…` and the native installer's `…/claude/versions/…` binaries; all of these behind wrappers and environment prefixes (`env`, `env -u …`, `VAR= …`, `cmd /c`, `powershell -c`, `sh -c`, `bash -c`, `start`, `xargs`, `nohup`, `timeout`, `exec`, `sudo` …). Any call whose text or words include `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`, or that names the package or binary anywhere (inline code included), is refused the same way, blunt by design (R12–R19 style): the classifier refuses what it cannot show does not start Claude Code. Subagents (Task, Agent) carry the guard and remain the way to fan out.
- **Network writes.** A non-GET/HEAD request, a request body, or a known publish/push verb is `external.write` to its host. Only a scope that covers it allows it. Plain GETs are reads.
- **MCP.** Servers whose source is `claudeai`, `user` or `plugin` are trusted. Any other source (`project`, `local`) is denied unless the server is named in `[handoff] trusted_mcp_servers`, and so is a server the run's `mcp-servers.json` does not list or a missing file. Read verbs are allowed, write verbs are critical changes, and `query`/`execute`/`run*`/`exec*`/`sql` are unknown and denied. The owner can override with `[mcp_policy] read = [...]` and `[mcp_policy.write] "<tool>" = "<scope>"`. Like `handoff` and `prod`, `mcp_policy` is user config only: a repository's `.quill.toml` cannot set it.
- **Shell.** Wrappers and chains are unwrapped, and the strictest segment wins. The recognised prod CLIs use per-binary read-verb lists, and an unknown verb of one of them is a write. SQL is a read only when every statement is a read. Deploy-like script names and inline code naming a prod SDK are `unknown-prod`. Everything else is `local`.
- **Onboarding.** A read through a production CLI (kubectl, helm, aws, gcloud, az, psql, mysql, argocd, …) is refused when the run holds only an empty stub for that system. The refusal is `QUILL_DENIED no-readonly-credentials: no read-only credentials configured for <system> — set them in quill doctor`, so the agent records the route as unavailable instead of chasing an authentication error. The grant's `credentialSystems` lists the systems whose credentials are not a stub.
- **What the agent sees when a call is refused:**
  - `QUILL_CRITICAL_CHANGE scope=<scope> target=<target>: …` for an ungranted write
  - `QUILL_DENIED <reason>: …` for every other refusal
- **Scopes.** A request may carry `scopes: ["name" | "name:target"]`, at most 20 and only with `autonomous` (`scope-needs-autonomous` otherwise, `scope-invalid` for a malformed list). The record keeps them. The scope catalog (built-ins of spec §4.3 plus the user config's `[scopes."<name>"]` tables, never `.quill.toml`) checks them when the request is made (dashboard and CLI alike), when it applies in the worker, and again at dispatch: `unknown-scope` (including any `git.*` name), `invalid-scope-target`, `scope-credentials-missing`, `scope-conflict`. Each scope is data: MCP tool patterns, command patterns and host patterns, a target kind, and the credential variables it switches to (per scope or per target, `env:NAME` for anything secret-looking). The guard covers a write only when its classification names the scope, the target matches what the command names, and a pattern fits, so a scope never authorises more than its patterns and target. Ruling R25 (replacing R24's deny-list): a shell call is covered only by an allow-list kept as data with each scope (`matchers.commands`, src/gate/scope-commands.js): one simple command (no chain, pipe, background, cd, assignment, wrapper or redirect), the tool by its bare name, run inside the checkout, a listed write verb (config-rewriting verbs never), only listed options spelled exactly (no abbreviations), the target option or positional exactly once and equal to the scope target, and for http.write exactly one http(s) URL on the scope host with no port or userinfo. The owner may add verbs and options in config, never a target-changing one. Ruling R26 inspects option values: SQL with a backslash or a client command (`system`, `connect`, `source`, `tee`, `pager` …) is not covered; every file a covered request sends must resolve (links followed) inside the checkout or the run dir, never stdin; `Host`, `X-Forwarded-Host`, `:authority` and headers naming another host are not covered; an image push to a registry host must match the scope's `hosts` (no hosts: the default registry only). Anything else is a critical change whose reason names the rule; in observe mode such a write is recorded with no target (`ambiguous: true`). Owner scopes cover MCP tools only. Every variable a catalog entry references with `env:NAME` is removed from every autonomous run (granted or not); a granted scope sets its value only under its own variable name. config.toml holds no literal secret (secret-looking names, `_PWD`/`_PASS`, database and registry connection URLs, URLs with a password, Authorization values must be `env:NAME`). The grant holds name, target, patterns and a fingerprint (SHA-256 over the canonical table: label, patterns, target, variable names, `env:` references as written, literal values as HMAC-SHA256 under a per-install key in the Quill home, owner-only; used by critical-change approval); the credentials go only into the child environment, through the per-system rules of `buildChildEnv`. A granted scope that needs credentials and got none at dispatch fails the run before it starts.

### Credential isolation (spec §4.4)

`buildChildEnv` redirects every credential location the run's processes would read: Kubernetes, AWS, Google Cloud, Azure, databases, Argo CD, git (helper, ssh, gh, glab), netrc, npm and Docker. Each points at a read-only profile from `[prod.readonly]` or at an empty stub in the run directory. Any other variable whose name looks like a secret is removed unless it is listed in `[handoff] keep_env`. Push permission keeps the owner's git credentials. Bedrock and Vertex sign-in keep that provider's credentials, and the report marks them `provider: 'shared'`.

The run records the report as `cred_report` (one value per system: `readonly | stub | scope | owner`, plus `residual[]`, `scope_errors[]` and `provider`). The Run dialog shows it as of the latest autonomous run, with these warnings:
- **"No read-only credentials configured"** when no system has a read-only profile. It is a warning, not a blocker: the run still works through connectors and local tools.
- every residual entry and every scope error
- a shared provider

### Inventory (spec §5.4, ruling R6)

The first init event of each run is stored on the run as `inventory`: tool names, MCP servers with name, status and source, plugin names, skill names and `version`. It is capped, and plugin paths are dropped. The dashboard's snapshot `meta.autonomy` carries:
- the latest inventory
- the latest autonomous credential report
- which systems `[prod.readonly]` configures (names only)
- the trusted project servers

The dialog's "Connected tools this run can use" lists each connector with its source and status. A `needs-auth` server shows as unavailable, and an untrusted project server as "Not trusted for autonomous runs". Exports, mirrors and publishers never carry `inventory`, `cred_report`, `scopes` or `meta.autonomy`.

### The CLI inside a run (`cli-in-run`)

When `QUILL_HANDOFF_ID` is set, the CLI dispatcher refuses every command except the read list above, before it loads any command module. It exits with code 2 and `quill: refused inside an agent run (cli-in-run)`.

How far this reaches depends on the access level:
- **Every level:** the refusal stops the normal spelling, independently of the guard.
- **Autonomous:** the guard also refuses the forms that clear the variable (`env -u QUILL_HANDOFF_ID quill …`, `unset`, PowerShell `$env:`) and Quill's entry points run by path from any checkout (`bin/quill.js`, `bin/quill-hook.js`, `bin/quill-guard.js`): all are `quill-privileged`.
- **`settings` and `full`:** an agent that clears the variable is stopped only by the owner's own Claude Code rules.

Within those limits, a run cannot use the CLI to approve or dismiss proposals, accept suggestions, queue or cancel runs, edit tickets, publish, or hand back a result with `quill handoff result`. Its result comes from the stream's final result event. The plugin's capture hooks run through `bin/quill-hook.js`, not the dispatcher, so capture inside a run is unchanged. `quill hook` typed as a command is refused like any other. An agent running `bin/quill-hook.js` itself could only forge capture events, never requests; the guard refuses that by path in autonomous runs.

## Boundary statement and residual risk

**The command classifier and the guard are not a security boundary.** For prod in an autonomous run, the boundary is:
- (a) **credential redirection**, so the run's processes resolve only read-only or empty credentials, and
- (b) **read-only credentials on the server side**: a read-only profile must be read-only where it is enforced, not merely named so.

The guard is defence in depth. It turns honest mistakes and most direct writes into refusals and critical-change proposals, and it keeps the run inside its roots. A determined or confused agent can get past the classifier, and then it meets only the credentials the run holds.

**Residual risk accepted.** Credential files stay on disk under the owner's account. The guard denies reading them directly, but a sufficiently indirect script could still open them. Only running the worker as a separate OS user removes that, and that is out of scope.

**Classifier and guard limits accepted** (reviews of the classifier and guard):
- Interpreter reads and writes (`node -e`, `python -c`, …) are `local` unless the inline code names a prod CLI or SDK. Their file access is not checked against the roots.
- Scripts run by name are not inspected.
- Recursive readers follow links already inside the tree: `grep -R`, `cp -rL`, `tar -ch`, `Get-ChildItem -Recurse`.
- Some git commands can write protected git config without reporting paths: `git checkout`, `git restore`, `git apply`, `git update-index --cacheinfo`.
- Links nested inside `.claude` are not followed by the protection.
- `HOME` or `XDG_CONFIG_HOME` pointed at an agent-written config can make git read it.
- Some directory options are not resolved: `go -C`, `gradle -p`, `just -d`, `cargo --manifest-path`.
- The Glob tool with no path can list names through `link/..`.
- `chroot` paths are read as host paths.
- A shell wildcard over very many entries plus a long tail can take 0.8–2.5 s to check.
- Some forms are deliberately over-denied: a wildcard next to an outside-pointing link, `x/..` paths, `cd` after a function definition or `trap`, `source … && …`, failed or computed `cd`, `GIT_DIR=…` prefixes, dynamic `export`/`read` names, `PAGER` exports. The agent rewrites them with literal paths and plain commands.

**Credentials no redirect closes.** The guard is the only layer for each of these, or the owner must act:
1. **Explicit overrides.** `KUBECONFIG=~/.kube/config kubectl …`, `AWS_CONFIG_FILE=~/.aws/config …`, `ssh prod-host`: redirection only changes defaults.
2. **ssh outside git.** `ssh`, `scp` and `rsync` read `~/.ssh/config` Host entries and default keys. No variable redirects them.
3. **netrc through libcurl.** git over https and `curl -n` read `~/.netrc` or `_netrc` in the home directory. libcurl ignores `NETRC`, and `HOME` is never redirected, because Claude Code's own login lives there.
4. **AWS SSO.** A read-only SSO profile copies its `sso-session`. The cached SSO token in `~/.aws/sso/cache` can request every role the owner holds, so use a dedicated identity. `source_profile` and `credential_process` chains are not followed, so they fail.
5. **Kubeconfig exec plugins** (`aws eks get-token`, `gke-gcloud-auth-plugin`, `kubelogin`) run with the redirected environment, but may name owner profiles in their own `env:`.
6. **Azure.** The Az PowerShell context and MSAL cache, and Visual Studio and VS Code accounts.
7. **Keyrings and credential stores** reachable by running a helper directly: `git credential-manager get`, Windows Credential Manager, macOS Keychain, the gh keyring.
8. **Other tools' home-directory credential files**, which are not redirected:
   - Cheap redirects exist but are not applied: Terraform (`TF_CLI_CONFIG_FILE`), gsutil `~/.boto` (`BOTO_CONFIG`), Databricks (`DATABRICKS_CONFIG_FILE`), OCI (`OCI_CLI_CONFIG_FILE`), Helm repositories (`HELM_REPOSITORY_CONFIG`), pip (`PIP_CONFIG_FILE`), npm's global npmrc (`NPM_CONFIG_GLOBALCONFIG`).
   - No redirect exists: `~/.my.cnf`, `~/.mylogin.cnf`, `~/.vault-token`, `~/.yarnrc.yml`, `~/.pypirc`, `~/.cargo/credentials.toml`, `~/.m2/settings.xml`, `~/.gradle/gradle.properties`, doctl, Vercel, Fly, Firebase, Heroku (via netrc).
9. **Names the secret-name filter misses**, such as `OPENAI_KEY`, `*_PAT`, `*_PWD`, `*_PASS`, `*PASSPHRASE`, `*PRIVATE_KEY`, `*_DSN`, URLs with `user:password@`, and `QUILL_*_TOKEN` (the protected prefix wins).
10. **Not covered:** Kibana (`kibana_api_key_env`) and the Foundry provider.
11. **Bedrock or Vertex sign-in** (`provider: 'shared'`): the owner's cloud credentials for that provider are available to the agent too, and the dialog says so.
12. **Instance metadata.** Only AWS IMDS is disabled. The GCE metadata server and Azure IMDS stay reachable on a cloud VM.
13. **The checkout's own `.git/config`.** `http.<url>.extraheader` entries and `user:password@` remote URLs still authenticate git. Emptying a credential helper set there needs git ≥ 2.31 (command-scope config), and `quill doctor` warns on older git.
14. **Windows stub permissions.** File modes do nothing on win32, so stubs inherit the run directory's ACL.
15. **The gh placeholder token.** Without push permission, `GH_TOKEN` is a placeholder so gh never falls back to the keyring. As a result `gh api` fails even for public repositories in such runs. This is expected.
16. **Claude Code's own login (final review C1).** `HOME` keeps the owner's Claude Code login on purpose, so a script that starts Claude Code, or any client holding the claude.ai login, can use the owner's connectors (Jira, Confluence, Slack, Gmail, Argo MCP …) without the guard; credential redirection does not cover it. The guard refuses every spelling of starting Claude Code it can see (R57, above); a script run by name or interpreter code that builds the command at run time is not inspected (the accepted classifier limits). **`full` access may still start Claude Code**: its guard only observes.
17. **Package registries a repository names (M9, deferred).** Once `package.publish` is granted, a covered `npm publish` honours the project's `.npmrc` or `publishConfig.registry`, which can name another registry and interpolate the scope's token. Grant `package.publish` only for repositories whose registry settings you trust.

## Amendments

- **ADR 0017.** The ladder gains `autonomous`, between `settings` and `full`, and it becomes the default for the dashboard and the CLI. `settings` stays valid and moves under Advanced. The per-run permissions (`read_source`, `edit_source`, `commit`, `push_branch`, `open_draft_pr`, `edit_files`, `delete_files`) keep their meanings in every tier except `full`. In `autonomous` they are enforced by the per-run guard, not by Claude Code permission rules. ADR 0017's "Recipe `tools` lists narrow standard runs only" now also covers autonomous runs, but only for the built-in tool families.
- **ADR 0025.** "Only `owner` (the dashboard) and `cli` may approve or dismiss" now has a condition: the CLI cannot approve, dismiss or otherwise act while `QUILL_HANDOFF_ID` is set (`cli-in-run`). Approving a proposal that a run made (run-origin, critical changes), approving or editing memory, and granting scopes are owner dashboard actions only. Page proposals still always ask for `standard` access.

## Consequences

- A default run can use the owner's connectors and local tools without asking, and cannot change production or anything outside its roots. A refusal tells the agent what to do instead, and the reconciled ledger shows it.
- A fresh machine with no read-only profiles still runs autonomously. Production CLIs get empty credentials, and the dialog warns.
- Each autonomous tool call starts the guard process: about 80 ms p95 measured on Windows, and the budget is ≤ 200 ms.
- A run on the Quill repository itself can edit its checkout but never the installed guard.
- Runs on an older Claude Code fail fast with `runtime-too-old` instead of running without a fail-closed guard.
- Owner credentials that no environment variable can redirect remain the owner's responsibility. Using dedicated read-only identities is the mitigation, and a separate OS user is the complete one.

## Alternatives considered

- **`--permission-mode auto` plus the guard.** Rejected for now: the model-based classifier costs extra calls and its decisions cannot be explained or pinned.
- **Static allow rules for safe command forms.** Not needed: every P0 hook-allow probe passed. They stay the fallback if a later Claude Code stops honouring a hook `allow`.
- **`bypassPermissions` with a denying hook.** Rejected: a crashed or timed-out hook would let the call run.
- **Running the worker as a separate OS user.** It is the only complete answer to on-disk owner credentials, but it is out of scope for this release (installation, file ownership and Claude Code login per user).
