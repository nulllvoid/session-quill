# Autonomous agent runs — design

Status: draft rev 2 for owner review (independent review folded in) · Ticket FEAT-12 · 2026-10-12 · Branch `feat/autonomous-runs`
Inputs: [problem statement](../../research/autonomous-runs/00-problem-statement.md), research [01](../../research/autonomous-runs/01-control-and-access.md)–[05](../../research/autonomous-runs/05-codebase-gap-analysis.md), [synthesis](../../research/autonomous-runs/06-synthesis.md). Review log: §15.

## 1. Goal

A Quill agent run behaves like a capable engineer in an interactive Claude session: it investigates, uses every connected tool and the repository's own docs, tries alternatives, verifies by running things, reports every route it tried, and leaves knowledge behind so the next run starts warmer. Production is readable by default and writable only when the owner grants it (per scope, or by choosing full access). Critical writes a run cannot perform become separate local tickets the owner approves; an approved run then performs **that change and nothing else** (enforced, §7.5).

Owner decisions this design follows (2026-10-12): read-only credentials obtainable for most systems; Argo/Kibana via MCP (preferred) **and** CLI fallback; memory auto-files self-verified facts and quarantines tool-sourced facts; full access is trusted; everything ships in one release.

## 2. Non-goals and stated limits

- No cross-machine memory sync, embeddings or vector search.
- No mid-run pause-for-approval (blocked writes become tickets; the run continues).
- No automatic rerun of interrupted runs (remote effects must not repeat blindly; DATA-CONTRACT).
- No change to page-proposed runs' trust: they stay `standard`, unscoped (ADR 0025).
- No Quill guard on `full` access (R7). The owner's own Claude Code deny rules still apply because Claude Code enforces them.
- **Boundary statement (ADR 0026).** The command classifier is not a security boundary. What protects prod in `autonomous` is (a) credential redirection (§4.4), so the run's processes resolve only read-only or empty credentials, and (b) read-only credentials on the server side. **Residual risk:** credential files stay on disk under the owner's account; the guard denies reading them (§4.2), but a sufficiently indirect script could still open them. Only running the worker as a separate OS user removes that, which is out of scope and stated in ADR 0026.

## 3. Access ladder

`access` gains `autonomous`. It becomes the default for new dashboard (single and bulk) and CLI runs. Files runs, schedules and page proposals stay `standard`. `settings` remains a valid value for compatibility (moved under Advanced as "Use my Claude Code settings"); runs already queued keep their recorded access.

| Tier | Permission mode | Who allows a tool call | Prod / external writes | Credentials in the child env | Quill guard |
| --- | --- | --- | --- | --- | --- |
| `standard` | unchanged (`dontAsk` + profile list) | Quill's allow list | no | tokens stripped | — |
| `settings` | unchanged | owner's settings | owner's settings | as today | — |
| **`autonomous`** | `dontAsk` + `--permission-prompts none` | **the guard hook only** (static allow list is empty) | denied → critical change | every credential location redirected (§4.4) | **enforce, fail-closed** |
| `autonomous` + scopes | same | same | only granted `scope[:target]` | elevated profile for each granted scope only | enforce, granted scopes removed from the deny set |
| `full` | `bypassPermissions` | nobody (all allowed) | **allowed** | owner's normal environment | **observe only** (records `prod_effects`, never denies) |

- **Why `dontAsk` + an allowing hook:** if the hook crashes, times out or is missing, `dontAsk` refuses the call; under bypass it would run. Report 03 verified a hook `allow` lets an MCP read through in `dontAsk` and a `deny` reaches the model with its reason. Bash, PowerShell, Edit and Monitor under the same setup are **unverified** and are P0 gate checks; if any fails, that tool family falls back to a generated static allow rule for the exact safe forms and the gap is recorded in ADR 0026.
- **Minimum runtime:** `onFailure: "block"` requires Claude Code ≥ 2.1.295. Dispatch refuses `autonomous` below that version with `runtime-too-old` and offers `standard`.
- `--bare` is never used. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are removed from the child env unless `[handoff] api_billing = true`, because either silently drops claude.ai connectors (report 03).
- **Per-run permissions still apply in every tier except `full`.** `read_source`, `edit_source`, `commit`, `push_branch`, `open_draft_pr`, `edit_files`, `delete_files` keep their ADR 0017 meanings; the guard enforces them (§4.2). Scopes cover *prod and external systems* only; git push and PR stay with `push_branch` / `open_draft_pr` and their existing branch rules.
- **Onboarding state.** With no read-only profiles configured, `autonomous` still works through connectors and local tools; CLI prod reads are denied with "no read-only credentials configured for <system> — set them in `quill doctor`". The dialog shows this as a warning, not a blocker.

## 4. Guard

### 4.1 Wiring

