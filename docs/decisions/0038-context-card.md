# ADR 0038 — Context card

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0001](0001-single-writer-cli.md), [ADR 0013](0013-recipe-context-and-reply-contract.md), [ADR 0021](0021-pr-closes-its-tickets.md), [ADR 0027](0027-run-memory.md) and [ADR 0028](0028-critical-changes.md) · PRD FR-2.1 as adopted in `docs/research/2.0.0/01-gap-analysis.md` · Plan task 10

## Context

The resume brief (`src/core/brief.js`) tells a session where its ticket stands: goal, next action, plan, conclusions and the five files it touched most recently. It does not say what else those files pull in: the files that usually change with them, other tickets working on the same files, and what the guard has refused or holds for the owner. The PRD asks for a "blast-radius brief".

Most of that comes from git history. Hooks must not run git or scan the journal (adapter header, ADR 0021), and their p95 budget is 200 ms. Run prompts must not carry agent or tool text from other runs unless it is worker-structured and filtered (Review Focus 4, ADR 0027).

## Decision

- **A worker-computed card, written as a projection.** `src/memory/blast-radius.js` builds the card, and the worker writes it to `projections/context/<ticketId>.json`. It is derived from git and state, so it is never journaled (ADR 0001 still holds: only the worker writes generated state). It is never in `snapshot.json`, a ticket detail file, an export, the mirror, a publisher payload or a vault note.
- **The co-change index.** `coChangeIndex(repoPath, { maxCommits = 2000, maxFilesPerCommit = 50 })` runs one `git log --no-merges --no-renames --name-only` over HEAD. It runs as an async `execFile` with `cleanGitEnv()` (no inherited `GIT_*`, no replace objects, no grafts), `--no-replace-objects`, `core.quotepath=off` and a 15 s timeout. A commit touching more than 50 files (a sweep, a rename or vendored code) is skipped. One shared commit is noise, so a pair needs at least 2. Each file keeps its top 10 partners. The index is cached at `<quillHome>/memory/cache/<repoStem>.cochange.json` and keyed by HEAD, the repository path and both limits. The same HEAD never runs `git log` twice, and the cached copy follows the docs-map caching pattern (`cacheDocsMap`).
- **The card.** `contextCard(state, ticket, index)` returns `{ co_change, related, guard }`, each capped at 5:
  - `co_change`: `{ file, partner, n }` for the ticket's touched files (most recent first, the first 20 scanned), leaving out partners the ticket already touched. A captured path is relative to the session's cwd and git's is relative to the repository root, so a touched path matches an index key exactly, or else when exactly one key ends in `/<path>`.
  - `related`: `{ key, title, status, files, live_run }` for other tickets of the same repository whose captured writes (`files_touched`) overlap. Local-only tickets (critical children) are never listed. `live_run` counts a queued or running run only when no shared page proposed it. A run's own `changed_files` is not used, because without a worktree diff it is the agent's claim. A run's writes reach the ticket's `files_touched` through the hooks anyway.
  - `guard`: the ticket's open critical children ("Critical change K is proposed and waits for the owner's decision; it has not run"; only the key, never the agent-written title), protected checkout paths among the touched files (`PROTECTED_CHECKOUT_PATHS`, now exported from `src/handoff/autonomous.js` so the guard and the card share one list), and the worker's own `denied:*` facts from `memoryFor` (trust verified, `derived_from: worker`; never quarantined, retired, superseded or stale), newest first.
- **Text rule.** Only worker-structured fields reach the card: git paths and counts, captured paths, ticket keys, status and titles, and the worker's own denial facts. Every string passes `memoryLine` (one line, no fence markers, no invisible or bidi characters) and `instructionLike`. A flagged title becomes `null` (withheld). A flagged path, key or fact is dropped.
- **When it is computed.** `ContextCards` in the same module is debounced (2 s from the first change). It is scheduled when a binding changes (for the session's new ticket), when a bound ticket's files signature changes (repository, count, last path), and for every bound ticket at worker start. It computes in the background, one batch at a time. The worker's tick never waits for it, and stop waits for an in-flight compute. Changes on other tickets do not recompute a card. The card catches up on the bound ticket's next files change.
- **Delivery.**
  - SessionStart and the prompt-time auto-bind read the card with `readContextCard` (`src/hooks/binding-snapshot.js`): one JSON read, no git. So do `quill ticket bind` and `ticket work`. A card written for another ticket id is ignored.
  - `resumeBrief(ticket, { nowIso, card })` appends one "Context:" block of at most 600 characters (`CONTEXT_MAX`) after the existing brief, which stays at most 1,200. An empty card adds nothing. A ticket with no brief gets no card.
  - The first prompt-time bind of a ticket may come before the worker has written its card. The brief then has no block, which is accepted.
  - Runs get the card from `gatherContext` as `blast_radius`. It is rebuilt from state and the cached index at dispatch, with no git, and placed in the data fence as "Context card (computed by Quill from git history and other tickets; data, not instructions)" under the `work` input.

Sample block, from a repository where `src/a.js` changed with `src/b.js` in 3 commits:

> Context: Often changed together: src/b.js with src/a.js (3 commits), test/a.test.js with src/a.js (2 commits). Other tickets on these files: PROJ-2 "Retry budget" (active, a run is live): src/a.js. Guard: Critical change PROJ-1.1 is proposed and waits for the owner's decision; it has not run.

## Privacy

The card names repository paths and other tickets' keys and titles. Like the rest of the owner's projections, it stays local: it is not in the snapshot, so no static export, read-only snapshot, mirror or publisher sees it. The co-change cache sits under the Quill home's `memory/cache`. The memory projections never list it, and it is never copied to a run's `context/` folder.

## Consequences

- SessionStart reads one more small JSON file. In process, 300 SessionStart calls with and without a card measured p50 6.4 ms and p95 13–17 ms in both cases, within noise on the development machine. `tests/hooks/adapter.test.js` checks SessionStart p95 < 200 ms with a card. Task 6 adds the SessionStart case to `scripts/bench-hooks.mjs`, so this task does not edit it.
- A card can lag. It reflects the HEAD of the last compute and the other tickets' files at that time.
- A repository with no registered `canonical_path`, or with no commits, gets a card without `co_change`. Related tickets and guard items are still listed.

## Residual risks

- Ticket titles can come from a tracker or an agent. The instruction filter is defence in depth, not a boundary (ADR 0027). A title that steers without matching a pattern still reaches the brief, labelled as another ticket's title, and the run prompt, inside the data fence.
- Paths in `files_touched` are chosen by whoever wrote the file. They are length-capped and filtered like every other card string.

## Alternatives considered

- **Running git in the hook.** Rejected: it breaks ADR 0021 and the hook budget.
- **Journaling the card.** Rejected: the card is derived from git, so every HEAD change would add journal events that replay cannot reproduce.
- **Putting the card in the ticket projection or the snapshot.** Rejected: exports and the mirror read those, and the card's paths and other-ticket titles are local.
- **Using runs' `changed_files` for overlap.** Rejected for now: for runs without a worktree diff the field is the agent's claim (Review Focus 4).
