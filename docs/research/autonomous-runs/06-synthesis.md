# 06 — Synthesis: autonomous agent runs

Status: research complete, design not yet approved · Ticket FEAT-12 · 2026-10-12

This page reconciles reports 01–05 against the owner's requirements in [00-problem-statement.md](00-problem-statement.md). Where reports disagree, the resolution is stated. Nothing here is implemented.

## 1. What we now know (verified on this machine unless marked)

| Question | Answer | Source |
| --- | --- | --- |
| Do claude.ai connectors load in `claude -p`? | **Yes.** A print run in an empty folder saw Atlassian/Jira, Slack, Gmail, Drive, Calendar, Docs, 16 plugins, 212 skills and Quill's hooks (claude 2.1.296). They vanish with `--bare` or when `ANTHROPIC_API_KEY`/a setup-token is in the env. | 03, 05 (ADR 0017) |
| Argo / Kibana available today? | **No.** No Argo or Kibana connector/MCP server is configured on this machine. They need adding (Argo CD MCP in `MCP_READ_ONLY` mode; Elastic MCP with a scoped API key). | 03, 04 |
| Why are tools refused? | `settings` (the default) → `default` mode with no allow list; `standard` → explicit list without MCP. In `-p`, both `default` and `dontAsk` deny unlisted MCP calls; `mcp__*` approves nothing — rules need a server prefix such as `mcp__claude_ai_Atlassian__get*`. | 03 |
| Can a hook guard runs? | **Yes.** PreToolUse hooks run in `-p`; a deny reaches the model with its reason even over an allow rule; an allow lets a read through in `dontAsk`. Quill's hook already fires on every run tool call (p95 1.7 ms + node start) and receives `QUILL_HANDOFF_ID`. Today a hook crash lets the call through — a guard must fail closed. | 03, 05 |
| Is a command guard a security boundary? | **No.** Claude Code's docs say Bash rules are not one; `sh -c`, `git -C`, `kubectl exec`, `psql -f`, `aws s3 cp` evade patterns; Claude Code's sandbox does not run on native Windows. **Read-only credentials are the boundary**; the guard catches mistakes and converts writes into critical changes. MCP tool-name gating *is* reliable. | 01 |
| Why are runs shallow? | Method, not budget: runs end in 19–45 s against a 40-turn / 20-min cap. Comparable systems allow ~59 min (Copilot) or ~100 iterations (OpenHands). | 04 |
| How do products do memory? | Small always-loaded index + on-demand detail (Claude Code MEMORY.md 200 lines/25 KB, Codex 32 KiB, Cursor/Windsurf rules). Agent-written facts need provenance, re-verification and expiry (Copilot Memory). Memory poisoning from tool output (Jira text, logs) is a published attack class. | 02 |
| Privacy hazard in current code | `sanitize.js:90` passes unknown run fields into exports/mirror; `notes.js:107` writes whole records to vault notes. New fields would leak by default. | 05 |
| Where do other agents stop? | All checked products stop at a draft PR. Deploy and post-deploy verification on the owner's infra is open territory. | 04 |
| Worktree trust | Run worktrees are untrusted: a repo's `permissions.allow` is ignored there, but its hooks and `.mcp.json` still load. Run worktrees are never cleaned up. | 03, 05 |
| Auto-memory leakage | Runs may write into the owner's Claude Code auto-memory via the worktree. Proposed `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in runs — **unverified** under `-p`. | 02 |

## 2. Converged design direction (for approval, by dimension)

### Control
- Blocked writes do **not** stop the run: the guard denies with `QUILL_CRITICAL_CHANGE <scope> <target>`, the agent records it in `critical_changes[]` and finishes everything else.
- The worker turns each critical change into a **proposed child ticket** (reusing run-proposal machinery from ADR 0025, generalised beyond pages) shown in Runs → Needs you. Approving queues one run with **exactly that scope** and an expiry (default: that run). Mid-run pause-for-approval is a later option.
- Budgets: turns ~80 main / ~150 for fix runs (configurable), wall clock up to 60 min, `--max-budget-usd` per run; cost and turns recorded on the run.