- Pure logic: `src/gate/prod-classify.js` (Bash/PowerShell/MCP/file call → `local | read | write(scope, target) | external.write | privileged | unknown-prod`) and `src/gate/run-guard.js` (classification + access + permissions + scopes + action pins → allow/deny + reason).
- Entry `bin/quill-guard.js`, injected per run through `--settings <run-dir>/run-settings.json` (file path; Windows quoting/length limits) with matcher `Bash|PowerShell|Monitor|mcp__.*|WebFetch|WebSearch|Read|Glob|Grep|Edit|Write|MultiEdit|NotebookEdit|Task|Agent`, `onFailure: "block"`, timeout 10 s. It does not depend on the session-quill plugin being enabled.
- The plugin's existing PreToolUse hook keeps capturing events but **skips gate work when `QUILL_HANDOFF_GUARD` is set**, so a run pays one decision per call, not two.
- Grants reach the guard through env set by the worker on the `claude` process, using the existing `QUILL_HANDOFF_*` prefix: `QUILL_HANDOFF_ACCESS`, `QUILL_HANDOFF_PERMISSIONS`, `QUILL_HANDOFF_SCOPES`, `QUILL_HANDOFF_GUARD=enforce|observe`, `QUILL_HANDOFF_ID`, plus a frozen `<run-dir>/grant.json` (scope matchers, action pins, writable/readable roots, credential profile names) whose SHA-256 is in `QUILL_HANDOFF_GRANT_SHA256`. A hash mismatch or missing file denies everything not `local`.
- Fail closed: any guard exception denies unless the call is Read/Glob/Grep inside the run's readable roots.
- Latency: pure tokenizer/regex, one hashed JSON read, one ledger append; target < 5 ms p95 in-process on top of node start; perf test with 1,000 mixed calls; existing budget p95 ≤ 200 ms per hook.
- **Subagents:** if P0 shows subagent tool calls carry the guard, `Task`/`Agent` are allowed when the recipe allows fan-out; otherwise they are denied in `autonomous`.

### 4.2 Classification rules

**Readable and writable roots** (from `grant.json`):
- Readable: the run's checkout or sandbox, `<run-dir>/context/` (memory snapshot), `<run-dir>/` scratch, the OS temp dir, and Claude plugin/skill directories. Everything else — including `quillHome` outside the run dir (so `_quarantine.md`), `~/.kube`, `~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.ssh`, `~/.netrc`, `~/.pgpass`, `~/.docker/config.json`, `~/.git-credentials` and `~/.claude*` — is denied "outside readable area".
- Writable: the checkout/sandbox only when `edit_source` (attempt-fix) or `edit_files`/`delete_files` (files mode) is granted; `<run-dir>/` scratch and OS temp always. Edit/Write/MultiEdit/NotebookEdit and shell redirects, `rm`, `mv`, `cp`, `Remove-Item`, `Set-Content`, `Out-File` that resolve to a path follow these roots. Paths are resolved and compared case-insensitively on Windows.
- Self-protection: the guard's own code (the Quill install root, `bin/quill-guard.js`, `src/gate/`), `grant.json`, `run-settings.json`, `.claude/settings*.json` in the checkout, `~/.claude.json`, `~/.claude/settings*.json`, `~/.claude/plugins/` and `CLAUDE_PLUGIN_ROOT` are never writable, even when the run's checkout is the Quill repo itself.

**Per-run permissions (ADR 0017):** `git commit` requires `commit`; `git push` requires `push_branch` and a non-protected target branch (existing `isProtectedBranch`); `gh pr create` requires `open_draft_pr` and must pass `--draft`. Pushing to the default or a protected branch, `--force`/`--force-with-lease`, `git merge`/`gh pr merge` into a protected branch, and history rewrites of pushed refs are **always denied** outside `full`, as ADR 0017 says. There is no `git.merge` scope.

**Quill itself is privileged:** `quill`, `node <anything>/bin/quill.js`, `npx session-quill` and the npm-linked shim are allowed only for read subcommands (`status`, `ticket show|list|children`, `agent list|show|suggestions`, `handoff list`, `repo list`, `doctor`). Every other subcommand is denied. Independently, every mutating CLI command refuses to run when `QUILL_HANDOFF_ID` is set in its environment (`cli-in-run` error), and writes to `quillHome` ingress are outside the writable roots. Approving a critical change, approving or editing memory, and granting scopes are **owner dashboard actions only**: the CLI cannot perform them while `QUILL_HANDOFF_ID` is set, and ADR 0026 amends ADR 0025's "owner and CLI" wording accordingly for run-origin proposals.

