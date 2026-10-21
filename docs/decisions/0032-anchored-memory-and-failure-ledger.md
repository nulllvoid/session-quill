# ADR 0032 — Anchored memory and the failure ledger

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0001](0001-single-writer-cli.md), [ADR 0023](0023-bulk-runs-and-test-gate.md) and [ADR 0027](0027-run-memory.md) · PRD FR-2.2, FR-2.3 as adopted in `docs/research/2.0.0/01-gap-analysis.md` · Plan: `docs/superpowers/plans/2026-10-21-quill-2.0.0.md` Task 4

## Context

A sourced learning (ADR 0027) cites `path:line` and is pinned to the cited file's git blob (`@blob:<sha>` in its evidence). At dispatch the run's checkout was re-read and an entry whose cited line changed got "(source changed since recorded; re-check)". Nothing else happened: an entry about a function that was rewritten weeks ago kept reaching every run with a re-check suffix, and the Memory page never said the source had moved on. The PRD asks for memory anchored to a file, blob and symbol that goes stale when the anchored source changes beyond a threshold.

Runs also repeated failed attempts. A failed run's Run note recorded the agent's attempts, but not what the worker's test gate saw, so a later run that hit the same failure had no way to know. The PRD asks for a failure ledger (hypothesis, files touched, error signature) given to later runs and retries. ADR 0027's tool-output rule forbids handing test output from one run to another: it is tool output, and test names and assertion messages can carry text the agent wrote.

## Decision

### Anchors

- Filing (`src/memory/file.js` `sourcedEvidence`) records, for each cite of a sourced learning, an anchor `{ file_path, blob_sha, line, symbol_name }`: the checkout-relative path, the file's blob at the run's base commit (as before), the cited line, and the nearest declaration within ±5 lines (`src/memory/anchors.js` `symbolAt`, the line itself first, then above before below at each distance). Declarations are matched by a plain-text heuristic across common languages (function, class, def, fn, func, type, top-level const/let/var, method headers); a parser-based (tree-sitter) symbol is deferred. At most 10 anchors per entry. Evidence keeps its `@blob:` pins.
- The reducer copies `anchors` field by field when present, so entries filed before this ADR reduce exactly as before. A `confirmed` op may carry new anchors; a sourced entry takes them (a run that re-verified the learning re-anchors it at the version it checked).
- **Changed ratio** (`changedRatio`): the meaningful lines (any letter or digit; blank lines and bare punctuation are not counted) within 10 lines of the anchored line in the old blob, whitespace-trimmed, are matched as a longest common subsequence against the whole current file. The ratio is the share no longer matched. Code added or moved elsewhere in the file does not count; a rewritten region does. An anchor whose symbol is no longer declared anywhere in the file, a file that is gone, and an unreadable old blob count as 1.
- **Verdicts** (`src/memory/deliver.js` `anchorVerdicts`, generalising `changedSources`): per sourced entry, the largest ratio over its anchors decides: 0 → same; at least `[memory] anchor_stale_ratio` (default 0.3, a number above 0 and at most 1) → stale; anything else → re-check. Pinned and owner entries (R27) and machine-scope entries (whose checkout is not known) never get stale, only re-check. Entries without anchors keep the Task 13 line comparison. When git cannot be read every entry is re-check, never stale.
- **At dispatch** the verdicts are taken at the run's base commit. A stale entry is not inlined; the closing "Left out" line counts it, together with the entries the worker already staled, under "Source changed since recorded, not delivered". Re-check entries keep their suffix.
- **The worker's check** runs from the handoff extension's `tick`, at most every 5 minutes (`ANCHOR_CHECK_MS`), per registered repository with a `canonical_path`, only when its HEAD or its number of anchored entries changed since the last check. Candidates are live, sourced, unpinned entries with anchors at repo scope or task scope on a ticket of that repository. For each stale verdict at HEAD the worker journals `memory-tx` `{ op: 'staled', entry: { id }, reason: 'anchor-changed', anchor: { file_path, blob_sha, current_blob_sha, changed_ratio } }` with source identity `memory-tx:anchor:<id>:<current_blob_sha>` (`missing` when the file is gone). The reducer only records the verdict (pure, ADR 0001). The same file version never stales an entry twice, so an entry a run confirmed again stays active until the file changes again. A stop waits for a check in flight, bounded.
- **Reducer** (`staled`): sets `state: 'stale'`, `stale_reason: 'anchor-changed'` and `stale_anchor`. Refused for pinned and owner entries (`memory-stale-exempt`, R27), for retired or superseded ones (`memory-entry-retired`) and for a malformed verdict (`memory-stale-invalid`). `confirmed`, `edited`, an owner note on the id, `pinned` and `approved` revive the entry and clear the reason.
- **Owner view**: the Memory page's chip reads "Source changed · not delivered to runs" for such an entry (its `title` says what brings it back); an entry stale by age keeps "Stale · not delivered to runs". `memoryListing` carries `stale_reason`. The projection lists it under `## Stale` with "source changed since recorded".