### Access (ladder)
| Tier | Runtime | Prod/external writes | Credentials | Quill guard |
| --- | --- | --- | --- | --- |
| `standard` | unchanged | no | tokens stripped | built-in rules |
| **`autonomous`** (new default) | `dontAsk` + generated allow list (every discovered MCP server's tools, Bash/PowerShell, web, edits per recipe) + per-run `--settings` guard hook (fail-closed) + `--permission-prompts none` | denied → critical change | read-only profile per configured system (kube `view`, AWS ViewOnly, SELECT-only DB, Argo RO token) | on |
| `autonomous` + scopes | same | only granted `scope[:target]` | elevated profile for that scope only | on, minus granted scopes |
| `full` | `bypassPermissions` | **yes (R7)** | owner's normal env | **off**; owner's own Claude Code deny rules still apply |

Scope taxonomy (01 §R-2): `jira.write`, `confluence.write`, `slack.post`, `k8s.write:<context>`, `argo.sync:<app>`, `cloud.write:<profile>`, `db.write:<env>`, `git.push`, `git.pr`, `git.merge`, `deploy:<env>`.

### Developer
- Run detail gains: plan, **attempt ledger** (route, tool, outcome worked/failed/refused/unavailable/skipped, reason, evidence), verification table, critical changes, learnings, stage reached, cost.
- The worker **reconciles** the self-reported ledger with ground truth from `stream-json` (actual tool calls, permission denials, MCP server status) so "tried" is provable.
- Run agent dialog shows "Connected tools this run can use" (from `system/init`) and an Advanced → Write scopes section.
- Approval fatigue: the owner approves a few well-described critical changes (action, target, why, evidence, verify, rollback, risk), never individual commands.

### End-to-end delivery
- Stage ladder recorded as `stage_reached`: investigated → planned → changed → tested → committed → pushed → pr_opened → ci_checked → deployed → verified.
- Default stop per tier: `autonomous` reads everything (including Argo status and Kibana logs) but stops before push/deploy unless scoped; `full` may go end to end.
- `deploy-check` and a new post-deploy verify recipe name Argo and Kibana read routes explicitly.

### Context (memory)
- Store: journal `memory-tx` events projected to `~/.claude/quill/memory/` — `_machine.md`, `<repo-id>.md` (build & test, where things live, tools & access, pitfalls), owner notes, a docs map, and `quarantine.md`.
- Task memory: ticket **Run notes** holding the full attempt ledger, replacing the 3×400-char history.
- Filing: `learnings[]` (scope repo|task|machine, text, evidence). Trust by origin — facts the run verified by executing are filed automatically; facts sourced from tool output (Jira text, logs, shared pages) go to quarantine until the owner approves. Duplicates count as confirmations; verified contradictions replace older entries; unused entries expire.
- Delivery: ranked inline index (~48 KB, configurable) + full files readable via `--add-dir` (owner's correction: no small cap on visibility).
- Privacy: owner-only Memory page; never in static exports, mirror or published pages (allow-list hardening first).

### Tools
- Discover per-run inventory from `system/init` (free); persist to machine memory.
- Repo docs index (README, docs/**, runbooks, ADRs) inlined as a map; repo `CLAUDE.md` loads natively in worktrees.
- Honour `claude_path`; base the worktree on the ticket's branch when known.
- Add Argo CD and Elastic/Kibana MCP servers in read-only configuration (owner action, documented).

## 3. Rewritten METHOD (draft, from 04 §R-A)

Hypothesise → consult memory, repo docs and connected tools → read prod freely → attempt; on failure record and try the next route; **no blocker until ≥2 distinct routes are tried or every route is recorded unavailable/refused** → verify by running → record critical changes instead of performing them, and keep going → self-review → record learnings. Remove "stop and report a blocker" from `attempt-fix.md`.

## 4. Build order (from 05 §6, adjusted)

| Phase | Scope | Size |
| --- | --- | --- |
| P0 | Remaining probes: hook deny under `bypassPermissions`; `--settings` hook merge with plugin hooks; subagents inherit hook; `CLAUDE_CODE_DISABLE_AUTO_MEMORY` under `-p`. (Connector loading and allow-rule syntax already answered by 03.) | S, 1 day |
| P1 | METHOD/recipes, configurable turns/time, `attempts[]`, docs index, `claude_path`, branch base, worktree cleanup, **export/vault allow-lists first** | M, 3–5 d |
| P2 | `autonomous` tier, classifier + fail-closed guard, run settings, tool ledger, new default, ADR 0026 | L, 6–8 d |
| P3 | Memory store, `learnings[]`, filing/quarantine, Memory page, ADR 0027 | M–L, 5–6 d |
| P4 | `critical_changes[]`, critical child tickets, scoped approval, ADR 0028 (amends 0025) | M–L, 4–6 d |
| P5 | Scope catalog, read-only/elevated credential profiles, dialog + CLI | M, 3–4 d |
| P6 | stream-json capture, resume interrupted runs, real end-to-end acceptance (00 §8) | M, 3–5 d |

≈ 25–36 working days. P1 alone already fixes "shallow" and part of "forgets"; P2 fixes "tools refused".

## 5. Decisions needed from the owner

1. **Read-only credentials.** Can you obtain read-only prod credentials yourself (kube `view` context, AWS ViewOnly profile, SELECT-only DB user, Argo read-only token)? Without them, `autonomous` should not read prod via CLIs (connector reads are still fine).
2. **Argo / Kibana.** Add Argo CD and Elastic MCP servers to Claude Code now (read-only), or rely on CLIs (`argocd`, `curl` to Kibana) through credentials?
3. **Default tier.** Make `autonomous` the default for new runs from the dashboard and CLI?
4. **Memory trust.** Auto-file self-verified facts, quarantine tool-sourced facts — acceptable, or review everything / nothing?
5. **Budgets.** Turn/time/cost caps per run (proposed 80 turns, 60 min, a USD cap you choose).
6. **Scope of first delivery.** Ship P0–P2 first (autonomy + access) and then memory and critical changes, or one release with everything?
