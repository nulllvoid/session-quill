# ADR 0037 — Planned files and drift

Date: 2026-10-21 · Status: accepted · Builds on [ADR 0005](0005-gate-modes-and-auto-binding.md), [ADR 0017](0017-run-access-levels.md) and [ADR 0026](0026-autonomous-access-and-guard.md) · Distinct from [ADR 0004](0004-plan-path-first-claim.md) · PRD FR-3.1, gap analysis `docs/research/2.0.0/01-gap-analysis.md`

## Context

FR-3.1 asks Quill to notice when work strays from what was planned. Nothing in Quill names the files a piece of work expects to change. ADR 0004 is about something else: the one plan file a plan-mode session may write before it is bound. Its "plan path" and `isPlanFileWrite` code are not reused here.

There are two places a list of expected files can come from. An interactive session approves a plan with `ExitPlanMode`, and the hook already stores that plan as a blob. A run is unattended, so its owner can give the list when queuing it. In both places the list is a guess made before the work starts. A write outside it may be the right call. So the signal must not refuse anything, pause a run or widen what the 1.1 guard decides (Review Focus 5).

## Decision

1. **Planned files.** These are repo-relative paths or globs (`src/core/**`, `README.md`), at most 50, each at most 200 characters. An entry is rejected when it is absolute, drive- or home-relative, a URL, contains a colon or a `..` segment, has control characters, has no letter or digit, or holds more than 4 wildcards (`*`, `**` and `?` count one each; a run of three or more `*` is first collapsed to `**`). `src/core/planned-paths.js` holds the rules and has no Quill imports, so the hook, the reducer and the guard share one definition:
   - `extractPlannedPaths(text)` takes path-like tokens from the plan text: code spans, link targets and bare words. A token counts as a path if it has a directory part, or a name of two or more characters plus an extension with a letter in it. URLs, absolute paths, flags and version numbers are ignored.
   - `matchesPlanned(path, globs)` matching:
     - An entry with a `/` is anchored at the repository root and covers everything below it.
     - An entry without a `/` matches a file or directory name at any depth, as in .gitignore.
     - `*` and `?` stay within one directory level; `**` crosses levels.
     - Case is ignored, so the check errs towards fewer flags.
     - The matcher is a linear dynamic programme over the path (glob length × path length), not a regular expression. Plan text is agent output and the match runs on every captured write: in the reducer on every replay, in the hook and in the run guard. A backtracking regular expression built from a glob such as `src/*a*a*a*a*a*a*a*b` took seconds per write, and a journaled event would have stalled every replay.

2. **Interactive sessions.**
   - On an approved `ExitPlanMode` (a rejected plan is never stored), the PostToolUse hook adds `planned_paths` to the `post-tool` payload.
   - The reducer normalizes that list again (ingress is untrusted) and sets the session's `planned_paths`. Each new plan replaces the previous list and resets `drift`.
   - A later `post-tool` write whose repo-relative `write_paths` fall outside the list adds to `session.drift { count, last_path, at }`.
   - A write path that is absolute lies outside the session's directory (plan files, memory notes). It is not the project's work and never counts.
   - Drift never changes attribution, `files_touched` or status evidence.
   - The worker publishes `drift_count` in the binding snapshot. The status line appends ` ⚠ drift N` and `quill status` prints a "Plan drift" line.

3. **One nudge per session, nudge mode only.** In nudge mode, the hook also keeps the latest plan's files in a small state marker (`state/drift/<session>.json`). It checks writes against that marker, so it never waits for the worker. At the first Stop after a write outside the plan, it blocks once with "You changed <path> outside your plan. Update the plan or carry on."
   - This is the existing once-per-session Stop pattern from `src/hooks/nudge.js`. Writes themselves are never denied or delayed, so ADR 0005's "nudge never blocks a write" holds.
   - The unlinked-work nudge takes precedence. A drift nudge already given is not re-armed by a new plan.
   - It never fires in strict or off mode, in a run (`QUILL_HANDOFF_*`), or while `stop_hook_active` is set.

4. **Runs.**
   - The CLI takes `quill agent run|handoff --planned <glob>…` (repeat the flag or use commas). The request carries the list as `planned_paths`. The CLI validates it, and the worker validates it again when the request applies:
     - an invalid entry fails with `planned-invalid`;
     - standard or settings access fails with `planned-needs-guard`;
     - a run without `edit_source` fails with `permission-dependency`.
   - Only a run guard (autonomous, or full access in observe mode) sees each write, so other access levels cannot be measured and are refused rather than reported as zero.
   - The handoff record keeps `planned_paths`, and resume carries it over. Dispatch freezes the list into the hashed grant as `plannedPaths`.
   - After `decide()` allows a call, `bin/quill-guard.js` adds `drift: true` to that call's ledger line when the call is an `Edit`, `Write`, `MultiEdit` or `NotebookEdit` landing inside the checkout but outside `plannedPaths`. A write outside the checkout is the writable roots' business, not drift.
   - The mark is computed after the decision and never fed back into it. A failure while computing it only leaves the mark off.
   - When the run finishes, in any state, the worker counts the allowed `drift: true` lines once per `tool_use_id` into `run.scope_drift`. A full-access run that ran unobserved records no count.
   - `src/core/planned-paths.js` is added to `GUARD_CODE`, because the guard and `permissions.js` load it.

5. **Display and privacy.**
   - Run detail shows an amber chip "N writes outside planned files", whose title says the writes were recorded, not blocked. The owner's dashboard also lists the planned files under Changes.
   - Exports carry `scope_drift` as a whole number only. `planned_paths`, session `planned_paths` and `drift` stay local: they are not in the export allow-lists, and they are removed from vault session notes, which otherwise spread the session record.

## Consequences

- A plan's prose can produce false positives (`github.com`, `and/or`). They only widen the planned list, so they mean fewer drift flags, never a refusal. A plan that names more than 50 files keeps the first 50, so later files can count as drift.
- A plan or `--planned` entry with more than 4 wildcards is dropped (from a plan) or refused as `planned-invalid` (from the CLI). Dropping one only shrinks the list, so it can mean more drift flags, never a refusal.
- Shell writes (`sed -i`, redirects) are not measured, in sessions or in runs. Only the file write tools name their targets reliably without parsing commands.
- Strict mode, the default, gets the status line count but no Stop nudge.
- The Needs you grouping by drift belongs to Task 11 (ADR 0039).

## Not done

- Enforced (denying) planned files: deferred in the 2.0.0 plan. Planned files only flag.
- A dashboard Run agent dialog field for planned files: the CLI is the only entry point.
- Drift for standard and settings runs, which have no guard to see each write.
