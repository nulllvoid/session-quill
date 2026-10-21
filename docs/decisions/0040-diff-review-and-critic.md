# ADR 0040 — Diff review and the critic

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0008](0008-agent-recipes.md), [ADR 0013](0013-recipe-context-and-reply-contract.md), [ADR 0020](0020-shared-recipes.md), [ADR 0023](0023-bulk-runs-and-test-gate.md) and [ADR 0027](0027-run-memory.md) · PRD FR-4.2 and FR-4.3 as adopted in `docs/research/2.0.0/01-gap-analysis.md` · Plan task 12

## Context

A fix run leaves its patch at `handoffs/results/<id>.patch` and records only `patch_path`. Run detail's **Changes** shows file names, the commit, the agent's test lines and file effects. To see what a run changed, the owner opens the file or the checkout. The dashboard cannot fetch the file: it reads content only by hash through the owner-only `/v1/content/<hash>`.

A fix's checks are the worker's test gate (ADR 0023) and the agent's self-check. The self-check is a follow-up turn in the agent's own session (ADR 0013), so it reviews with the author's own reasoning. The PRD asks for an adversarial critic and an intent-grouped diff. The gap analysis adopts both narrowly: an opt-in critic that is a fresh read-only process after the tests pass, and a diff grouped by a fixed path table, labelled as such.

## Decision

- **The patch is a blob.** `fixExtras` keeps writing the patch file. A patch of at most 1 MB (UTF-8 bytes) is also stored with `putBlob`, and the run records its hash as `patch_ref`. A larger patch records `patch_too_large: true` and keeps only the file. An empty patch records neither. A failed, cancelled or timed-out fix collects its diff the same way, so its patch is there to inspect too.
- **The grouped diff.** `ui/lib/diff.js` is pure. `parseDiff` reads `git diff --binary` output into files and hunks. It follows each hunk's line counts, so a deleted line that starts with `--- ` stays a line. Binary files are listed without their content: no base85 data is kept. `diffGroup` assigns each path to the first match of a fixed table, compared by whole path segment or a part of one between `.`, `_` and `-`:
  1. a test directory (`test`, `tests`, `__tests__`, `spec`, `specs`) or a `*.test.*`, `*.spec.*` or `test_*` file: **Tests**
  2. `reduce`, `reducer(s)`, `state(s)`, `migrat*`, `schema(s)`, `event(s)`: **Schema and state**
  3. `cli`, `server(s)`, `ui`, `route(s)`: **CLI, routes and UI**
  4. anything else: **Core logic**

  So `src/statement.js` and `src/build/guide.js` are Core logic, not a substring match.
- **Run detail Changes.** On the owner's dashboard the run detail fetches `patch_ref` the way it fetches the result blob: once per hash, with loading, error and Retry, and "no longer stored" states. It then shows the grouped diff under the heading "Grouped by file path", with the line "Grouped by where each file sits in the repository, not by what the change does".
  - Each file is a `<details>` with its +/− counts and its status in words (Added, Deleted, Renamed). Each hunk shows its header and section.
  - Lines wrap inside the panel, so there is no horizontal scroll at 390 px. The `+`/`-` marker, not the colour, says what a line is.
  - A diff of at most 10 files opens files of at most 120 lines. The owner's open and closed choices are kept across polls, keyed by `<patch_ref>:<path>`.
  - At most 400 lines per file and 4,000 in all are rendered. The rest are counted: "N more lines not shown here".
  - With `patch_too_large`, the section says the diff is over 1 MB and gives the patch file path as owner-only text with copy.
- **Per-hunk retry.** Each hunk has **Retry as new run**. It opens the ordinary Run dialog for the same recipe with `retry_of` set, and pre-fills a note of at most 280 characters. The note names the file and the hunk's line range: "Rework the change to `<path>` at `@@ -a,b +c,d @@` from the earlier run; keep the rest of the change as it was." Control and bidi characters are removed, and a long path loses its middle first. The section text git prints after the range is source the run wrote, so it is never carried into the note. The owner sees and can edit the note before queuing. The retry is offered on the owner's dashboard when the ticket is open, the run has finished and no later run superseded it. Per-hunk revert is deferred.
- **The critic is opt-in per repository.** `[repos.<id>] critic = true` turns it on (only `true` does). `review_docs` lists up to 5 repository-relative files, default `["CLAUDE.md"]`. An entry is dropped when it is absolute, home- or drive-relative, holds a colon or a `..` or empty segment, starts with `-`, or exceeds 200 characters.
- **When it runs.** In `finishRun`, after the reply repair, the self-check and the test gate, and before `fixExtras` finalises (commit, push, draft PR). It runs only when the gate passed. With the critic on, every other gate outcome is recorded as `not-run` with the reason: failed, timed out, skipped for no test command, or skipped for no diff.
- **A fresh, read-only process.** The critic is a new `claude -p` session: never `--resume` of the run's session, so it does not inherit the author's reasoning.
  - Its profile is the self-check's read-only one under standard access, with `dontAsk`: Read, Glob, Grep and the read-only git commands. Edits, subagents and web tools are denied, whatever access the run had.
  - It uses the run's own environment when the run has one (an autonomous run's redirected credentials). Otherwise it gets the standard environment with provider credentials removed. It never gets more than the run had.
  - It runs in the run's checkout. It writes to the run's log and to no ledger, so its reads cannot make an agent's claimed tool look seen. Its init event does not touch the run's session id or inventory.
  - It is tracked as the run's current child, so a cancel or a worker stop stops it too.
