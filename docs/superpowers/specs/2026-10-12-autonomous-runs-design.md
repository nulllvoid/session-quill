# Autonomous agent runs — design

Status: draft for owner review · Ticket FEAT-12 · 2026-10-12 · Branch `feat/autonomous-runs`
Inputs: [problem statement](../../research/autonomous-runs/00-problem-statement.md), research [01](../../research/autonomous-runs/01-control-and-access.md)–[05](../../research/autonomous-runs/05-codebase-gap-analysis.md), [synthesis](../../research/autonomous-runs/06-synthesis.md).

## 1. Goal

A Quill agent run behaves like a capable engineer in an interactive Claude session: it investigates, uses every connected tool and the repository's own docs, tries alternatives, verifies by running things, reports every route it tried, and leaves knowledge behind so the next run starts warmer. Production is readable by default and writable only when the owner grants it (per scope, or by choosing full access). Critical writes a run cannot perform become separate local tickets the owner approves; an approved run then performs exactly that change.

Owner decisions this design follows (2026-10-12): read-only credentials obtainable for most systems; Argo/Kibana via MCP (preferred) **and** CLI fallback; memory auto-files self-verified facts and quarantines tool-sourced facts; full access is trusted; everything ships in one release.

## 2. Non-goals

- No cross-machine memory sync, embeddings or vector search.
- No mid-run pause-for-approval (blocked writes become tickets; the run continues).
- No automatic rerun of interrupted runs (remote effects must not repeat blindly; DATA-CONTRACT).
- No change to page-proposed runs' trust: they stay `standard`, unscoped (ADR 0025).
- No Quill guard on `full` access (R7). The owner's own Claude Code deny rules still apply because Claude Code enforces them.
- The command classifier is not claimed to be a security boundary; read-only credentials are.

## 3. Access ladder

`access` gains the value `autonomous`, which becomes the default for dashboard (single and bulk) and CLI runs. Files runs, schedules and page proposals stay `standard`.

| Tier | Permission mode | Who allows a tool call | Prod / external writes | Credentials in the child env | Quill guard |
| --- | --- | --- | --- | --- | --- |
| `standard` | unchanged (`dontAsk` + profile list) | Quill's allow list | no | tokens stripped | — |
| `settings` | unchanged | owner's settings | owner's settings | as today | — |
| **`autonomous`** | `dontAsk` + `--permission-prompts none` | **the guard hook** (allow on `local`/`read`), plus a small static allow list for built-in local tools | denied → critical change | every credential location redirected (§4.4): read-only profile where configured, empty stub otherwise; tokens stripped | **enforce, fail-closed** |
| `autonomous` + scopes | same | same | allowed only for granted `scope[:target]` | elevated profile for each granted scope only | enforce, granted scopes removed from the deny set |
| `full` | `bypassPermissions` | nobody (all allowed) | **allowed** | owner's normal environment | **off** (observe-only ledger of prod effects) |

Why `dontAsk` with a hook that allows, rather than `bypassPermissions` with a hook that denies: if the hook crashes or times out under `dontAsk`, the call is refused; under bypass it would run. Verified on this machine: a PreToolUse `allow` lets a read through in `dontAsk` with no allow rule, and a `deny` reaches the model with its reason (report 03).

`--bare` is never used, and `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` are removed from the child env unless the owner opted into API billing, because either silently drops claude.ai connectors (report 03).

## 4. Guard

### 4.1 Wiring

- Pure logic in `src/gate/prod-classify.js` (classify a Bash/PowerShell command or MCP call → `local | read | write(scope, target) | unknown-prod`) and `src/gate/run-guard.js` (combine classification, granted scopes and access into allow/deny + reason).
- Entry `bin/quill-guard.js`, injected per run through `--settings <run-dir>/run-settings.json` with matcher `Bash|PowerShell|Monitor|mcp__.*|WebFetch|Edit|Write|MultiEdit|NotebookEdit`, `onFailure: "block"`, timeout 10 s. Passed as a file path (Windows quoting/length limits). It does not depend on the session-quill plugin being enabled; the plugin's own PreToolUse path gains the same check so both agree (deny wins).
- Grants reach the guard through env set by the worker on the `claude` process — `QUILL_RUN_ACCESS`, `QUILL_RUN_SCOPES`, `QUILL_RUN_GUARD=enforce|observe`, existing `QUILL_HANDOFF_ID` — plus a frozen `handoffs/runs/<id>/grant.json` (scope matchers, credential profile names) whose SHA-256 is in `QUILL_RUN_GRANT_SHA256`. A hash mismatch denies everything not `local`.
- Fail closed: any guard exception denies unless the call is a built-in local read (Read/Glob/Grep inside the checkout or context snapshot).
- Latency: pure tokenizer/regex, one hashed JSON read, one ledger append. Target < 5 ms p95 in-process on top of node start; perf test with 1,000 mixed calls. Existing budget p95 ≤ 200 ms per hook.