**Network writes (`external.write`):** any HTTP call with a non-GET/HEAD method, a body (`-d`, `--data*`, `-F`, `--upload-file`, `-T`, `-Body`, `-InFile`, `Invoke-RestMethod/Invoke-WebRequest -Method Post|Put|Patch|Delete`), or a known publish/push verb (`npm publish`, `yarn npm publish`, `pnpm publish`, `docker push`, `podman push`, `twine upload`, `gem push`, `cargo publish`, `helm push`, `gh release create|upload`, `gh api -X POST|PUT|PATCH|DELETE`, `aws s3 cp|mv|sync` with a remote destination, `scp`/`rsync` to a remote) is `external.write` to its host, whatever the host. It is allowed only when a scope covers that host or action. Plain GETs to any host are `read`.

**MCP tools:**
- Server source: allowed sources are `claudeai`, `user` and `plugin` (from `system/init` `mcp_servers[].source`). Servers from a repo's `.mcp.json` (project source) are denied in `autonomous` unless named in `[handoff] trusted_mcp_servers`, because whoever writes the ticket's branch controls them.
- Read verbs: `get|list|search|fetch|read|describe|lookup|view|find|show|count|status|logs`. Write verbs: `create|update|edit|delete|remove|send|post|reply|forward|transition|add|schedule|share|trash|merge|sync|apply|rollback|terminate|restart|scale|deploy|publish|upload|copy|move|label|mark|respond|complete|approve|assign|invite|set`. Anything else — including `query`, `execute`, `run*`, `exec*`, `sql` — is `unknown` → denied, reported "unavailable for policy".
- `readOnlyHint` is not used (not in PreToolUse input; server-supplied).
- Owner overrides live in config: `[mcp_policy] read = ["mcp__x__query_logs"]`, `write = [...]` (each write entry names the scope that covers it). `slack_send_message_draft` ships as a read override.

**Bash/PowerShell:** unwrap `sh -c`, `bash -c`, `cmd /c`, `powershell -Command`/`-EncodedCommand` (decoded), `pwsh -c`, `& exe`, `.exe`/`.cmd`/`.ps1` shims, `$env:X=…;` and `VAR=…` prefixes, `env X=…`, `xargs`, `&&`/`;`/`||`/`|` chains; classify each segment, strictest wins. Recognised prod binaries (`kubectl`, `helm`, `k9s`, `aws`, `gcloud`, `gsutil`, `bq`, `az`, `argocd`, `psql`, `mysql`, `mongosh`, `redis-cli`, `terraform`, `tofu`, `pulumi`, `cdk`, `serverless`, `eksctl`) use per-binary read-verb lists (report 01 §R-2); **an unknown verb of a recognised prod binary is a write**. `kubectl exec|cp|port-forward|debug|proxy|attach` and reading secrets are `k8s.write`. SQL via `-c`/`-e`/stdin is read only if every statement is `SELECT|SHOW|EXPLAIN|DESCRIBE|WITH … SELECT`; `-f <file>` is `unknown-prod`. Repo scripts and package scripts whose names match `deploy|release|publish|apply|migrate|rollout|provision|destroy` are `unknown-prod`. `node -e`/`python -c` inline code that names a prod binary or SDK client (`boto3`, `@aws-sdk`, `@kubernetes/client-node`, `kubernetes`, `pg`, `mysql2`) is `unknown-prod`. Everything else is `local` — safe because credentials are redirected (§4.4).

**Deny reasons** seen by the model:
- `QUILL_CRITICAL_CHANGE scope=<scope> target=<target>: not granted for this run. Record it in critical_changes with action, target, why, evidence, verify and rollback, then continue with everything else.`
- `QUILL_DENIED <reason>: <short explanation>` for permission, root, privileged and policy denials (not critical changes).

### 4.3 Scope catalog

Config only (`config.toml` `[scopes.<name>]`) plus the Run dialog checklist; no catalog editor UI. Built-in defaults:

`jira.write`, `confluence.write`, `slack.post`, `k8s.write:<context>`, `argo.sync:<app|project>`, `cloud.write:<profile>`, `db.write:<env>`, `deploy:<env>`, `http.write:<host>`, `package.publish`.

Each entry: MCP tool-name patterns, Bash matchers, hosts, the credential env to inject when granted (e.g. `KUBECONFIG=<rw path>`), and a fingerprint (hash of the table) recorded on proposals. A scope with no matchers for a call never covers it.

Read-only profiles live under `[prod.readonly]`: `kubeconfig`, `aws_profile` (+ `aws_config_file`), `gcloud_config`, `azure_config_dir`, `db_env` (env file with a SELECT-only DSN), `argocd_token_env`, `kibana_api_key_env`.

### 4.4 Credential isolation (autonomous and autonomous + scopes)

CLIs and SDKs read default credential files even when no env var is set, and a `local` script inherits whatever the child env resolves to. The worker **redirects every credential location** so the owner's normal credentials do not resolve:

| System | Child env in autonomous | When the system's write scope is granted |
| --- | --- | --- |
| Kubernetes | `KUBECONFIG=<prod.readonly.kubeconfig>` or an empty stub in the run dir | `KUBECONFIG=<scope's rw kubeconfig>` |
| AWS | `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` → run-dir files with only the read-only profile (or empty); `AWS_PROFILE` set to it; `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN` removed; `AWS_EC2_METADATA_DISABLED=true` | files with only the scope's profile |
| GCP | `CLOUDSDK_CONFIG` → read-only config dir or an empty run-dir dir; `GOOGLE_APPLICATION_CREDENTIALS` removed or set to the read-only key | scope's config dir |
| Azure | `AZURE_CONFIG_DIR` → read-only dir or empty run-dir dir; `AZURE_CLIENT_*`, `ARM_*` removed | scope's dir |
| Databases | `PGPASSFILE`, `PGSERVICEFILE` → empty stubs; `PG*`, `DATABASE_URL`, `MYSQL_*`, `MONGO*`, `REDIS_URL` removed; the read-only `db_env` variables added | scope's env file |
| Argo / Kibana / trackers / registries | `ARGOCD_AUTH_TOKEN`/`ARGOCD_SERVER` from read-only env names; `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_*`, `JIRA_*`, `ATLASSIAN_*`, `SLACK_*`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` removed; `NPM_CONFIG_USERCONFIG` and `DOCKER_CONFIG` → empty run-dir stubs | the scope's token or config only |
| Git | `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GCM_INTERACTIVE=never`, `GIT_CONFIG_GLOBAL` → run-dir file that copies `user.*` and sets `credential.helper=` (empty, disabling Git Credential Manager); `GIT_CONFIG_NOSYSTEM=1` | when `push_branch` is granted: owner's git config and helper |
| netrc | `NETRC` → empty stub; `HOME`-relative `.netrc` is unreadable via the guard | — |

Then a generic pass: any remaining variable whose name matches `(?i)(token|secret|password|passwd|api_?key|credential|auth)` is removed unless listed in `[handoff] keep_env`. Stubs live under `<run-dir>/env/` and are removed with the run. `full` keeps the owner's environment unchanged (R7). `quill doctor` shows per system "read-only profile: configured / missing" and whether a stub is in effect. P0 verifies each CLI honours the redirection with no fallback to defaults.

## 5. Run method, budgets and result contract

### 5.1 METHOD (replaces `runner.js` METHOD; recipes keep their TASK)

1. Understand the goal and definition of done; write a short plan and hypotheses.
2. Consult the Memory section, the ticket's Run notes (do not retry a failed route unless something changed — say what), the repo docs map and `CLAUDE.md`; open full memory files or docs when a topic is relevant.
3. List the routes that could answer the question or make the change: repo code, tests, git history, connected tools (Jira, Argo, Kibana, Slack…), CLIs with read-only credentials, web.
4. Read production freely where tools allow; changing it is not allowed unless this run grants that scope.
5. Work the most promising route. On failure, refusal or unavailability, record it in `attempts` and try the next. **Do not report a blocker until at least two distinct routes are tried, or every route is recorded unavailable/refused with its reason.**
6. Verify by running tests, builds, linters or queries; record exact commands and results in `verification`. A check not run is "not verified" with the reason.
7. A write outside your granted scopes is a critical change: record it (action, target, why, evidence, verify, rollback, risk) and finish everything else. A refused call is a reason to record, not to stop.
8. Review yourself as a sceptical reviewer: every claim sourced, change matches done-when, no test weakened.
9. Record durable, evidenced facts for future runs in `learnings`; do not restate what repo docs already say.

Recipe changes: `attempt-fix.md` loses "stop and report a blocker"; recipes gain "Definition of done" lines; `deploy-check` names Argo and Kibana read routes; new built-ins `critical-change` (performs one pinned change and verifies it) and `verify-deploy` (post-deploy health via Argo status and Kibana error rates — first candidate to cut, §14).

### 5.2 Budgets

- Recipe frontmatter gains `max_turns` and `max_budget_usd`. Recipes using them must declare `quill_min_version: "1.1.0"`; older Quill rejects unknown keys (`recipes.js:68`), which is documented for shared recipes (ADR 0020). From this release, keys prefixed `x-` are ignored (new behaviour).
- Defaults: main run 80 turns (fix runs 150), repair 4, self-check 20; wall clock `timeout_min` up to **60** (default 30 for autonomous, 20 otherwise); `--max-budget-usd` from `[handoff] max_budget_usd` (default **10**); a bulk batch stops queuing new members once `[handoff] max_batch_budget_usd` (default **30**) of recorded spend is reached. All configurable.
- Turns, duration and cost are recorded. Under a claude.ai subscription the cost is labelled **estimated**.

### 5.3 Result contract additions

Optional for every recipe; stored in the result blob. The handoff record carries only counts (`attempt_count`, `learning_count`, `critical_count`) and `stage_reached`.

```json
{
  "stage_reached": "investigated|planned|changed|tested|committed|pushed|pr_opened|ci_checked|deployed|verified",
  "plan": ["step"],
  "attempts": [{"route": "", "tool": "", "target": "", "outcome": "worked|failed|refused|unavailable|skipped", "reason": "", "evidence": ""}],
  "verification": [{"claim": "", "method": "test|build|lint|query|manual-read", "command": "", "result": "passed|failed|not-run", "detail": ""}],
  "critical_changes": [{"title": "", "scope": "", "target": "", "action": "", "why": "", "evidence": "", "verify": "", "rollback": "", "risk": "low|medium|high"}],
  "learnings": [{"scope": "repo|task|machine", "section": "", "key": null, "kind": "fact|procedure|pitfall|tool|pointer", "text": "", "evidence": [""], "derived_from": "repo-file|own-command|tool-output|external-text"}]
}
```

- `stage_reached` is the agent's claim. The worker computes a separate **recorded stage** from facts it observed (test gate passed → tested; commit SHA → committed; push recorded → pushed; PR URL → pr_opened). Run detail shows the recorded stage; a higher claimed stage appears as "agent reports: deployed (not recorded)" per design system §6.
- Legacy built-ins get the same outputs on both parser paths. Caps: 40 attempts, 15 learnings, 3 critical changes, 20 plan steps, 30 verification rows.

### 5.4 Stream, ledger and logs

- `spawnAgent` switches to `--output-format stream-json --verbose`, parsed line by line. `session_id` is recorded on the handoff when `system/init` arrives.
- **Result parsing** uses only the final `type:"result"` event (its `result` text, `is_error`, `session_id`, `num_turns`, `total_cost_usd`); the last fenced JSON block is taken from that text only — never from tool results elsewhere in the stream. The repair and self-check turns use the same path. No result event → `no-result` failure.
- The stdout buffer is capped (keep the init event, the last result event and a rolling 1 MB window).
- From `system/init`: tool inventory (tools, MCP servers + source + status, plugins, skills, version), stored on the run and merged into machine memory.
- **Ledger** `<run-dir>/ledger.jsonl` (local only): each tool call (name, classified input summary, guard decision, outcome, is_error) with tool **results truncated to 2 KB and redacted** with the existing log redaction. `permission_denials` give the refused set without model cooperation.
- **Log** `logs/handoffs/<id>.log` keeps only the init summary, assistant text, tool names and the result event — no tool results. Ledgers and logs are deleted after `[handoff] log_retention_days` (default 30).
- **Reconciliation:** model `attempts[]` with no matching ledger call are marked "claimed, no tool call seen"; ledger denials missing from `attempts` are added as `refused`. Run detail shows the reconciled ledger.
- Interrupted runs keep `session_id` and the partial ledger; run detail offers **Resume as new run** (`retry_of` + `--resume`). Ledger writes from an interrupted scoped run show as uncertain effects.

## 6. Memory

### 6.1 Store

Source of truth: journal `memory-tx` events (kinds: filed, confirmed, superseded, retired, approved, owner-note, pinned). The worker is the only writer (ADR 0001); agents never write memory. Projections under `quillHome()/memory/` (respects `QUILL_HOME`, so dev-seed stores are isolated; never under `store_path`):

```
_machine.md              tools (name, version, path, last probed), connectors & MCP (source, status, last outcome), how, where, pitfalls
repos/<repo>.md          build & test, conventions, docs & runbooks (pointers), environments & deploy (Argo apps, namespaces, Kibana indexes), procedures, pitfalls, stale
repos/<repo>.owner.md    owner notes, hand-editable, always first
repos/<repo>.docs.md     generated docs map (path — title — headings), cached on HEAD tree hash
_quarantine.md           awaiting owner approval; never copied to runs and outside every run's readable roots
```

Task memory: the ticket gains local-only **Run notes** — the consolidated reconciled attempt ledger and task-scope lessons across all runs — replacing the 3 × 400-char history as the main prior-run carrier (`runHistory` stays for suggestion outcomes).

### 6.2 Filing (worker, in `finish()`)

1. Validate shape, cap, redact secret-like strings.
2. Trust by provenance, not the agent's say-so:
   - **verified** — worker-observed (test gate, denials, inventory), or `own-command` found in the ledger with the claimed exit code;
   - **sourced** — `repo-file` whose cited file:line exists at the cited blob (the line exists; the claim is not proven);
   - **observed** — `own-command` that cannot be matched to the ledger;
   - **quarantined** — `tool-output` / `external-text` (Jira, Kibana, logs, web), anything from a page-proposed run, and instruction-like text (addresses the agent, asks to widen permissions, disable checks, push, contact unknown hosts) regardless of source.
   Verified, sourced and observed entries are filed automatically (owner decision); quarantined entries wait for the owner.
3. Dedupe within scope+section: a match increments `confirmations`.
4. Same `scope`+`key`, different value: a verified new entry supersedes (old kept with `superseded_by`); otherwise both are kept, flagged conflict, and only the higher-trust one is inlined.
5. Entries link to their run; run detail lists "Learnings filed (n)" with trust chips.
6. Staleness: unused and unconfirmed for 90 days → stale (not inlined, still in file); 180 days → retired. No cap on active entries.

### 6.3 Delivery to a run

- Inline **Memory** section inside the data fence, budget `[memory] inline_budget_bytes` (default 48,000), filled in order: this ticket's Run notes → owner notes and pinned → repo build & test / environments / pitfalls ranked by trust (verified > sourced > observed) × recency × confirmations → machine tool inventory and connector outcomes → docs map → headings with counts for the rest.
- Full projections (minus quarantine) copied to `<run-dir>/context/` and passed with `--add-dir`; the prompt names it readable. Edits there are never read back. Removed with the run.
- Sourced entries are re-checked against the run's checkout; changed sources are marked "re-check" rather than dropped.
- Runs set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` so they never write into the owner's Claude Code memory (P0 verifies; if ineffective, `~/.claude/projects/` stays outside the writable roots, which the guard already enforces).
- Sandbox runs (no checkout) get the repo's `CLAUDE.md`/`AGENTS.md` inlined within a 16 KB slice.