### The failure ledger

- When the worker's test gate fails or times out, `fileMemory` passes `failureRecord(run)` (`src/memory/failure.js`) to the Run note: `failure: { kind: 'test-gate', status, command, exit_code, signature, files_touched }`. `command` is the repository's configured test command, `files_touched` the run's changed files (at most 20), both redacted and capped; a file name the instruction filter flags (R29) is replaced by "[withheld: instruction-like file name]". A note is written for a failed gate even when the agent reported no attempts. The reducer copies only these fields.
- **Signature** (`failureSignature`): sha256 of the first five lines of the gate's output tail that carry a failure marker (fail, error, assert, expected, exception, panic, traceback, not ok, ✖ …), after stripping ANSI codes, absolute paths (POSIX, drive-letter, UNC, file URLs), durations, hex runs and digits; the first 16 hex characters. With no marker line the last five lines are used. Timestamps, temp directories, run ids and timings do not change it.
- **Never crosses runs**: the output tail, test names and assertion messages. They stay on the run's own `test_gate` as before. Only the record's fields reach another run.
- **Repeat detection**: before the test-repair turn, `repeatNotice` looks for an earlier deliverable Run note of the ticket (never a page-proposed run's, none for a page-proposed run) with the same signature. When found, one line is added to the repair prompt, after the test output, in its own text fence labelled as data recorded by the worker: "The same failure (signature <sig>) was seen in run <id8>, which tried: <attempt summaries>". Attempt summaries are the earlier note's route, tool, target and outcome, already redacted and passed through the instruction filter when the note was written (R29), at most five.
- **Delivery**: a Run note's failure is a line in the run's Memory section and `run-notes.md`: "worker test gate: `<command>` exited N; failure signature <sig>; files the run changed: …".
- **Resume brief** (`src/core/brief.js`): "Failed before:" names the last two failures from the ticket's Run notes (run id, status, exit code, signature, command, up to three changed files), never a note marked `origin: 'page'`.
- **Dismissal reason**: `dismiss-suggestion` takes an optional `reason` (a string of at most 280 characters after trimming; longer is `request-invalid`); `quill agent dismiss <run> <id> --reason text` sends it. The reason is kept on that run's Run note as `dismissals: [{ suggestion_id, type, reason, at, by }]`, not on the suggestion (suggestions reach exports and vault notes). Delivery shows only the owner's (`by` owner or cli) as "the owner dismissed its <type> suggestion: <reason>", with instruction-like text withheld.

### Privacy

All new fields are local: anchors live in memory (never in a snapshot, export, mirror, publisher payload or vault note, ADR 0027); `failure` and `dismissals` live on `run_notes`, which exports, the mirror and vault notes already drop. Nothing is added to any export allow-list. `tests/export/memory-sentinel.test.js` covers anchors, the staled anchor, the failure record (signature, command, files) and the dismissal reason.

## Consequences

- An entry about code that was rewritten stops reaching runs, and the owner sees why; a run that checks it again brings it back at the new version.
- A run that hits a failure an earlier run hit is told what that run tried, without seeing the earlier run's output.
- The owner's reason for rejecting a suggestion reaches the ticket's later runs as the owner's word.
- Reducer output is unchanged for every event journaled before this ADR, with one edge case: a `pinned` or `approved` op on an entry that was filed with `state: 'stale'` (the worker never files one) now revives it.

## Residual risks

- **The symbol heuristic is text, not a parse.** A comment or string containing `function x` can be taken for a declaration; a rename the heuristic misses gives a ratio from the window alone. The ratio threshold, not the symbol, decides most verdicts.
- **The ratio is a proxy.** A one-line semantic change inside a large unchanged region stays below the threshold and gets only the re-check suffix, as before this ADR.
- **The worker checks HEAD of the registered checkout.** A feature branch checked out there stales entries against that branch; a run that confirms them revives them.
- **Attempt summaries are agent text.** They are filtered and fenced as data, as every Run note delivered since ADR 0027; the guard still decides every call.

## Alternatives considered

- **Whole-file blob comparison.** Rejected: any edit anywhere in a file would stale every learning about it.
- **A windowed comparison at the relocated anchor.** Rejected: inserting a function just above the anchored one shifted the window and staled it.
- **Journaling `staled` at dispatch too.** Rejected: a run's base commit may be a ticket branch; the worker's HEAD check is the one durable verdict, and dispatch only leaves the entry out.
- **Storing the test output tail on the note for later runs.** Rejected by ADR 0027's tool-output rule.
- **New event kinds (`MEMORY_ANCHORED`, `MEMORY_STALED`, `FAILURE_RECORDED`).** Rejected by the plan: an op on `memory-tx` and fields on the Run note carry the same facts without new ingress or worker-only kinds.