### 4.2 Classification rules

- **MCP:** read when the tool name's verb is `get|list|search|fetch|read|query|describe|lookup|view` or the server marks `readOnlyHint: true`; write when it is `create|update|edit|delete|send|post|transition|add|schedule|share|trash|merge|sync|apply|rollback|…`; otherwise `unknown` → denied and reported "unavailable for policy" so the owner can classify it (owner classifications persist in machine memory and the scope catalog). `slack_send_message_draft` counts as read-safe.
- **Bash/PowerShell:** unwrap `sh -c`, `bash -c`, `cmd /c`, `powershell -Command`, `& exe`, `.exe`/`.cmd` shims, `$env:X=…;` and `VAR=… ` prefixes, `&&`/`;`/`|` chains (classify each segment; the strictest wins). Recognised prod binaries (`kubectl`, `helm`, `k9s`, `aws`, `gcloud`, `az`, `argocd`, `psql`, `mysql`, `mongosh`, `redis-cli`, `terraform`, `gh`, `git`, `curl`/`Invoke-WebRequest` to configured tracker/Argo/Kibana hosts) use per-binary read-verb lists (report 01 §R-2); **an unknown verb of a recognised prod binary is a write**. `kubectl exec|cp|port-forward|debug|proxy` and reading secrets count as `k8s.write`. SQL passed by `-c`/stdin is read only if every statement is `SELECT|SHOW|EXPLAIN|DESCRIBE|WITH … SELECT`; `-f <file>` is `unknown-prod`. Repo scripts whose names match `deploy|release|apply|migrate|rollout` are `unknown-prod`. Everything else is `local`.
- **Git:** `git push` to a non-default branch requires `git.push`; push to the default branch, `--force`, `git merge` into the default branch and `gh pr merge` require `git.merge`; `gh pr create` requires `git.pr`.
- **File edits:** Edit/Write/MultiEdit/NotebookEdit, and shell redirects or `rm`/`mv`/`Remove-Item` that the tokenizer can resolve to a path, are allowed only when the run has `edit_source` (attempt-fix) or `edit_files` (files mode), and only for paths inside the run's checkout or sandbox; temp files under the run dir and the OS temp dir are always allowed. Everything else is denied with "outside this run's writable area". Writes to the context snapshot are allowed but never read back.
- **Self-protection (autonomous only):** deny writes targeting `quillHome`, `~/.claude/settings*.json`, `CLAUDE_PLUGIN_ROOT`, and `.claude/settings*.json` in the worktree; paths compared case-insensitively after resolve on Windows.
- Deny reason format, seen by the model: `QUILL_CRITICAL_CHANGE scope=<scope> target=<target>: not granted for this run. Record it in critical_changes with action, target, why, evidence, verify and rollback, then continue with everything else.`

### 4.3 Scope catalog

Configured in `config.toml` under `[scopes.<name>]`; built-in defaults ship for:

`jira.write`, `confluence.write`, `slack.post`, `k8s.write:<context>`, `argo.sync:<app|project>`, `cloud.write:<profile>`, `db.write:<env>`, `git.push`, `git.pr`, `git.merge`, `deploy:<env>`.

Each entry holds: MCP tool-name patterns, Bash matchers, the credential env to inject when granted (e.g. `KUBECONFIG=<rw path>`, `AWS_PROFILE=<rw>`), and a fingerprint (hash of the table) recorded on proposals.

