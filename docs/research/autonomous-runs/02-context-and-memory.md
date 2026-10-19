# Context and memory for autonomous runs

Status: research report · Ticket: FEAT-12 · 2026-10-12 · Input: `00-problem-statement.md` (R1–R4, R9, §6 including the revised memory-size direction)

This report covers how agent products keep repo, task and machine knowledge across runs, what goes wrong with stored memory, how retries avoid dead ends, and how to find repository docs cheaply. It ends with a concrete proposal fitted to `src/handoff/context.js` and `buildPrompt` in `src/handoff/runner.js`. It is research input. It authorizes no behaviour change.

## Summary

- **The products have converged on one pattern.** A small, always-loaded index or instruction file, plus detail the agent reads on demand. Examples: Claude Code `MEMORY.md` (first 200 lines or 25 KB) with topic files; skills (descriptions always loaded, bodies on invocation); Windsurf `model_decision` rules; Cursor "Apply intelligently"; OpenHands triggered skills; Codex AGENTS.md chain (32 KiB default, configurable). The owner's revised direction (inline a generous index of about 32–64 KB, pass full files as paths) is this pattern with a bigger inline budget. That is reasonable for a 1M-token model.
- **Who writes memory differs.** Agent-written memory (Claude Code auto memory, Windsurf, Codex) gets used, but it drifts. Human-approved memory (Devin's suggested Knowledge, which is now moving to Skills) is cleaner, but grows slowly. Copilot Memory takes a middle route: agent-written facts carry **citations that are re-checked against the current branch before use**, and facts unused for **28 days** expire. That middle route fits Quill best.
- **Stored memory is a persistent prompt-injection channel.** See MINJA, AgentPoison, SpAIware and OWASP Agentic T1. A learning taken from Jira text, logs or a web page must not become trusted context automatically. Provenance, trust levels and quarantine are required, not optional.
- **Task memory for retries works when it is structured.** Reflexion and ExpeL show gains from verbal lessons and from mining failures. The practical form is an attempts ledger (route, outcome, reason, evidence) that the next run must read, plus a rule against repeating failed routes. Quill already applies that rule to dismissed suggestions.
- **Recommendation.** Keep the canonical record of learnings and attempts in Quill's journal as events. Project them to readable Markdown under `~/.claude/quill/memory/`. Give each run a per-run snapshot reachable with `--add-dir`, inline a ranked index within a configurable budget (default 48 KB), add `learnings[]` and `attempts[]` to the result contract, and let the worker do the filing (dedupe, supersede, verify, quarantine). The owner reviews through a dashboard Memory page. Nothing is exported.

## Findings

### 1. How products do it

| Product | Write path | Retrieval | Scope | Size and lifetime |
| --- | --- | --- | --- | --- |
| **Claude Code CLAUDE.md** | Human (or Claude when asked) | Ancestor files loaded at launch; subdirectory files load when Claude touches that directory; `.claude/rules/*.md` with `paths:` load on matching files; `@imports` expand at launch, up to 4 hops | Managed, user, project, local | Target under 200 lines; files up to 4 MiB load in full. Imports organize text but do not reduce context cost |
| **Claude Code auto memory** | Claude, as it works. Types: user, feedback, project, reference. It skips what is derivable from code or already in CLAUDE.md | `MEMORY.md` index: **first 200 lines or 25 KB loaded every session**; topic files read on demand with normal file tools | Per git repository, **shared across worktrees**; machine-local | Kept until edited; a `modified` timestamp is written in frontmatter; Claude Code warns when the index nears its limit and tells Claude to merge or drop stale entries. Directory can be moved with `autoMemoryDirectory` (also from `--settings`); disabled with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| **Claude Code skills** | Human | Description always listed (truncated at 1,536 chars); body loads on invocation; supporting files load on demand | Personal, project, plugin, `--add-dir` | SKILL.md under 500 lines |
| **Anthropic memory tool** (API) | Model, through a client-side `/memories` directory | API injects "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE" | Whatever the handler maps | Docs advise size caps per file, paging `view`, expiring unaccessed files, path-traversal checks, stripping sensitive data |
| **AGENTS.md** | Human | Nearest file in the tree takes precedence | Repo and subdirectory | Read by Codex, Copilot agent, Cursor, Devin, Windsurf, Jules, Gemini CLI and others; also by Claude Code when no CLAUDE.md exists |
| **OpenAI Codex** | AGENTS.md by humans; **Memories** generated in the background from idle chats (off by default) | AGENTS chain concatenated root-first, once per run; memories injected when `use_memories` is set | Global `~/.codex`, project chain | `project_doc_max_bytes` **32 KiB default** (example raises it to 64 KiB). Memories redact secrets; `disable_on_external_context` keeps chats that used MCP or web out of memory generation |
| **Cursor** | Human rules (`.cursor/rules/*.mdc`), user rules, AGENTS.md | Always / Apply intelligently (by description) / Specific files (globs) / Manual (@-mention) | Project, user | Rules under 500 lines. The current rules page does not mention Memories |
| **Devin Knowledge** | Devin **suggests** items from chat feedback; a person edits or dismisses before saving | Trigger description; retrieved "when relevant, not all at once"; `!macro` | Org, enterprise, pinned to a repo or all repos | Being deprecated in favour of Skills |
| **OpenHands** | Human | Root `AGENTS.md` (also CLAUDE.md/GEMINI.md) in the system prompt; `.agents/skills/*/SKILL.md` with `triggers` injected when a keyword appears | Repo, project, user, public registry | Project overrides user, user overrides public |
| **Windsurf Cascade** | Auto-generated memories plus human rules | Rules: `always_on`, `model_decision` (description first, body on demand), `glob`, `manual` | Memories per workspace, local in `~/.codeium/windsurf/memories/`, not committed | Global rules 6,000 chars; workspace rules 12,000 chars per file. Vendor recommends rules over memories for durable knowledge |
| **GitHub Copilot** | Custom instructions by humans (`.github/copilot-instructions.md`, `*.instructions.md` with `applyTo`, AGENTS.md). **Copilot Memory** written by the agent from activity of users with write access | Memory facts carry citations; **"Only validated facts are used"** after checking the current branch | Repo facts per repository; user preferences per user | Unused facts **deleted after 28 days**; successful use resets the timer; repo owners can review and delete |
| **Letta / MemGPT** | Agent self-edits core memory blocks with tools | Blocks always in context; archival memory searched | Per agent; shared blocks | Per-block character `limit` (examples 4,000–6,000); `read_only` blocks; shared blocks are last-write-wins |
| **Mem0** | LLM extracts facts (`infer=True`), stored additively | Semantic search, metadata filters | `user_id`, `agent_id`, `app_id`, `run_id` | Optional `expiration_date`; docs warn that mixing modes duplicates facts |
| **Zep / Graphiti** | Extracted from episodes into a temporal graph | Search returns facts with validity windows | Per user or graph | **Bi-temporal**: contradicted facts get `invalid_at` / `expired_at` rather than being deleted |

Sources: [Claude Code memory](https://code.claude.com/docs/en/memory) · [Claude Code skills](https://code.claude.com/docs/en/skills) · [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) · [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [AGENTS.md](https://agents.md/) · [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) · [Codex Memories](https://learn.chatgpt.com/docs/customization/memories) · [Cursor rules](https://cursor.com/docs/context/rules) · [Devin Knowledge](https://docs.devin.ai/product-guides/knowledge) · [OpenHands skills](https://docs.openhands.dev/overview/skills) · [Windsurf memories and rules](https://docs.devin.ai/desktop/cascade/memories) · [Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) · [Copilot repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions) · [Letta memory blocks](https://docs.letta.com/guides/agents/memory-blocks) · [Mem0 add](https://docs.mem0.ai/core-concepts/memory-operations/add) · [Graphiti temporal model](https://mintlify.com/getzep/graphiti/concepts/temporal-model), [Zep facts](https://help.getzep.com/facts)

What this means for Quill:

- **Instructions and learnings are separate things.** Every product keeps human-authored instructions (CLAUDE.md, AGENTS.md, rules) apart from agent-accumulated learnings, and vendors (Codex, Windsurf) say required guidance belongs in checked-in docs, not memory. Quill should read the repo's instruction files and never write learnings into them.
- **The index plus on-demand detail shape is universal.** Products differ only in how big the index is. Anthropic's context-engineering guidance names the trade-off: just-in-time loading keeps context focused but is slower. "Context rot" means recall drops as context grows, so a 1M window argues for a generous index, not for dumping everything.
- **Machine-local scoping is normal.** Claude Code auto memory, Windsurf memories and Codex memories all stay on the machine. Quill's A2 (memory never leaves the machine) matches.
- **Claude Code's auto memory already touches Quill runs.** Run worktrees are linked worktrees of the registered repo (`extension.js:269-281`, under `~/.claude/quill/handoffs/worktrees/<id>`). Auto memory is keyed per repository and shared across worktrees, so a run may load, and write to, the **owner's interactive `MEMORY.md` for that repo**, unless auto memory is off in `claude -p` or in sessions another Claude Code process started. The docs do not say which applies. This has to be decided on purpose (see Recommendation §5 and Open questions).

### 2. Curation problems

**Deduplication.** Mem0 warns that additive storage duplicates facts. ExpeL edits an insight list with ADD / UPVOTE / DOWNVOTE / EDIT rather than appending. Claude Code nudges the agent to merge entries when the index nears its limit. Approach: deduplicate deterministically in the worker (normalized text plus a subject key), and count repeated observations as confirmations instead of new entries.

**Staleness and contradiction.**
- Copilot re-validates citations against the current branch and expires facts unused for 28 days.
- Graphiti invalidates instead of deleting, so history survives and the newest fact wins.
- Claude Code stamps `modified` so readers can judge how current a fact is.
- Claude Code also warns that contradictory instructions get resolved "arbitrarily". Contradictions must be resolved at filing time, not left for the model.

**Memory poisoning and prompt injection.**
- MINJA ([arXiv 2503.03704](https://arxiv.org/abs/2503.03704)) plants malicious records only by interacting with the agent, reporting more than 95% injection success under idealized conditions. A later evaluation of attacks and defences ([arXiv 2601.05504](https://arxiv.org/html/2601.05504v1)) questions how well that holds in real deployments.
- AgentPoison reports more than 80% attack success with under 0.1% poisoned entries (secondary source).
- SpAIware (Rehberger, 2024) used indirect injection to plant persistent instructions in ChatGPT memory (secondary source: [Akto](https://www.akto.io/blog/memory-poisoning-ai-agents)).
- OWASP's Agentic AI Threats and Mitigations lists memory poisoning as T1. Secondary summaries recommend treating memory as untrusted input and monitoring across sessions ([Lakera](https://www.lakera.ai/blog/agentic-ai-threats-p1), [Promptfoo plugin](https://www.promptfoo.dev/docs/red-team/plugins/memory-poisoning/)).
- Codex's `disable_on_external_context` is a product-level form of the same idea: sessions that read MCP or web content do not feed memory.
- For Quill the risk is concrete. Runs will read Jira, Kibana logs, Argo and shared-page proposals (ADR 0025). A "learning" paraphrased from a Jira comment ("deploys must use `--force`") would become standing context for every later run on that repo.

**Provenance.** Copilot keeps citations, and Devin requires a person to approve suggested items. Quill already labels page-sourced timeline entries as untrusted (`runner.js:54-55`) and fences ticket data. Learnings need the same treatment, plus a record of where each one came from: run, recipe, access level, and source type.

**Size caps and eviction.** Hard caps sit everywhere in vendor products (25 KB, 32 KiB, 6,000/12,000 chars, block limits), but they mainly protect small context windows and per-turn cost. The owner has asked for caps that only prune stale entries. The memory-tool docs recommend expiring unaccessed files, and Copilot uses 28 days unused. For one developer on one machine, where repos are revisited every few weeks, a longer window (90 days) is safer.

**Verifying facts before reuse.** Copilot is the clearest model: re-check the citation, and use only facts that still validate. Facts about files and commands can be checked mechanically and cheaply before each run (does the file exist, is the blob unchanged, is the tool still on PATH).

### 3. Task memory for retries

- **Reflexion** ([arXiv 2303.11366](https://arxiv.org/abs/2303.11366)): verbal self-reflections kept in an episodic buffer and fed to later trials; 91% pass@1 on HumanEval against 80% for the base model.
- **ExpeL** ([arXiv 2308.10144](https://arxiv.org/abs/2308.10144)): collects successful and failed trajectories, extracts cross-task insights with explicit edit operations, and puts weight on recurring failure patterns. A known weakness is that all insights are concatenated into every prompt whatever their relevance, which scales badly. Quill should rank and scope rather than concatenate everything.
- **Agent Workflow Memory** ([arXiv 2409.07429](https://arxiv.org/abs/2409.07429)) and **LEGOMem** ([Microsoft Research](https://www.microsoft.com/en-us/research/publication/legomem-modular-procedural-memory-for-multi-agent-llm-systems-for-workflow-automation/)): reuse procedures from successful runs. This corresponds to Quill's "procedure" learnings (how to run the integration tests here).
- **Anthropic's multi-session pattern** ([memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool), [long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)): a progress log read at the start and updated at the end, with features marked done only after end-to-end verification.

How to stop repeating dead ends:
1. Keep an attempts ledger per ticket that lists each route with its outcome and reason.
2. Tell the agent: before trying a route, check the ledger. Do not retry a route that failed unless something has changed, and if you do, say what changed. Quill already uses this wording for dismissed suggestions (`METHOD`, `runner.js:40`).
3. Have the worker record the facts it observes itself, independent of the agent's own account: test-gate outcome, error code, timeout, and tool denials from the `claude -p` JSON result, if it includes them (unverified).

Today Quill keeps only the 3 latest runs at 400 characters each (`context.js:15-16,67-79`), which drops exactly this information.

### 4. Repo docs discovery

- **Instruction files.** In worktree runs Claude Code loads `CLAUDE.md` / `AGENTS.md` and path-scoped rules itself, though this needs verifying under `claude -p`. Duplicating them in Quill's prompt wastes context and risks the two copies disagreeing. Sandbox runs (no `read_source`) get none of this.
- **A cheap index beats inlining.** llms.txt ([llmstxt.org](https://llmstxt.org/)) is the model: an H1, a one-line summary, and H2 sections of links with short notes, plus an "Optional" section. Aider's repo map ([aider.chat](https://aider.chat/docs/repomap.html)) ranks code symbols within a 1k-token default budget that grows when needed. For docs, a list of path, title and first headings costs about 100 bytes per file and lets the agent open what it needs.
- **What to index.** `git ls-files` filtered to `README*`, `CONTRIBUTING*`, `AGENTS.md`, `CLAUDE.md`, `.claude/rules/**`, `.cursor/rules/**`, `.github/copilot-instructions.md`, `.github/instructions/**`, `docs/**/*.md`, ADR directories (`adr`, `decisions`), `runbook*`, `RUNBOOK*`, `ops/**/*.md`, `deploy/**`, `Makefile` targets, `package.json` scripts, and CI workflow names. Key the cache on the HEAD tree hash so it rebuilds only when docs change.
- **When to inline and when to point.** Inline what is short, high-value and needed on almost every run: build and test commands, the owner's pinned notes, the docs map. Point to everything long: ADRs, runbooks, full memory topic sections. Inline full text only when the run cannot read files, as in sandbox runs, and even then only the repo's instruction file, kept under its budget.

## Options with trade-offs

| Option | Description | For | Against |
| --- | --- | --- | --- |
| **A. Reuse Claude Code auto memory** | Let runs read and write `~/.claude/projects/<repo>/memory/` (shared across worktrees), or point `autoMemoryDirectory` at a Quill dir via `--settings` | Almost no code; the format the model already knows | Mixes run learnings into the owner's interactive memory without review; no provenance, trust or quarantine; the index loads only 200 lines / 25 KB; behaviour under `claude -p` and worker-spawned sessions is unverified; Quill cannot show it in the dashboard or keep it out of exports with its existing contracts |
| **B. Agent edits memory files directly** | Give runs write access to `memory/*.md` (like the memory tool) | Rich, self-organizing | Any injected text goes straight into trusted memory; parallel runs conflict (last write wins, as with Letta shared blocks); no worker-side dedupe or verification; conflicts with confined cwd and access levels |
| **C. Agent proposes, worker files, owner reviews (recommended)** | Result contract `learnings[]` / `attempts[]`; worker validates, dedupes, verifies and assigns trust; journal events are the source; Markdown projection is read-only to runs | Fits Quill's event-sourced store, suggestions model, revision checks and export privacy; poisoning is contained by trust levels; consistent under parallel runs | More code (events, reducer, projection, dashboard page); learnings appear only after the run finishes, not during it |
| **D. Human-approved only (Devin style)** | Every learning is a suggestion the owner must accept | Highest trust | Owner fatigue; growth stalls, which defeats R4 ("improve over runs") |
| **E. Vector store (Mem0/Zep style)** | Embed entries and retrieve by similarity | Scales to large corpora | New dependency and runtime; opaque to the owner; overkill for one developer's few hundred facts per repo; similarity retrieval is the surface AgentPoison exploits |

Option C, with D's approval step used only for **quarantined** entries, is the recommended mix. Trusted sources (the worker's own observations, the repo's own files, the agent's own verified commands) are filed automatically. Anything derived from external text waits for the owner.

## Recommendation for Quill

### 1. Store layout (local only, under `quillHome()` = `~/.claude/quill`)

The source of truth is journal events, so that memory follows the same revision and replay contracts as everything else:

- `memory-learning-filed`
- `memory-learning-confirmed`
- `memory-learning-superseded`
- `memory-learning-retired`
- `memory-learning-approved`
- `memory-owner-note`

The worker regenerates readable projections from these events:

```text
~/.claude/quill/memory/
  _machine.md                 # machine know-how
  repos/<repo_id>.md          # repo memory, by section
  repos/<repo_id>.owner.md    # owner-authored notes, hand-editable, always inlined first
  repos/<repo_id>.docs.md     # generated docs map (path — title — headings), cached on HEAD tree hash
  _quarantine.md              # entries awaiting owner approval; never given to runs
```

**`_machine.md` sections:**
- **Tools**: CLI name, version, resolved path, last probed. The worker probes these with a fixed list: git, node, npm, kubectl, aws, gcloud, az, argocd, psql, mysql, docker, gh, jira and others.
- **Connectors and MCP**: server and tool names seen in runs, whether each worked, failed or was unavailable, and the last run that used it.
- **How**: auth steps, kube context names, AWS profile names (names only, never secrets).
- **Where**: log locations, dashboard URLs, local clones.
- **Pitfalls**.

**`repos/<repo_id>.md` sections:**
- **Build & test**
- **Conventions**
- **Docs & runbooks** (pointers, not copies)
- **Environments & deploy** (Argo app names, namespaces, Kibana index patterns)
- **Procedures**: step lists that worked
- **Pitfalls**
- **Stale**: listed but not inlined

**Task memory** lives on the ticket record as **Run notes**. It holds a consolidated attempts ledger plus task-scope learnings, shown in the ticket's Runs tab and in `gatherContext`. It replaces the 3 × 400-character history as the main carrier of prior-run knowledge. `runHistory` stays for suggestion outcomes.

Entry record:

- **Identity:** `id`, `scope` (machine | repo | task), `repo_id` / `ticket_id`, `section`, `key`. The key is an optional subject key such as `test-command` or `argo-app`, used for contradiction detection.
- **Content:** `kind` (fact | procedure | pitfall | tool | pointer), `text` (one fact, at most 600 characters; procedures may run to about 1,500).
- **Provenance:** `evidence[]` (file:line@blob, command and exit code, URL, run id), `derived_from` (worker-observed | repo-file | own-command | tool-output | external-text | owner), `run_id`, `recipe`, `access`.
- **Trust and use:** `trust` (owner | verified | observed | quarantined), `created_at`, `last_confirmed_at`, `confirmations`, `last_used_run`.
- **Lifecycle:** `superseded_by`, `state` (active | stale | retired).

### 2. Result contract additions (`OUTPUT_FIELDS` in `runner.js`)

```json
"learnings": [{"scope": "repo|task|machine", "section": "build-test|conventions|docs|environments|procedures|pitfalls|tools|how|where", "key": "optional subject key or null", "kind": "fact|procedure|pitfall|tool|pointer", "text": "one durable fact a future run would need", "evidence": ["file:line, command + exit code, URL"], "derived_from": "repo-file|own-command|tool-output|external-text"}],
"attempts": [{"route": "what you tried, e.g. read Argo app status via argocd CLI", "tool": "tool or MCP name", "outcome": "worked|failed|unavailable|skipped", "reason": "why, quoting the error briefly", "evidence": "command, log line or source"}]
```

`attempts[]` also satisfies R3 (try or report). Record both fields in the result blob alongside `confidence` and `sources` (`results.js:29`). Add them to the self-check prompt: "remove learnings that are not durable or not supported by evidence."

### 3. Filing rules (worker, after the run, before the result is shown)

1. **Validate shape**, cap at 15 learnings per run (more are dropped, and the drop is recorded), cap entry length, and redact secret-looking strings with the same redaction used for logs and tails.
2. **Assign trust by provenance, not by the agent's say-so:**
   - `worker-observed` facts (test-gate command and outcome, tool denials, a tool probe) → **verified**.
   - `repo-file` with a file:line that exists at the cited blob → **verified**.
   - `own-command` with a command that appears in the run log with the claimed exit code → **verified**. If it cannot be checked, the entry is **observed**.
   - `tool-output` / `external-text` (Jira, Kibana, logs, web, shared pages), or any learning from a run that had a page proposal → **quarantined**. Quarantined entries are never injected until the owner approves them.
3. **Quarantine instruction-like text.** Learnings must describe; they must not direct. Text that addresses the agent, asks to widen permissions, disable checks, push, force, or contact unknown hosts goes to quarantine whatever its source. This is a heuristic, not a boundary; the trust level is the boundary.
4. **Dedupe.** Normalize (case, whitespace, paths), hash, and compare word overlap within the same scope and section. A match increments `confirmations` and refreshes `last_confirmed_at` instead of adding an entry.
5. **Contradiction.** Same `scope` + `key`, different value:
   - If the new entry is verified, it supersedes the old one, which gets `superseded_by` (Graphiti-style invalidation; nothing is deleted). The change is flagged on the Memory page.
   - If the new entry is unverified, both are kept and marked "conflict". Only the verified or older-confirmed one is inlined, with a note that a conflict exists.
6. **Attribution.** Every entry links to its run, and the run detail lists "Learnings filed (n)" with their trust levels.
7. **Task scope.** Attempts are appended to the ticket's Run notes. Task learnings with `kind: pitfall` become one-line lessons there (Reflexion-style).

### 4. Prompt injection of memory (fits `gatherContext` and `buildPrompt`)

- **Wiring.**
  - `context.js` gains `gatherMemory(state, ticket, { repoCfg, budget })`, returning `{ inline, paths, conflicts }`.
  - `CONTEXT_LIMITS` gains `memory_inline` (default **48,000** bytes, configurable as `[memory] inline_budget_bytes`, sensible range 32–64 KB) and drops the 3-run history limit for attempts.
  - `ALL_INPUTS` gains `memory`; non-legacy recipes declare it.
  - `contextSections` emits a **Memory** section inside the fenced data block, built with `dataBlock` so markers are neutralized. Memory is data, not instructions, exactly like ticket notes.
- **Fill order within the budget.** Fill top to bottom. Nothing is hidden; whatever does not fit stays in the files.
  1. This ticket's Run notes: the full attempts ledger and lessons. These go first, because repeating dead ends is the biggest waste.
  2. `repos/<repo>.owner.md` and entries the owner has pinned.
  3. Repo Build & test, Environments and Pitfalls, ranked by trust weight × recency × confirmations.
  4. Machine tool inventory (compact table) and connector outcomes.
  5. Repo docs map (`repos/<repo>.docs.md`): path — title.
  6. Section headings with entry counts for everything not inlined ("Procedures: 14 entries, see file").
- **Verification at injection time.** For verified repo-file entries, the worker re-checks the cited blob in the run's checkout. Entries whose source changed are marked "(source changed since recorded; re-check)" rather than dropped, as Copilot does.
- **Full files as paths.** The worker copies the projections (minus quarantine) into a per-run snapshot `handoffs/context/<run id>/` and passes it with `--add-dir`. The permission line in `permissionLines` names it as readable. Because the snapshot is a copy, an edit by the agent is harmless and is never read back; learnings travel only through the result contract. The snapshot is removed with the worktree. This keeps the existing "confined to the checkout" rule, with one explicit read-only extra path.
- **METHOD changes.**
  - Step 1 gains "consult the Memory section and docs map; open the full memory files or repo docs when a topic is relevant".
  - Add: "Before trying a route, check the attempts ledger. Do not retry a route that failed unless something changed, and say what changed."
  - Add: "Record every route you tried in `attempts`, and durable, evidenced facts a future run would need in `learnings`. Do not record what the repo's own docs already say."

### 5. Claude Code's own memory during runs

- **Disable auto memory writes in runs.** Set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the spawn environment. Otherwise a run can silently write unreviewed learnings into the owner's interactive memory for that repo, and Quill's memory would compete with it.
- **Optional read access to the owner's memory.** Expose a setting `[memory] include_claude_auto_memory = false` that copies the owner's `MEMORY.md` index for the repo into the snapshot as `observed`-trust data.
- **Repo instruction files.** Keep loading CLAUDE.md / AGENTS.md normally in worktree runs. For sandbox runs, inline the repo's AGENTS.md or CLAUDE.md under a 16 KB slice of the budget, because no files are readable there.

### 6. Owner review and pruning

- **Dashboard Memory page.** Owner-only, behind the existing capability checks. Tabs: Repo / Machine / Quarantine. Each row shows the text, trust chip (never colour alone), source run link, last confirmed time and confirmations. Actions: Approve (quarantined → owner), Edit (creates an owner entry superseding the old one), Pin (always inlined), Retire. Edits use `expected_revision` like ticket edits.
- **Attention.** Quarantined learnings and conflicts count toward "Needs you" as their own item type.
- **CLI.** `quill memory list|show|approve|retire|pin|note`.
- **Staleness.** An entry neither confirmed nor used for **90 days** moves to Stale: not inlined, still in the file. It is retired after **180 days**, or when the owner retires it, or when a verified contradiction supersedes it. These are pruning rules only; there is no cap on visible active entries.
- **Consolidation.** When a section exceeds a soft threshold (say 60 active entries), the dashboard suggests running an optional built-in `memory-consolidate` recipe. Its merges arrive as suggestions the owner accepts.

### 7. Privacy (DATA-CONTRACT, A2, A3)

- **Never leaves the machine.** Memory events, projections, Run notes learnings and the per-run snapshots are local-only. Static exports, mirrors, publishers and tracker write-back never include them; the data contract should state "Exports never include it" for each. Add a `tests/export/static.test.js` assertion.
- **Owner snapshot only.** The owner snapshot may carry counts (memory entries, quarantined) for the attention badge.
- **Secrets.** Redact before filing. Machine know-how stores names (profiles, contexts), never credentials.
- **Repo data.** Memory files never enter the repo or a worktree's tracked files, and never appear in PRs or commit messages.

### 8. Tests to add

- Filing:
  - trust assignment by `derived_from`
  - external text and instruction-like text quarantined
  - dedupe increments confirmations
  - a verified contradiction supersedes, an unverified one marks a conflict
  - per-run cap and redaction
- Injection:
  - budget fill order
  - quarantined entries never injected
  - stale entries not inlined but present in files
  - source-changed marker
- Export:
  - no memory fields in static export or mirror
- Success criterion 2 from the brief: a second run on the same repo receives the first run's verified learning inline.

## Open questions

1. **Does Claude Code auto memory load and write in `claude -p` runs spawned by the Quill worker?** The docs say it cannot be switched back on in background sessions or in sessions another Claude Code session started. Verify empirically before relying on `CLAUDE_CODE_DISABLE_AUTO_MEMORY` or on the opt-in import.
2. **Do CLAUDE.md, AGENTS.md and `.claude/rules` load in `-p` mode inside a Quill worktree?** Check whether `--setting-sources` or the `project` source is affected. This decides whether sandbox-style inlining is needed for worktree runs too.
3. **Does the `claude -p --output-format json` result include tool permission denials?** The worker could then file "tool X refused" machine facts without trusting the agent.
4. **Should owner-approved learnings ever be promoted into the repo** (for example, as a proposed AGENTS.md edit opened as a PR suggestion)? That would cross from private memory to shared repo content and needs its own consent step.
5. **Defaults to confirm with the owner:** the 90/180-day staleness windows, 15 learnings per run, the 48 KB default inline budget, and whether `observed` (unverified own-claim) entries should be inlined or held until confirmed by a second run.
6. **Are machine know-how probes acceptable?** Version and path checks of kubectl, aws and similar tools are read-only, but they touch prod-adjacent tools. They may need to run only when the owner enables them.
7. **Quarantine release.** When a quarantined Jira-derived learning is later confirmed by the agent's own command (for example, the Argo app name verified with `argocd app get`), should it auto-promote to verified, or always need the owner?