- **Its prompt.** The built-in `recipes/critic-review.md` supplies the task. The rest is worker-authored:
  - The ticket title, the owner's note and the gate's command, as one-line data.
  - The patch, at most 200 KB, inside a `diff` fence framed as data, with the rest readable through `git diff`.
  - The review documents, read with `git cat-file blob <base_commit>:<path>` (each at most 16 KB, 48 KB in all). They are read at the base commit, so the change under review cannot rewrite its own review rules.
  - Triple backticks inside data become `'''`, and five or more dashes become four, so no data can close its fence or imitate a section marker (the way `testRepairPrompt` frames test output). Only the built-in recipe is used. A repository or personal `critic-review` is ignored, because the critic runs unattended on every fix and no owner reviews a recipe hash for it.
- **Its caps.** Its spend is capped by what is left of the run's `--max-budget-usd` (and the recipe's own cap, if any), and its usage is added to the run's turns and cost. Its turns are capped by the recipe's `max_turns` (20). Its time is capped by the recipe's `timeout_min` (10) and by the run's deadline less 60 s, so the run's deadline never fires during it. With less than 60 s of that window it is not started. A budget already spent is `not-run`.
- **Its reply.** The fenced JSON block of its final result event: `summary` and `review_findings`.
  - Each finding has `file`, `line` (a positive integer or null), `hunk`, `severity` (high, medium or low; default low), `category` (bug, test, security, docs, style or other; default other), `text` and `suggestion`.
  - A finding without text is dropped. The rest are capped at 30, with per-field lengths, and stripped of invisible and control characters. A finding whose text or suggestion matches the memory instruction filter (`instructionLike`) is kept and marked `instruction_like: <pattern>`.
- **What is recorded.** `critic_status` is `clean` (no findings), `warnings` (one or more), `not-run` or `failed`, with `critic_count` and, for `not-run` and `failed`, a worker-written `critic_reason`. `clean` and `warnings` store the findings as a blob, `critic_ref`. The critic's time is `timings.critic_ms`, and `agent_ms` no longer includes it.
- **It never blocks.** A critic that cannot start, crashes, times out, replies without JSON or reports an error is `failed`. Whatever the critic does, the run ends in the state, with the suggestions, commit, push and PR, it would have had without it. A cancel or stop during the critic ends the run as cancelled or interrupted, as during any other turn.
- **Never offered as a run.** `critic-review` declares `requires: [run_diff]`, a new requirement (with `quill_min_version: 2.0.0`, ADR 0020). A recipe with any requirement is never scheduled and never offered on a page. One that requires `action_pin` or `run_diff` is never listed in the Run dialog. `validateHandoffRequest` refuses `run_diff` with `recipe-needs-run-diff`, so no CLI, dashboard or page request can queue it. `review_findings` is a recipe output only the critic step produces.
- **Review notes.** Run detail shows "Review notes (n)" after Changes, under the line "The critic agent's opinion, not Quill's check. Only "Tests passed (worker)" is Quill's own check." It never uses the word verification.
  - On the owner's dashboard it fetches `critic_ref` with the same loading, error and Retry states as the diff.
  - Each finding shows severity in words ("High severity" is a warning chip; the colour only repeats it), its category, `file:line` and hunk as code, the text and the suggestion. An `instruction_like` finding carries "Reads like an instruction", whose title says it is never given to a run.
  - `not-run` and `failed` say why. `clean` says "The critic noted nothing to review."
  - Every word is agent text and escaped.

## Privacy

`patch_ref`, `patch_too_large`, `critic_ref`, `critic_status`, `critic_count` and `critic_reason` are local fields. They are in the owner's snapshot and on no export, mirror, publisher, tracker or vault-note allow-list (`tests/export/privacy-sentinel.test.js`). An export has no Changes diff and no Review notes section. A count alone would have produced a "Review notes (n)" section with nothing to show, and design system §5 omits sections an export strips. `timings.critic_ms` travels with `timings`, like `test_ms`: it is a duration, not text.

Critic findings never cross into another run. They are not in run history, Run notes, memory filing or the context card, and the per-hunk note carries only a path and a line range. If a later task does pass a finding to a run, the `instruction_like` mark and the filing rules of ADR 0027 apply.

## Consequences

- A fix in a repository with `critic = true` costs one more process after its tests pass: at most 10 minutes and the run's remaining budget. Timings show it as "Critic".
- The diff is readable on the dashboard without opening the checkout. A large patch costs one more blob in the store, at most 1 MB per run.
- Review notes can be wrong, noisy or empty. They are labelled as opinion and change nothing on their own.

## Residual risks

- A critic can be steered by text in the diff or the review docs. The framing and the read-only, credential-stripped profile limit what it can do, not what it says. The instruction filter is defence in depth, not a boundary (ADR 0027).
- The critic reads the checkout with `Read`, which Claude Code does not confine to the checkout by a path rule. This is the same read access as the self-check and standard runs.
- The path table groups by location, not intent. A change to `ui/state.js` lands in Schema and state, which the heading admits.

## Alternatives considered

- **A follow-up turn in the run's session.** Rejected: the critic would share the author's context and bias, which the self-check already covers.
- **Blocking the run on high-severity findings.** Rejected: the critic is an agent's opinion. Quill's check stays the test gate (design system §6).
- **Running the critic for any fix with a diff.** Rejected for now: a fix whose tests failed has no suggestion to review, and one without a test command is "Not test-verified" either way. The gap analysis places the critic after a pass.
- **Grouping by intent with an LLM.** Deferred, as is per-hunk revert.