### 6.4 Owner review

Owner-only dashboard **Memory** page (Repo / Machine / Quarantine): text, trust chip (text + colour, never colour alone), source run, last confirmed, confirmations; actions Approve, Edit (owner entry supersedes), Pin, Retire, with `expected_revision`. Quarantined learnings and conflicts appear in Runs → Needs you as their own item type. CLI: `quill memory list|show|retire|pin|note` (read and owner-note commands; `approve` and `edit` are dashboard-only while a run is active, and always refused with `QUILL_HANDOFF_ID` set).

## 7. Critical changes

1. A `done` run's `critical_changes[]` entries are validated: the scope must exist in the catalog (unknown scopes kept as text, flagged "no matching scope configured"); `action` is normalised into an **action pin** — for Bash, the tokenised command after unwrapping (binary, verb, resource, namespace/context, flags; free-form values such as image tags kept exact); for MCP, the tool name plus the identifying arguments (issue key, app name, channel).
2. For each entry the worker emits a dedicated **`critical-proposal`** event (not a page proposal), with deterministic id `deterministicId(\`${run}:critical:${i}\`)`, carrying `from_handoff_id`, index `i`, the action pin, scopes and scope fingerprints. The reducer accepts it only when `from_handoff_id` names a `done` run whose stored result blob has entry `i` with the same normalised action, and the id matches the deterministic formula. Page ingress and the CLI cannot produce this event kind.
3. Applying it creates:
   - a **child ticket** (`todo`, tag `critical`, `local_only: true`) with a Goal/Context/Done-when description and a local `critical_spec` (action pin, target, scopes, verify, rollback, risk). `local_only` tickets — title, description, Run notes and spec — are excluded from static exports, the mirror, publishers and tracker push;
   - a **run proposal** (`origin: "run"`) for recipe `critical-change` (built-ins pinned by name+source; "recipe updated since proposed" noted if the hash moved), `access: "autonomous"`, the scopes and the action pin.
