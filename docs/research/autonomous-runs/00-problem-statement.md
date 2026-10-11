# Autonomous agent runs — problem statement

Status: research input · Ticket: FEAT-12 · Opened 2026-10-12 · Branch `feat/autonomous-runs`

This document records what the owner asked for, what the code does today, and the questions research must answer. It is the brief every research report in this folder works from. It is not a design and authorizes no behaviour change.

## 1. The owner's words (verbatim, in order)

1. "our current reciepe isn't autonomouse, not able to do any task just simply stuck, allow it to analyse use memory, repo specific memory task specific memory, alternative ways of achieving, know how things work etc, how can we make reciepe going better over run for running maching keeping track of tools, know how, what, wheres etc."
2. Symptoms seen: **tools refused**, **shallow result**, **forgets context**, and "not exploring alternatives, which session would have. using read only to prod and only approve prod write. how this will work, first run should ask for approval before prod task and their will be local seperate ticket for the task. and manually approved agent will do this."
3. Prod means: **Kubernetes, cloud CLI (aws/gcloud/az), databases, git & deploys**. "critical changes should have seperate tickets created by prev agent, for manual user approval."
4. "basically it should utilize the repo specific docs and ways of doing so and make sure those actions are tried, o report failure. like reading argo, kibana, jira ticket, and such already connected to claude via connectors or skills, plugins mcps etc."
5. "if the user has executed full access mean you are allowed to write to prod also, so have faith on the full access sense etc allow specific access in ther scearios."
6. "create a problem statement and allow research on the solution of this on a broader spectrum, control, Developer, access, e-2-e delivery, context, tools etc. maintain the context, very important."

## 2. Problem

A Quill agent run should behave like a capable engineer working in an interactive Claude session: investigate, use every tool the owner has connected, consult the repository's own docs and conventions, try alternatives when one route fails, verify by running things, and report honestly what it tried. Today it behaves like a note summariser that gives up at the first refusal and forgets everything between runs.

## 3. Evidence (2026-10-12, this machine)

- All 7 recorded runs finished in 19–45 s with 1–5 turns (`C:/Users/shiva/Documents/Quill/handoffs/*.md`, logs in `~/.claude/quill/logs/handoffs/`). Results restate ticket notes; the one attempt-fix (802c3def) concluded "no code changes were needed" in 45 s.
- One run (e6751dbc) failed `interrupted` with an empty log when the worker restarted; there is no rerun.
- **Tools refused.** CLI `agent run`, `handoff` and the dashboard bulk form default to `settings` access, which spawns `claude -p --permission-mode default` with no allow list (`src/handoff/runner.js:216-229`). In print mode anything not pre-allowed by the owner's settings is refused, not prompted. `standard` access passes an explicit `--allowedTools` list that excludes every MCP/connector tool and allows only `git status/diff/log/show`, test runners and `git add` in Bash (`runner.js:238-290`). WebFetch/WebSearch are denied whenever read_source is granted (`runner.js:273`). The prompt itself says anything needing approval is refused (`runner.js:185`).
- **Shallow result / no alternatives.** Recipes say "stop and report a blocker if unclear" (`recipes/attempt-fix.md`); turn caps are 40 / repair 2 / self-check 12 (`runner.js:386`, `extension.js:81-116`); the worktree is created at the repo's current HEAD, not the ticket's branch (`extension.js:269-281`). Nothing asks the agent to enumerate routes, try alternatives, or record attempts.
- **Forgets context.** No memory, learnings or knowledge store exists in `src/`. Prior-run context is only the last 3 runs on the ticket, ≤400 chars each (`src/handoff/context.js:67-79`). No repository information (docs, runbooks, conventions, tool locations) is put in the prompt; `CLAUDE.md` loads only implicitly when the cwd is a worktree, never in sandbox runs.
- **Connectors.** The worker spawns `claude` with the owner's settings and plugins loading normally, but permission modes and allow lists prevent MCP/connector tools (Argo, Kibana, Jira…) from being used. Whether claude.ai connectors load in `claude -p` is unverified.
- **No prod model.** There is no notion of prod read vs prod write, no command guard, no per-scope write grants, and no "critical change" ticket flow. `full` access (`bypassPermissions`) has no checks at all.
- `agents/quill-handoff.md` is never used by the worker (no `--agent` flag); `claude_path` config is ignored by handoffs (`src/cli/commands/worker.js:26`).

## 4. Requirements stated by the owner