Read-only profiles live under `[prod.readonly]`: `kubeconfig`, `aws_profile`, `gcloud_config`, `azure_config_dir`, `db_env` (env file with a SELECT-only DSN), `argocd_auth_token_env`, `kibana_api_key_env`. A system without a read-only profile is reachable in `autonomous` only through its MCP connector (if any); its CLI reads are `unknown-prod` and denied, reported as "no read-only credentials configured".

### 4.4 Credential isolation (autonomous and autonomous + scopes)

CLIs read default credential files even when no env var is set (`~/.kube/config`, `~/.aws/credentials`, gcloud and az config dirs, `~/.pgpass`), and a "local" script the guard allows (e.g. `npm run x` that shells out to kubectl) inherits whatever the child env resolves to. Adding read-only profiles is therefore not enough; the worker **redirects every credential location** in the child env so the owner's normal credentials are unreachable:

| System | Child env in autonomous | When the system's write scope is granted |
| --- | --- | --- |
| Kubernetes | `KUBECONFIG=<prod.readonly.kubeconfig>` or an empty stub file in the run dir | `KUBECONFIG=<scope's rw kubeconfig>` |
| AWS | `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` → a run-dir file containing only the read-only profile (or empty); `AWS_PROFILE` set to it; `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` removed | files containing only the scope's profile |
| GCP | `CLOUDSDK_CONFIG` → read-only config dir or empty run-dir dir; `GOOGLE_APPLICATION_CREDENTIALS` removed or set to the read-only key | scope's config dir |
| Azure | `AZURE_CONFIG_DIR` → read-only dir or empty run-dir dir | scope's dir |
| Databases | `PGPASSFILE`, `PGSERVICEFILE` → empty stubs; `PG*`, `DATABASE_URL`, `MYSQL_*`, `MONGO*`, `REDIS_URL` removed; the read-only `db_env` file's variables added | scope's env file |
| Argo / Kibana / trackers | `ARGOCD_AUTH_TOKEN`, `ARGOCD_SERVER` from read-only env names; `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_*`, `JIRA_*`, `ATLASSIAN_*`, `SLACK_*` and any other `*_TOKEN`/`*_API_KEY`/`*_SECRET` removed (as today's `childEnvFor`, extended) | the scope's token only |
| Git | `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GIT_CONFIG_GLOBAL` → run-dir file without credential helpers | owner's git config and helper |

Stubs and filtered files are written per run under `handoffs/runs/<id>/env/` and removed with the run. The redaction list is a denylist **plus** an allowlist check: any remaining env var whose name matches `(?i)(token|secret|password|passwd|api_?key|credential)` is removed unless it is in `[handoff] keep_env`. `full` access keeps the owner's environment unchanged (R7). `quill doctor` shows, per system, "read-only profile: configured / missing" and whether a stub is in effect.

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

`recipes/attempt-fix.md` loses "stop and report a blocker"; recipes gain Devin-style "Definition of done" lines; `deploy-check` names Argo and Kibana read routes; a new built-in `verify-deploy` recipe checks post-deploy health via Argo status and Kibana error rates; a new built-in `critical-change` recipe performs one approved critical change and verifies it.

### 5.2 Budgets

- Recipe frontmatter gains optional `max_turns` and `max_budget_usd` (unknown-key forward-compat: Quill ignores `x-` prefixed keys; these two are added to the known set).
- Defaults: main run 80 turns (fix runs 150), repair 4, self-check 20; wall clock `timeout_min` up to **60** (default 30 for autonomous, 20 otherwise); `--max-budget-usd` from `[handoff] max_budget_usd` (default **10**). All configurable.
- Turns, cost (`total_cost_usd`) and duration are recorded on the run and shown in run detail.

### 5.3 Result contract additions

Optional for every recipe; parsed and capped like existing fields; stored in the result blob. The handoff record carries only counts (`attempt_count`, `learning_count`, `critical_count`, `stage_reached`).

```json
{
  "stage_reached": "investigated|planned|changed|tested|committed|pushed|pr_opened|ci_checked|deployed|verified",
  "plan": ["…"],
  "attempts": [{"route": "", "tool": "", "target": "", "outcome": "worked|failed|refused|unavailable|skipped", "reason": "", "evidence": ""}],
  "verification": [{"claim": "", "method": "test|build|lint|query|manual-read", "command": "", "result": "passed|failed|not-run", "detail": ""}],
  "critical_changes": [{"title": "", "scope": "", "target": "", "action": "", "why": "", "evidence": "", "verify": "", "rollback": "", "risk": "low|medium|high"}],
  "learnings": [{"scope": "repo|task|machine", "section": "", "key": null, "kind": "fact|procedure|pitfall|tool|pointer", "text": "", "evidence": [""], "derived_from": "repo-file|own-command|tool-output|external-text"}]
}
```

Legacy built-ins get the same new outputs (both parser paths). Caps: 40 attempts, 15 learnings, 3 critical changes per run.

### 5.4 Ground truth and the tool ledger

- `spawnAgent` switches to `--output-format stream-json --verbose`, parsed line by line. `session_id` is recorded on the handoff as soon as `system/init` arrives.
- From `system/init`: the run's tool inventory (tools, MCP servers + status, plugins, skills, version) — stored on the run and merged into machine memory.
- Every `tool_use`/`tool_result` pair and every guard decision appends to `handoffs/runs/<id>/ledger.jsonl` (local only). `permission_denials` give the refused set without model cooperation.
- The worker reconciles the model's `attempts[]` against the ledger: attempts with no matching tool call are marked "claimed, no tool call seen"; denied calls missing from `attempts` are added as `refused`. Run detail shows the reconciled ledger.
- Interrupted runs (worker restart) keep their `session_id` and partial ledger; run detail offers **Resume as new run** (`retry_of` + `--resume`). Ledger prod writes from an interrupted scoped run show as uncertain effects.

## 6. Memory

### 6.1 Store

Source of truth: journal events `memory-tx` (kinds: filed, confirmed, superseded, retired, approved, owner-note, pinned). The worker is the only writer (ADR 0001); agents never write memory. Projections under `~/.claude/quill/memory/` (never under `store_path`):

```
_machine.md              tools (name, version, path, last probed), connectors & MCP (status, last outcome), how, where, pitfalls
repos/<repo>.md          build & test, conventions, docs & runbooks (pointers), environments & deploy (Argo apps, namespaces, Kibana indexes), procedures, pitfalls, stale
repos/<repo>.owner.md    owner notes, hand-editable, always first
repos/<repo>.docs.md     generated docs map (path — title — headings), cached on HEAD tree hash
_quarantine.md           awaiting owner approval; never given to runs
```

Task memory: the ticket gains **Run notes** — the consolidated reconciled attempt ledger and task-scope lessons across all runs — replacing the 3 × 400-char history as the main prior-run carrier (`runHistory` stays for suggestion outcomes).

### 6.2 Filing (worker, in `finish()`)

1. Validate shape, cap, redact secret-like strings.
2. Trust by provenance, not the agent's say-so: worker-observed (test gate, denials, inventory) → verified; `repo-file` whose file:line exists at the cited blob → verified; `own-command` found in the ledger with the claimed exit code → verified, else observed; `tool-output` / `external-text` (Jira, Kibana, logs, web), or any learning from a page-proposed run → **quarantined**.
3. Instruction-like text (addresses the agent, asks to widen permissions, disable checks, push, contact unknown hosts) → quarantined regardless of source.
4. Dedupe within scope+section: a match increments `confirmations`.
5. Same `scope`+`key`, different value: verified new entry supersedes (old kept with `superseded_by`); unverified → both kept, flagged conflict, only the trusted one inlined.
6. Entries link to their run; run detail lists "Learnings filed (n)" with trust chips.
7. Staleness: unused and unconfirmed for 90 days → stale (not inlined, still in file); 180 days → retired. No cap on active entries.

### 6.3 Delivery to a run

- Inline **Memory** section inside the data fence, budget `[memory] inline_budget_bytes` (default 48,000), filled in order: this ticket's Run notes → owner notes and pinned → repo build & test / environments / pitfalls ranked by trust × recency × confirmations → machine tool inventory and connector outcomes → docs map → headings with counts for the rest.
- Full projections (minus quarantine) copied to `handoffs/context/<run-id>/` and passed with `--add-dir`; the prompt names it readable. Edits there are never read back. Removed with the worktree.
- Verified repo-file entries are re-checked against the run's checkout; changed sources are marked "re-check" rather than dropped.
- Runs set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` so they never write into the owner's own Claude Code memory (verified in P0; if the variable is ineffective, runs use `--setting-sources` that excludes auto memory or the feature documents the limitation).
- Sandbox runs (no checkout) get the repo's `CLAUDE.md`/`AGENTS.md` inlined within a 16 KB slice.

### 6.4 Owner review

Owner-only dashboard **Memory** page (Repo / Machine / Quarantine): text, trust chip (never colour alone), source run, last confirmed, confirmations; actions Approve, Edit (owner entry supersedes), Pin, Retire, with `expected_revision`. Quarantined learnings and conflicts appear in Runs → Needs you as their own item type. CLI: `quill memory list|show|approve|retire|pin|note`.

## 7. Critical changes

1. A `done` run's `critical_changes[]` entries are validated (scope must exist in the catalog; unknown scopes kept as text and flagged "no matching scope configured").
2. For each, `recordResult` emits, with deterministic ids from `${run}:critical:${i}`:
   - a **child ticket** (`todo`, tag `critical`, Goal/Context/Done-when description, local-only `critical_spec` holding action, target, scopes, verify, rollback, risk) — for legacy and non-legacy recipes alike;
   - a **run proposal** with `origin: "run"`, `from_handoff_id`, recipe `critical-change` (built-ins pinned by name+source, with "recipe updated since proposed" noted if the hash moved), `access: "autonomous"`, `scopes` = required scopes, scope fingerprints.
3. The reducer accepts `origin: "run"` only from worker emissions, never from page ingress; page proposals stay forced to `standard` without scopes.
4. Runs → Needs you shows "Critical change · <child key> <title> · proposed by run <id8> of <parent key>", scopes as warning chips, the exact action as escaped code, verify and rollback text, and **Approve and queue (scopes: …)** / Dismiss.
5. Approval re-validates scopes exist with unchanged fingerprints (else `scope-changed`), recipe, and the child's reservation, then queues one run on the child with exactly those scopes, expiring with that run. Its `done` never marks the child done.
6. Proposals keep the 7-day TTL; the child ticket remains and can be run manually by choosing scopes in the Run dialog.

`full` runs perform critical writes directly; the observe-mode guard still records them as `prod_effects` on the run so the owner can see what changed.

## 8. Developer experience

- **Run agent dialog:** access defaults to Autonomous; "Connected tools this run can use" (from the last inventory: connectors with status, CLIs with read-only profile yes/no, needs-auth servers listed as unavailable); Advanced → **Write scopes** checklist from the catalog, each saying what it permits and which credentials it switches to; budget fields; Full access shows "No Quill guard; prod writes allowed; your Claude Code deny rules still apply."
- **Run detail** gains sections (omitted when absent, per design system §5): Plan, Attempts (reconciled ledger), Verification, Critical changes, Learnings filed, Tools used, Stage reached, Turns & cost. Honest language: "Refused (no scope)", "Unavailable (needs auth)", "Not verified".
- **Ticket Runs tab** shows Run notes.
- **CLI:** `quill agent run … --access autonomous|full --scope jira.write --scope k8s.write:stg --max-turns N --budget USD`; `quill memory …`; `quill doctor` reports the tool inventory and read-only profile health.
- Honest-state rules (design system §6) extend: a critical change is a proposal, not an action; "Tests passed (worker)" stays distinct from agent claims.

## 9. Privacy and data contract

Must land before any new field ships:

1. `sanitizeHandoff` (`src/export/sanitize.js`) switches to an allow list; `attempts`, `learnings`, `critical_changes`, `tool_ledger`, `prod_effects`, scope details, `critical_spec`, inventory and memory never appear in static exports, the mirror, publisher payloads or published pages (counts only where useful).
2. `renderHandoffNote` (`src/worker/notes.js`) uses an allow list; memory is never written under `store_path`.
3. Memory, ledgers, grants and context snapshots live under `quillHome` and are never served by static routes.
4. A sentinel test writes a marker learning, attempt, critical spec and scope and asserts it appears in none of: static export, mirror, publisher payload, vault note.

DATA-CONTRACT gains: `access: autonomous`, `scopes[]` on requests/records, new result fields, `memory-tx`, `memory-edit`/`memory-forget` requests (owner/cli only, 10 s undo on forget), run-proposal `origin`/`from_handoff_id`/`scopes`, ticket `critical` + local `critical_spec`. New ADRs: **0026** autonomous access and guard, **0027** run memory, **0028** critical changes (amends 0025).

## 10. Other fixes included

- Honour `claude_path` for runs (worker passes config to `createExtension`).
- Base the worktree on the ticket's branch when known (fallback: HEAD, stated in the prompt).
- Remove run worktrees and context snapshots on terminal state after the patch is collected (fix worktrees kept 7 days); `git worktree prune` at worker start.
- Self-check under `autonomous` may call read-classified MCP tools; otherwise connector-sourced claims are labelled "not re-verified".
- Worker PATH gaps reported as "not on worker PATH", not "not installed".
- Argo CD and Elastic MCP setup documented (read-only modes); CLIs (`argocd`, Kibana via `curl` with API key) supported as fallback routes through read-only profiles.

## 11. Testing

- Unit: classifier fixtures (≥150 cases incl. Windows forms, wrappers, chains, SQL, git, MCP names); guard decisions per tier and scope; grant hash tamper; fail-closed paths; credential redirection (`childEnvFor` output per tier: no owner kubeconfig/AWS/gcloud/az/PG paths or secret-like vars reachable in autonomous; scope grants inject only their own profile; full unchanged); edit-path confinement; filing trust/dedupe/contradiction/quarantine; memory budget fill order; result parsing caps; critical-change emission determinism and replay; proposal origin spoofing from page ingress rejected; scope fingerprint change rejected.
- Integration: stream-json parsing and reconciliation with recorded fixtures; interrupted run resume; worktree cleanup.
- Privacy sentinel test (§9.4); existing `tests/ui/*` and `tests/export/*`.
- Perf: guard p95 with 1,000 mixed calls; existing hook perf tests stay green.
- Browser checks per design system §8 for the dialog, run detail, Memory page and Needs you items at 390/1024/1280/1440, light/dark, keyboard.
- Acceptance (real, on this machine — problem statement §8): a run on a ticket needing Jira + repo + Argo/Kibana reads uses them and records attempts; a second run reuses memory; a run without scope proposes a critical change, approval queues a scoped run that performs it; a full run is not blocked.

## 12. Build order (single release)

| Phase | Scope |
| --- | --- |
| P0 | Probes: a PreToolUse `allow` lets **Bash and PowerShell** through in `dontAsk` with no allow rule (report 03 proved it only for an MCP read), and an Edit inside the checkout; kubectl/aws/gcloud/az/psql honour the redirected credential locations of §4.4 with no fallback to defaults; `--settings` hook merges with plugin hooks; subagents inherit the guard; `onFailure: block` behaviour on timeout; `CLAUDE_CODE_DISABLE_AUTO_MEMORY` under `-p`; `--add-dir` readability; `--max-budget-usd` and `--permission-prompts none` on 2.1.296. Results appended to research 03. |
| P1 | Privacy allow-lists; METHOD and recipe rewrites; budgets; stream-json + ledger + reconciliation; `attempts`/`verification`/`stage_reached`; docs map; `claude_path`; branch base; worktree cleanup |
| P2 | `autonomous` tier, classifier, guard, grant file, read-only profiles, inventory, dialog/CLI default; ADR 0026 |
| P3 | Memory events, projections, filing, delivery, Memory page, CLI, Needs you items; ADR 0027 |
| P4 | Critical changes, run-origin proposals, scoped approval, `critical-change` and `verify-deploy` recipes; ADR 0028 |
| P5 | Scope catalog UI and CLI, elevated credential injection, full-access observe ledger |
| P6 | Interrupted-run resume, perf, browser checks, real end-to-end acceptance, docs and CHANGELOG |

Estimated 25–36 working days.

## 13. Risks

- Classifier evasion (scripts, aliases) — mitigated by read-only credentials and `unknown-prod` for deploy-like scripts; stated in ADR 0026.
- Spend rises with turns — budget caps and visible cost per run.
- Built-in recipe rewrites change hashes — open page proposals for built-ins re-pin by name+source with a "recipe updated" note.
- Memory poisoning — provenance trust and quarantine are the boundary; the instruction-like heuristic is secondary.
- Windows: hook spawn cost, PATH under the login task, case-insensitive paths and env names.