4. Runs → Needs you shows "Critical change · <child key> <title> · proposed by run <id8> of <parent key>", scopes as warning chips, the exact action as escaped code, verify and rollback text, and **Approve and queue (scopes: …)** / Dismiss. Approval is a dashboard action by the owner only.
5. Approval re-validates scopes exist with unchanged fingerprints (else `scope-changed`), the recipe, and the child's reservation, then queues one run on the child whose `grant.json` contains the scopes **and the action pin**. In that run the guard allows a write in a granted scope only if it matches the pin (normalised equality; for k8s/Argo/DB the target context/app/env must match exactly); any other write — even in the same scope — is denied as a new critical change. Read calls are unaffected. The grant expires with the run. Its `done` never marks the child done.
6. Proposals keep the 7-day TTL; the child ticket remains and can be run manually by choosing scopes in the Run dialog (then without an action pin, as an explicit owner choice, labelled "scope grant without a pinned action").

`full` runs perform critical writes directly; the observe-mode guard records them as `prod_effects` on the run.

## 8. Developer experience

- **Run agent dialog:** access defaults to Autonomous; "Connected tools this run can use" (last inventory: connectors with source and status, CLIs with read-only profile yes/no, needs-auth servers listed as unavailable, project MCP servers listed as "not trusted for autonomous runs"); Advanced → **Write scopes** checklist from config, each saying what it permits and which credentials it switches to; budget fields; "Use my Claude Code settings" (legacy `settings`); Full access shows "No Quill guard; prod writes allowed; your Claude Code deny rules still apply."
- **Run detail** gains sections (omitted when absent, per design system §5): Plan, Attempts (reconciled), Verification, Critical changes, Learnings filed, Tools used, Recorded stage (+ agent-claimed stage), Turns & cost (estimated under a subscription). Honest language: "Refused (no scope)", "Unavailable (needs auth)", "Not verified", "Claimed, no tool call seen".
- **Access badge** on run rows and the run strip: "Autonomous", "Autonomous + scopes (n)", "Full access".
- **Ticket Runs tab** shows Run notes.
- **CLI:** `quill agent run … --access autonomous|full --scope jira.write --scope k8s.write:stg --max-turns N --budget USD`; `quill memory …`; `quill doctor` reports tool inventory, read-only profile health and runtime version.
- **Design system updates** (in this release): §5 rows for the access badge, Needs you item types (critical change, quarantined learning, memory conflict), Memory page; §6 honest language for recorded vs claimed stage, estimated cost, critical change as proposal; §7 navigation adds Memory under Track (shortcut 8) and defines the Needs you count scope to include the new item types.