R1 **Autonomy.** Runs investigate, try alternative approaches, verify by executing, and do not stop at the first obstacle — "which session would have".
R2 **Use what is connected.** Runs use the owner's connectors, MCP servers, plugins and skills (examples: Argo, Kibana, Jira) and the repo's own docs and ways of doing things.
R3 **Try or report.** Every relevant route is actually attempted; the run reports each attempt and its outcome (worked / failed with reason / unavailable) rather than silently skipping.
R4 **Memory.** Repo-specific memory, task-specific memory, and machine know-how (tools, how, what, where) that improve across runs on this machine.
R5 **Prod read-only by default.** Kubernetes, cloud CLIs, databases, git & deploys can be read freely; writes are not performed.
R6 **Critical changes become tickets.** When a run needs a prod/critical write it lacks permission for, it proposes a separate local ticket for that change; the owner approves it manually; an explicitly approved run performs it.
R7 **Full access is trusted.** `full` access means prod writes are allowed — no guard second-guesses the owner's choice.
R8 **Specific grants.** Between read-only and full, the owner can grant specific write scopes for a run (e.g. Jira writes, kubectl on staging, Argo sync).
R9 **Maintain context.** Decisions and context must persist across sessions and runs (this document, memory, ticket notes).

## 5. Assumptions (not yet confirmed)

A1 Local work in the isolated checkout (read, run tests/scripts, edit when granted) is fully autonomous.
A2 Memory is local to this machine, in Quill's store; never exported, published or synced.
A3 Existing contracts hold: ADRs 0022–0025, DATA-CONTRACT, static-export privacy, pending-vs-confirmed state, per-action side-effect permissions.
A4 The owner is a single developer (Paytm Money context) running Quill locally on Windows.

## 6. Draft direction discussed so far (not approved)

- Access ladder: `standard` (as today) → **`autonomous`** (new default: all connectors/skills load, reads pre-approved, local writes per recipe, prod/external writes guarded) → `autonomous` + **specific write scopes** → `full` (no guard).
- An in-run PreToolUse guard classifies Bash and MCP calls as prod/external writes and denies them with "record as a critical change", plus optional read-only credentials (kubeconfig context, AWS profile, DB env) as the real backstop.
- Result contract gains `learnings[]` (scope repo|task|machine) filed by the worker into `memory/<repo>.md`, ticket "Run notes" and `memory/_machine.md`, deduplicated, capped, attributed, prunable in the dashboard; `critical_changes[]` become proposed critical child tickets; an `attempts[]` ledger records every route tried.
- **Memory size (owner challenged the 8 KB cap: "why only this much?").** Revised: no small hard cap on what a run can see. Inline a compact index (headings, recent and frequently reused facts, tool inventory) with a generous configurable budget (~32–64 KB), and give the run the full memory files as readable paths so it loads detail on demand. Caps exist only to prune stale entries, not to limit visibility. Runs use a 1M-token context model; the real constraints are relevance and per-turn cost.
- Recipe method rewritten to "investigate, consult docs and memory, try ≥1 alternative before reporting a blocker, verify by running"; higher turn caps.

## 7. Research questions (broader spectrum)

| Dimension | Questions |
| --- | --- |
| **Control** | How do other agent platforms gate actions (approval queues, policies, scopes, break-glass, two-person rules)? How should a run pause for approval mid-flight versus spawning a separate ticket? How is cancellation and blast-radius bounded? |
| **Developer** | What does the owner need to see and decide, and when? How do best tools present plans, attempts, evidence and diffs? How do they make agent work trustworthy without micromanagement? |
| **Access** | Least-privilege patterns for agents touching prod: read-only credentials, Kubernetes RBAC, AWS IAM, DB read replicas/roles, JIT elevation, scoped tokens. Reliability of command classification. How Claude Code permission rules, modes and hooks can enforce MCP/Bash scopes headlessly. |
| **End-to-end delivery** | Ticket → investigation → change → tests → PR → CI → deploy (Argo) → verification (Kibana/metrics) → close. Where should the agent stop by default, and how does each stage hand off with evidence? |
| **Context** | Memory designs in agent products (CLAUDE.md, AGENTS.md, Cursor rules, Devin knowledge, OpenHands microagents, Letta/MemGPT, Codex). Curation, deduplication, staleness, poisoning, provenance, size limits. Repo docs discovery. Task memory for retries. |
| **Tools** | What headless `claude -p` actually loads (user/project settings, plugins, skills, MCP servers, claude.ai connectors) and how to permit them. Tool discovery and capability inventory per machine. Try-or-report ledgers. Subagents/fan-out. |

## 8. Success criteria for the eventual feature

- A real run on this machine, given a ticket that needs Jira + repo + Argo/Kibana reading, uses those tools, records attempts, and produces a non-trivial result without being refused.
- A second run on the same repo starts with knowledge the first run recorded, and does not rediscover it.
- A run without write scope that needs a prod write produces a proposed critical-change ticket instead of performing it; approving it queues a run with exactly the needed scope.
- A `full` access run is not blocked by the guard.
- Tests cover the guard classification, scope grants, learnings filing and critical-change proposals.