## 9. Privacy and data contract

Must land before any new field ships:

1. `sanitizeHandoff` (`src/export/sanitize.js`) switches to an allow list; `attempts`, `learnings`, `critical_changes`, `tool_ledger`, `prod_effects`, scope details, action pins, inventory and memory never appear in static exports, the mirror, publisher payloads or published pages (counts only where useful).
2. Ticket sanitisation drops `local_only` tickets entirely and drops the Run notes and `critical_spec` fields from all tickets.
3. `renderHandoffNote` (`src/worker/notes.js`) uses an allow list; memory and Run notes are never written under `store_path`.
4. Memory, ledgers, grants, env stubs and context snapshots live under `quillHome()` and are never served by static routes.
5. A sentinel test writes a marker learning, attempt, critical spec, action pin, scope, Run note and `local_only` child title and asserts none appears in: static export, mirror, publisher payload, tracker push body, vault note.

DATA-CONTRACT gains: `access: autonomous`; `scopes[]` on requests/records; new result fields and recorded stage; `memory-tx`; `memory-edit`/`memory-forget` requests (owner dashboard only, 10 s undo on forget); `critical-proposal` event; run-proposal `origin`/`from_handoff_id`/`scopes`/action pin; ticket `local_only`, `critical`, local `critical_spec`, local Run notes; `cli-in-run` refusal. New ADRs: **0026** autonomous access, guard, credential isolation and the boundary statement (amends 0017's per-run permission enforcement to include the guard, and 0025's CLI approval for run-origin proposals); **0027** run memory; **0028** critical changes and action pins (amends 0025).

## 10. Other fixes included

- Honour `claude_path` for runs (worker passes config to `createExtension`).
- Base the worktree on the ticket's branch when known (fallback: HEAD, stated in the prompt). Project hooks and `.mcp.json` from that branch still load in the worktree; MCP servers from it are untrusted (§4.2) and project hooks are listed in run detail.
- Remove run worktrees, run dirs and context snapshots on terminal state after the patch is collected (fix worktrees kept 7 days); `git worktree prune` at worker start.
- Self-check under `autonomous` may call read-classified MCP tools; otherwise connector-sourced claims are labelled "not re-verified".
- Worker PATH gaps reported as "not on worker PATH", not "not installed".
- Argo CD and Elastic MCP setup documented (read-only modes); CLIs (`argocd`, Kibana via `curl` with an API key) supported as fallback routes through read-only profiles.

## 11. Testing

- **Unit:** classifier fixtures (≥200 cases: Windows forms, wrappers, encoded PowerShell, chains, SQL, git, network writes, publish verbs, inline SDK code, Quill CLI spellings, MCP names and sources); guard decisions per tier × permissions × scopes × action pins; readable/writable roots including self-protection when the checkout is the Quill repo; grant hash tamper; fail-closed paths; credential redirection (`childEnvFor` per tier: no owner kubeconfig/AWS/gcloud/az/PG/netrc/git-helper/registry credentials resolvable in autonomous; a scope injects only its own profile; full unchanged); `cli-in-run` refusal for every mutating command; filing trust/dedupe/contradiction/quarantine; memory budget fill order; result parsing from the result event only (a fenced JSON block inside a tool result is ignored); caps; recorded vs claimed stage; critical-proposal determinism, replay, spoofing (page ingress, CLI, wrong index, wrong action) rejected; scope fingerprint change rejected; pinned-action enforcement (same scope, different action denied).
- **Integration:** stream-json parsing, ledger, log content (no tool results) and reconciliation with recorded fixtures; buffer cap; interrupted-run resume; worktree and run-dir cleanup; retention.
- **Privacy:** sentinel test (§9.5); existing `tests/ui/*` and `tests/export/*`.
- **Perf:** guard p95 with 1,000 mixed calls; existing hook perf tests stay green with the plugin hook deferring.
- **Browser checks** per design system §8 for the dialog, run detail, Memory page and Needs you items at 390/1024/1280/1440, light/dark, keyboard.
- **Acceptance** (real, on this machine — problem statement §8). Prerequisite owner actions before P6: configure read-only profiles and add the Argo CD and Elastic MCP servers. Then: a run on a ticket needing Jira + repo + Argo/Kibana reads uses them and records attempts; a second run reuses memory; a run without scope proposes a critical change; approval queues a scoped run that performs exactly the pinned change and is denied a different write in the same scope; a full run is not blocked.

## 12. Build order (single release)

| Phase | Scope |
| --- | --- |
| P0 | Gate probes on claude ≥ 2.1.295: hook `allow` lets Bash, PowerShell, Monitor and an in-checkout Edit through in `dontAsk` with an empty allow list; hook `deny` honoured for each; `onFailure: block` on timeout and crash; `--settings` hooks merge with plugin hooks; subagent calls carry the guard; `system/init` exposes `mcp_servers[].source`; kubectl/aws/gcloud/az/psql/git honour §4.4 redirection without default fallback; `CLAUDE_CODE_DISABLE_AUTO_MEMORY` under `-p`; `--add-dir` readability; `--max-budget-usd` and `--permission-prompts none`. Results appended to research 03; failures change the spec before P2. |
| P1 | Privacy allow-lists and `local_only`; METHOD and recipe rewrites; budgets; stream-json result parsing, buffer cap, ledger, log trimming and retention, reconciliation; `attempts`/`verification`/recorded stage; docs map; `claude_path`; branch base; worktree cleanup |
| P2 | `autonomous` tier: classifier, guard, roots, Quill-CLI privilege and `cli-in-run`, credential redirection and read-only profiles, MCP source policy, inventory, runtime version gate, dialog/CLI default; ADR 0026 |
| P3 | Scope catalog config, elevated credential injection per scope, Run dialog scopes, `--scope` CLI, full-access observe ledger |
| P4 | Memory events, projections, filing, delivery, Memory page, CLI, Needs you items; ADR 0027 |
| P5 | Critical changes: `critical-proposal` event, local-only child tickets, run-origin proposals, action pins, scoped approval, `critical-change` and `verify-deploy` recipes; ADR 0028 |
| P6 | Interrupted-run resume, perf, design-system doc updates, browser checks, real end-to-end acceptance, docs and CHANGELOG |

Revised estimate after review: **30–40 working days** for everything in one release.

## 13. Risks

- Classifier evasion (indirect scripts, aliases) — credential redirection makes evasion reach only read-only or empty credentials; residual risk of on-disk credential files stated in ADR 0026.
- Spend rises with turns — per-run and per-batch caps, visible (estimated) cost.
- Built-in recipe rewrites change hashes — open page proposals for built-ins re-pin by name+source with a "recipe updated" note.
- Memory poisoning — provenance trust and quarantine are the boundary; the instruction-like heuristic is secondary.
- P0 failures (e.g. hook allow not honoured for Bash) — fallback to generated exact static rules for safe forms; spec updated before P2.
- Windows: hook spawn cost, PATH under the login task, case-insensitive paths and env names, Git Credential Manager.

## 14. Optional cuts (owner decides; not cut by default)

The owner chose one release. If the 30–40 day estimate is too long, the reviewer's suggested cuts, in order of least loss: `verify-deploy` recipe (−2 d); Resume as new run (−2 d); owner MCP-classification overrides beyond config (already config-only); Memory page edit/pin (keep approve/retire) (−1 d).

## 15. Review log

Rev 2 (2026-10-12) folds in the author's own review and an independent review:
- Critical: Quill CLI self-escalation and self-approval (§4.2 privileged, `cli-in-run`, dashboard-only approvals); owner credentials inherited by the child (§4.4 redirection, readable roots, residual risk in §2); network writes to arbitrary hosts (`external.write`, `http.write`/`package.publish` scopes).
- Major: per-run permissions enforced and mapped, git push/PR stay permissions (§3, §4.2); `git.merge` dropped, ADR 0017 always-deny kept; self-protection vs run dirs under quillHome fixed and paths added; MCP `readOnlyHint` dropped, `query`/`execute`/`run*` unknown, source allowlist; empirical claims narrowed, P0 gate and version check, empty static allow list; stream-json parsing from the result event only, buffer cap, log trimming, retention; action pins enforce "exactly that change"; dedicated `critical-proposal` event with reducer validation; `local_only` child tickets and Run notes, `quillHome()` memory path, quarantine unreadable; `settings` compatibility, onboarding state, frontmatter versioning.
- Minor: recorded vs claimed stage; estimated cost and batch cap; `sourced` trust level; verb lists completed; `api_billing` key; `[mcp_policy]` location; env names use `QUILL_HANDOFF_*`; plugin hook defers to the guard; subagent fallback; design-system updates listed; acceptance prerequisites.
- Build order: credential injection (P3) now precedes critical changes (P5).
